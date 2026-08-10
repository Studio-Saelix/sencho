import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { ExternalLink, X } from 'lucide-react';
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

// whatsNewEntries is authored oldest-first; the modal shows newest first.
const entries = [...whatsNewEntries].reverse();

export function WhatsNewModal({ open, onOpenChange, onViewChangelog }: WhatsNewModalProps) {
  const { markSeen, setEnabled } = useWhatsNewPreference();
  // Screenshots are authored by hand alongside the entry, so a typo'd or
  // not-yet-added filename is a realistic mistake. Drop the image instead of
  // leaving the browser's broken-image placeholder in the card.
  const [failedScreenshots, setFailedScreenshots] = useState<Set<string>>(new Set());
  const [zoomedSrc, setZoomedSrc] = useState<string | null>(null);
  const closeZoom = useCallback(() => setZoomedSrc(null), []);

  useEffect(() => {
    if (open) markSeen();
  }, [open, markSeen]);

  // WhatsNewModal stays mounted for the app's lifetime (EditorLayout renders it
  // with a controlled `open`), so without this reset a lightbox left open at
  // close time would resurface on the next open.
  useEffect(() => {
    if (!open) closeZoom();
  }, [open, closeZoom]);

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
                <button
                  type="button"
                  onClick={() => setZoomedSrc(`/whats-new/${entry.screenshot}`)}
                  aria-label={`Zoom in on ${entry.title} screenshot`}
                  className="block w-full cursor-zoom-in overflow-hidden rounded-md border border-card-border/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <img
                    src={`/whats-new/${entry.screenshot}`}
                    alt={entry.title}
                    loading="lazy"
                    onError={() => setFailedScreenshots((prev) => new Set(prev).add(entry.id))}
                  />
                </button>
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
      {zoomedSrc && <ScreenshotLightbox src={zoomedSrc} onClose={closeZoom} />}
    </Modal>
  );
}

interface ScreenshotLightboxProps {
  src: string;
  onClose: () => void;
}

function ScreenshotLightbox({ src, onClose }: ScreenshotLightboxProps) {
  useEffect(() => {
    // Capture phase, ahead of Radix's own document-level capture listener for
    // the parent Dialog's Escape handling: stopping propagation here is what
    // keeps Escape from also dismissing the whole modal while zoomed.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Zoomed screenshot"
      onClick={onClose}
      // Radix sets an inline pointer-events: none on <body> while the parent
      // Dialog is open (to keep interaction scoped to its own content); this
      // portal renders as a body child too, so it needs an explicit inline
      // override (a Tailwind class here would be inert: nothing overrides an
      // ancestor's inline style except another inline style).
      style={{ pointerEvents: 'auto' }}
      className="fixed inset-0 z-[60] flex cursor-zoom-out items-center justify-center bg-[var(--scrim)] p-8 backdrop-blur-sm"
    >
      <img src={src} alt="" className="max-h-full max-w-full rounded-md object-contain" />
      <button
        type="button"
        onClick={onClose}
        aria-label="Close zoomed screenshot"
        className="absolute right-4 top-4 inline-flex h-9 w-9 items-center justify-center rounded-lg bg-popover/80 text-popover-foreground hover:bg-popover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <X className="h-4 w-4" strokeWidth={1.5} />
      </button>
    </div>,
    document.body,
  );
}
