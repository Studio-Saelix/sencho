import { useEffect, useState } from 'react';
import { ExternalLink } from 'lucide-react';
import { Modal, ModalHeader, ModalBody, ModalFooter } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { MarkdownContent } from '@/components/ui/MarkdownContent';
import { apiFetch } from '@/lib/api';
import { extractHighlights } from '@/lib/releaseHighlights';
import { formatVersion } from '@/lib/version';
import { useWhatsNewPreference } from '@/hooks/useWhatsNewPreference';

interface WhatsNewModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onViewChangelog: () => void;
}

type ReleaseNotesResult =
  | { version: string; failed: false; highlights: string | null; htmlUrl: string | null }
  | { version: string; failed: true };

// font-sans/normal-case/tracking-normal reset ModalFooter's inherited kicker styling (font-mono uppercase tracking-[0.22em]) so the footer link reads as a link, not a label.
const linkClassName = 'inline-flex items-center gap-1 text-xs text-brand hover:underline font-sans normal-case tracking-normal';

export function WhatsNewModal({ open, onOpenChange, onViewChangelog }: WhatsNewModalProps) {
  const { version, markSeen, setEnabled } = useWhatsNewPreference();
  // The last lookup, keyed by the version it answered. Anything that does not
  // match the running version reads as loading, so reopening after a successful
  // load shows the cached notes and a failed load is retried on the next open.
  const [result, setResult] = useState<ReleaseNotesResult | null>(null);

  useEffect(() => {
    if (open) markSeen();
  }, [open, markSeen]);

  const needsFetch = open && version !== null && !(result?.version === version && !result.failed);
  useEffect(() => {
    if (!needsFetch || version === null) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch(`/fleet/update-status/release-notes?version=${encodeURIComponent(version)}`, {
          localOnly: true,
        });
        if (!res.ok) throw new Error(`Release notes request failed (${res.status})`);
        const data = (await res.json()) as { releaseNotes: string | null; htmlUrl: string | null };
        if (!cancelled) {
          setResult({ version, failed: false, highlights: extractHighlights(data.releaseNotes), htmlUrl: data.htmlUrl });
        }
      } catch (error) {
        console.error('[WhatsNew] Failed to load release notes:', error);
        if (!cancelled) setResult({ version, failed: true });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [needsFetch, version]);

  const current = result && result.version === version ? result : null;

  return (
    <Modal open={open} onOpenChange={onOpenChange} className="max-h-[85dvh] flex flex-col">
      <ModalHeader kicker="Sencho" title="What's New" />
      <ModalBody fill className="space-y-4">
        {version && (
          <div className="text-[10px] font-mono uppercase tracking-[0.18em] text-stat-subtitle">
            Release {formatVersion(version)}
          </div>
        )}
        {current === null ? (
          <div className="space-y-2" aria-busy="true">
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-3 w-11/12" />
            <Skeleton className="h-3 w-4/5" />
          </div>
        ) : current.failed ? (
          <p className="text-sm text-muted-foreground">
            The release notes could not be loaded. They are fetched from GitHub when this opens, so check that this
            instance can reach it, then open this again.
          </p>
        ) : current.highlights ? (
          <>
            <MarkdownContent>{current.highlights}</MarkdownContent>
            {current.htmlUrl && (
              <a href={current.htmlUrl} target="_blank" rel="noopener noreferrer" className={linkClassName}>
                View on GitHub <ExternalLink className="w-3 h-3" strokeWidth={1.5} />
              </a>
            )}
          </>
        ) : (
          <p className="text-sm text-muted-foreground">
            This release has no highlights. The full list of changes is in the changelog.
          </p>
        )}
      </ModalBody>
      <ModalFooter
        hint={
          <button type="button" onClick={onViewChangelog} className={linkClassName}>
            View full changelog
          </button>
        }
        secondary={
          // Turning the feature off also removes the nav icon, so leaving the
          // modal open would strand the user in a surface they just dismissed.
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setEnabled(false);
              onOpenChange(false);
            }}
          >
            Never show again
          </Button>
        }
        primary={
          <Button size="sm" onClick={() => onOpenChange(false)}>
            Got it
          </Button>
        }
      />
    </Modal>
  );
}
