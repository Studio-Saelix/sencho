import { useCallback, useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { toast } from '@/components/ui/toast-store';
import { BusyButton } from '@/components/ui/busy-button';
import { apiFetch } from '@/lib/api';
import { useAuth } from '@/context/AuthContext';
import { scanBannerFingerprint, useStackDismiss } from '@/hooks/useStackDismiss';

type ScanOutcome = 'ok' | 'partial' | 'failed' | 'skipped';

type StackScanStatus =
  | { status: null; scanning?: boolean }
  | { status: ScanOutcome; attemptedAt: number; errorMessage: string | null; scanning?: boolean };

const POLL_MS = 2000;
// A scan walks every image of the stack; stop watching well after any normal one.
const MAX_POLLS = 150;

const HEADLINE: Record<Exclude<ScanOutcome, 'ok'>, string> = {
  failed: 'Last post-deploy scan failed.',
  partial: 'Last post-deploy scan partially failed.',
  skipped: 'Post-deploy scan did not run.',
};

interface ScanStatusBannerProps {
  stackName: string;
  nodeId: number | undefined;
}

/**
 * The amber strip that says the last post-deploy scan did not finish cleanly.
 * Rescan runs the same scan again on the node that owns the stack and the strip
 * follows it to the new result; Dismiss hides this result until a scan changes
 * it. Rescan is offered only to an account that can deploy the stack, the same
 * authority as the deploys that start this scan.
 */
export function ScanStatusBanner({ stackName, nodeId }: ScanStatusBannerProps) {
  const { can } = useAuth();
  const canRescan = can('stack:deploy', 'stack', stackName, nodeId);
  const [scan, setScan] = useState<StackScanStatus | null>(null);
  const [starting, setStarting] = useState(false);
  // Set by a Rescan click so the end of that scan, and not of a deploy's, is announced.
  const rescanRequested = useRef(false);
  const wasScanning = useRef(false);

  const attemptedAt = scan?.status ? scan.attemptedAt : undefined;
  const { dismissed, dismiss } = useStackDismiss(
    'scanBanner', stackName, nodeId, scanBannerFingerprint(scan?.status, attemptedAt),
  );

  const load = useCallback(async (isCurrent: () => boolean = () => true) => {
    try {
      const res = await apiFetch(`/stacks/${stackName}/scan-status`);
      const body = res.ok ? await res.json() as StackScanStatus : null;
      if (isCurrent()) setScan(body);
    } catch (err) {
      console.error('[ScanStatusBanner] scan-status read failed:', err);
      if (isCurrent()) setScan(null);
    }
  }, [stackName]);

  useEffect(() => {
    let current = true;
    void load(() => current);
    return () => { current = false; };
  }, [load, nodeId]);

  const scanning = scan?.scanning === true;
  useEffect(() => {
    if (!scanning) return undefined;
    let current = true;
    let polls = 0;
    const timer = setInterval(() => {
      polls += 1;
      if (polls > MAX_POLLS) {
        clearInterval(timer);
        toast.info('The scan is still running. Reopen this stack to see its result.');
        return;
      }
      void load(() => current);
    }, POLL_MS);
    return () => { current = false; clearInterval(timer); };
  }, [scanning, load]);

  // The scan this strip was following has ended. An ok result removes the strip,
  // so announce it here or Rescan gets no answer; other results stay in the strip.
  useEffect(() => {
    if (wasScanning.current && !scanning && rescanRequested.current) {
      rescanRequested.current = false;
      if (scan?.status === 'ok') toast.success('Rescan finished. The scan completed cleanly.');
    }
    wasScanning.current = scanning;
  }, [scanning, scan?.status]);

  const rescan = async () => {
    setStarting(true);
    try {
      const res = await apiFetch(`/stacks/${stackName}/scan-status/rescan`, { method: 'POST' });
      if (!res.ok) {
        const body = await res.json().catch(() => null) as { error?: string } | null;
        toast.error(body?.error ?? 'Could not start the rescan.');
        return;
      }
      const started = await res.json().catch(() => null) as { started?: boolean } | null;
      // A scan that was already running (a deploy's) is followed but not announced as this click's.
      if (started?.started === true) rescanRequested.current = true;
      setScan((prev) => (prev ? { ...prev, scanning: true } : prev));
    } catch (err) {
      console.error('[ScanStatusBanner] rescan failed:', err);
      toast.error('Could not start the rescan.');
    } finally {
      setStarting(false);
    }
  };

  if (!scan || !scan.status || scan.status === 'ok' || dismissed) return null;

  return (
    <div
      className="mx-3 my-2 flex items-start gap-2 rounded-md border border-warning/40 bg-warning/[0.06] px-2 py-1.5 text-xs text-warning"
      role="status"
      title={scan.errorMessage ?? undefined}
    >
      <span className="font-mono text-[9px] uppercase tracking-wide shrink-0 mt-0.5">scan</span>
      <span className="flex-1">
        {HEADLINE[scan.status]}
        {scan.errorMessage ? ` ${scan.errorMessage}` : ''}
      </span>
      {canRescan && (
        <BusyButton
          variant="ghost"
          size="sm"
          pending={starting || scanning}
          busyLabel="Scanning"
          data-testid="scan-rescan"
          className="h-6 shrink-0 px-2 text-xs text-warning hover:text-warning max-md:min-h-11"
          onClick={() => void rescan()}
        >
          Rescan
        </BusyButton>
      )}
      <button
        type="button"
        className="shrink-0 ml-2 p-0.5 rounded hover:bg-warning/10 transition-colors"
        onClick={dismiss}
        aria-label="Dismiss"
      >
        <X className="h-3.5 w-3.5" strokeWidth={1.5} />
      </button>
    </div>
  );
}
