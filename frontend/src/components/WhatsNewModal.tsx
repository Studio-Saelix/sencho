import { useEffect, useState } from 'react';
import { ExternalLink } from 'lucide-react';
import { Modal, ModalHeader, ModalBody, ModalFooter } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { whatsNewEntries } from '@/whats-new/entries';
import { useWhatsNewPreference } from '@/hooks/useWhatsNewPreference';

interface WhatsNewModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onViewChangelog: () => void;
}

// font-sans/normal-case/tracking-normal reset ModalFooter's inherited kicker styling (font-mono uppercase tracking-[0.22em]) so the footer link reads as a link, not a label.
const linkClassName = 'inline-flex items-center gap-1 text-xs text-brand hover:underline font-sans normal-case tracking-normal';

export function WhatsNewModal({ open, onOpenChange, onViewChangelog }: WhatsNewModalProps) {
  const { markSeen, setEnabled } = useWhatsNewPreference();
  // Screenshots are authored by hand alongside the entry, so a typo'd or
  // not-yet-added filename is a realistic mistake. Drop the image instead of
  // leaving the browser's broken-image placeholder in the card.
  const [failedScreenshots, setFailedScreenshots] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (open) markSeen();
  }, [open, markSeen]);

  const entries = [...whatsNewEntries].reverse();

  return (
    // xl (max-w-xl w-[95vw]), not the md default (max-w-md): cards carry
    // screenshots and need more width than the default confirm-dialog size.
    // className bounds the dialog to 85dvh and makes it a flex column so
    // ModalBody's `fill` (flex-1 min-h-0) can actually constrain the body to
    // scroll while the header and footer stay pinned, matching the pattern
    // ConfirmModal uses (flex max-h-[85dvh] flex-col).
    <Modal open={open} onOpenChange={onOpenChange} size="xl" className="max-h-[85dvh] flex flex-col">
      <ModalHeader kicker="Sencho" title="What's New" />
      <ModalBody fill className="space-y-6">
        {entries.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing new to show yet.</p>
        ) : (
          entries.map((entry) => (
            <div key={entry.id} className="space-y-2 border-b border-card-border/40 pb-6 last:border-b-0 last:pb-0">
              <h3 className="text-sm font-medium text-stat-value">{entry.title}</h3>
              <p className="text-sm leading-relaxed text-stat-subtitle">{entry.blurb}</p>
              {entry.screenshot && !failedScreenshots.has(entry.id) && (
                <img
                  src={`/whats-new/${entry.screenshot}`}
                  alt={entry.title}
                  className="rounded-md border border-card-border/60"
                  loading="lazy"
                  onError={() => setFailedScreenshots((prev) => new Set(prev).add(entry.id))}
                />
              )}
              {entry.docUrl && (
                <a href={entry.docUrl} target="_blank" rel="noopener noreferrer" className={linkClassName}>
                  Learn more <ExternalLink className="w-3 h-3" strokeWidth={1.5} />
                </a>
              )}
            </div>
          ))
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
