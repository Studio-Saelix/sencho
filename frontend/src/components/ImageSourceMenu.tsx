import { useEffect, useRef, useState } from 'react';
import { Link2, ExternalLink, Copy, Check } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './ui/dropdown-menu';
import { apiFetch } from '@/lib/api';
import { copyToClipboard } from '@/lib/clipboard';
import { toast } from '@/components/ui/toast-store';
import { cn } from '@/lib/utils';
import { buildImageLinks, extractImageSourceMeta } from '@/lib/imageLinks';

interface ImageSourceMenuProps {
  /** Full image reference, e.g. 'ghcr.io/owner/app:1.2'. Absent/empty renders nothing. */
  imageRef?: string | null;
  /** Resolved image id (sha256). When set, OCI source labels are fetched lazily. */
  imageId?: string;
  /** Sizing classes for the trigger button so each surface matches its row. */
  className?: string;
}

type LabelState = 'idle' | 'loading' | 'loaded' | 'error';

// A focused quick-action for an image: the deterministic registry page, a copy
// action, and (when an image id is available) the image's OCI source/docs/revision
// links read lazily from a local inspect. It complements the Resources image
// deep-dive sheet rather than duplicating it.
export function ImageSourceMenu({ imageRef, imageId, className = 'h-4 w-4' }: ImageSourceMenuProps) {
  const [open, setOpen] = useState(false);
  const [labels, setLabels] = useState<Record<string, string> | null>(null);
  const [labelState, setLabelState] = useState<LabelState>('idle');
  const [copied, setCopied] = useState(false);
  // Monotonic id so a response from a superseded image (node switch) or an
  // unmounted menu is ignored instead of writing stale labels.
  const requestRef = useRef(0);
  const [trackedId, setTrackedId] = useState(imageId);

  // A new image id means a different (or node-switched) image: reset so the next
  // open re-fetches against the active node. Adjusting state during render is the
  // supported way to react to a changed prop without an extra render pass.
  if (trackedId !== imageId) {
    setTrackedId(imageId);
    setLabelState('idle');
    setLabels(null);
  }

  // Invalidate any in-flight fetch when the image id changes or the menu unmounts,
  // so a late response from a superseded image cannot write stale labels.
  useEffect(() => () => { requestRef.current += 1; }, [imageId]);

  const loadLabels = (id: string) => {
    const reqId = (requestRef.current += 1);
    setLabelState('loading');
    apiFetch(`/system/images/${encodeURIComponent(id)}`)
      .then(async (res) => {
        if (!res.ok) throw new Error('inspect failed');
        return res.json() as Promise<{ inspect?: { Config?: { Labels?: Record<string, string> | null } } }>;
      })
      .then((data) => {
        if (requestRef.current !== reqId) return;
        setLabels(data?.inspect?.Config?.Labels ?? null);
        setLabelState('loaded');
      })
      .catch(() => {
        if (requestRef.current === reqId) setLabelState('error');
      });
  };

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (next && imageId && labelState === 'idle') loadLabels(imageId);
  };

  const trimmedRef = imageRef?.trim();
  if (!trimmedRef) return null;
  const links = buildImageLinks(trimmedRef);
  if (!links) return null;

  const meta = extractImageSourceMeta(labels);

  const handleCopy = async () => {
    try {
      await copyToClipboard(trimmedRef);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
      toast.success('Image reference copied');
    } catch {
      toast.error('Copy failed.');
    }
  };

  return (
    <DropdownMenu open={open} onOpenChange={handleOpenChange}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="Image source links"
          title="Image source links"
          className={cn(
            'inline-flex items-center justify-center rounded text-stat-subtitle hover:text-foreground hover:bg-muted/60 transition-colors',
            className,
          )}
        >
          <Link2 className="h-3.5 w-3.5" strokeWidth={1.5} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuLabel className="font-mono text-[11px] font-normal text-stat-subtitle truncate">
          {trimmedRef}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />

        {links.registryUrl ? (
          <DropdownMenuItem asChild>
            <a href={links.registryUrl} target="_blank" rel="noopener noreferrer">
              <ExternalLink className="h-3.5 w-3.5 mr-2" strokeWidth={1.5} />
              Open on {links.registryLabel}
            </a>
          </DropdownMenuItem>
        ) : (
          <DropdownMenuItem disabled>
            <span className="truncate">Registry · {links.registryHost}</span>
          </DropdownMenuItem>
        )}

        <DropdownMenuItem onSelect={(e) => { e.preventDefault(); void handleCopy(); }}>
          {copied ? (
            <Check className="h-3.5 w-3.5 mr-2" strokeWidth={2} />
          ) : (
            <Copy className="h-3.5 w-3.5 mr-2" strokeWidth={1.5} />
          )}
          Copy image reference
        </DropdownMenuItem>

        {imageId && (labelState === 'loading' || meta.links.length > 0 || meta.version || meta.revision) && (
          <>
            <DropdownMenuSeparator />
            {labelState === 'loading' ? (
              <DropdownMenuItem disabled>Loading source…</DropdownMenuItem>
            ) : (
              <>
                {meta.links.map((link) => (
                  <DropdownMenuItem key={link.id} asChild>
                    <a href={link.url} target="_blank" rel="noopener noreferrer">
                      <ExternalLink className="h-3.5 w-3.5 mr-2" strokeWidth={1.5} />
                      {link.label}
                    </a>
                  </DropdownMenuItem>
                ))}
                {meta.revision && (
                  <DropdownMenuItem disabled>
                    <span className="font-mono truncate">Revision · {meta.revision}</span>
                  </DropdownMenuItem>
                )}
                {meta.version && (
                  <DropdownMenuItem disabled>
                    <span className="font-mono truncate">Version · {meta.version}</span>
                  </DropdownMenuItem>
                )}
              </>
            )}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
