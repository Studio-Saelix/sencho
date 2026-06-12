import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/lib/api';
import { toast } from '@/components/ui/toast-store';
import type { ScanSummary, ScannerKind } from '@/types/security';

interface UseImageScanOptions {
  /** Called with the finished scan's id (e.g. to open the detail sheet). */
  onComplete: (scanId: number) => void;
  /** Called with the refreshed image-summaries map after a scan completes. */
  onSummaries: (summaries: Record<string, ScanSummary>) => void;
}

/**
 * Triggers a Trivy scan for an image and polls until it finishes, then refreshes
 * the image-summaries and reports the completed scan id. A new scan supersedes
 * any in-flight poll, and the poll is abandoned (server-side scan keeps running)
 * on unmount. Mirrors the Resources image-scan flow so the Security Images tab
 * can scan without re-implementing it.
 */
export function useImageScan({ onComplete, onSummaries }: UseImageScanOptions) {
  const [scanningRef, setScanningRef] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => () => abortRef.current?.abort(), []);

  const scanImage = useCallback(
    async (imageRef: string, scanners: ScannerKind[]) => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      const { signal } = controller;
      setScanningRef(imageRef);
      const loadingId = toast.loading(`Scanning ${imageRef}...`);
      try {
        const res = await apiFetch('/security/scan', {
          method: 'POST',
          body: JSON.stringify({ imageRef, force: true, scanners }),
          signal,
        });
        // Check the HTTP status before parsing: a non-JSON error body (e.g. a
        // proxy 502) would otherwise surface a confusing parse error instead of
        // the real failure.
        if (!res.ok) {
          const err = await res.json().catch(() => null);
          throw new Error(err?.error || `Failed to start scan (HTTP ${res.status})`);
        }
        const data = (await res.json()) as { scanId: number };
        const scanId = data.scanId;

        const deadline = Date.now() + 5 * 60 * 1000;
        while (Date.now() < deadline) {
          await new Promise<void>((resolve) => {
            if (signal.aborted) { resolve(); return; }
            const timer = setTimeout(resolve, 3000);
            signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
          });
          if (signal.aborted) return;
          const poll = await apiFetch(`/security/scans/${scanId}`, { signal });
          if (signal.aborted) return;
          if (!poll.ok) {
            // A transient non-OK poll is retried, but a hard error (gone/auth)
            // would otherwise masquerade as a 5-minute "timed out".
            console.warn('[Security] scan status poll failed:', poll.status);
            if (poll.status === 404 || poll.status === 401) {
              throw new Error(`Scan status unavailable (HTTP ${poll.status})`);
            }
            continue;
          }
          const pollData = await poll.json();
          if (signal.aborted) return;
          if (pollData.status !== 'in_progress') {
            if (pollData.status === 'failed') throw new Error(pollData.error || 'Scan failed');
            toast.success(`Scan complete: ${pollData.total_vulnerabilities} vulnerabilities found`);
            onComplete(scanId);
            const summariesRes = await apiFetch('/security/image-summaries', { signal });
            if (signal.aborted) return;
            if (summariesRes.ok) {
              const summaries = await summariesRes.json();
              if (signal.aborted) return;
              onSummaries(summaries ?? {});
            }
            return;
          }
        }
        throw new Error('Scan timed out');
      } catch (error) {
        if (signal.aborted) {
          // A deliberately cancelled poll is not an error, but keep a breadcrumb
          // so a real failure racing the abort is not lost.
          console.debug('Scan poll aborted', error);
          return;
        }
        toast.error((error as Error)?.message || 'Scan failed');
      } finally {
        toast.dismiss(loadingId);
        // Only the owning poll clears the shared state; a superseded poll leaves
        // it to the scan that replaced it.
        if (abortRef.current === controller) {
          abortRef.current = null;
          setScanningRef(null);
        }
      }
    },
    [onComplete, onSummaries],
  );

  return { scanningRef, scanImage };
}
