import { useEffect } from 'react';
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

  useEffect(() => {
    if (open) markSeen();
  }, [open, markSeen]);

  const entries = [...whatsNewEntries].reverse();

  return (
    // xl (max-w-xl w-[95vw]), not the lg default (max-w-lg): cards carry
    // screenshots and need more width than the default confirm-dialog size.
    <Modal open={open} onOpenChange={onOpenChange} size="xl">
      <ModalHeader kicker="Sencho" title="What's New" />
      <ModalBody fill className="space-y-6">
        {entries.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing new to show yet.</p>
        ) : (
          entries.map((entry) => (
            <div key={entry.id} className="space-y-2 border-b border-card-border/40 pb-6 last:border-b-0 last:pb-0">
              <h3 className="text-sm font-medium text-stat-value">{entry.title}</h3>
              <p className="text-sm leading-relaxed text-stat-subtitle">{entry.blurb}</p>
              {entry.screenshot && (
                <img
                  src={`/whats-new/${entry.screenshot}`}
                  alt={entry.title}
                  className="rounded-md border border-card-border/60"
                  loading="lazy"
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
          <Button variant="ghost" size="sm" onClick={() => setEnabled(false)}>
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
