import type { ReactNode } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { DIGEST_REBUILD_HINT } from '@/lib/updatePreviewActionability';
import { cn } from '@/lib/utils';

interface DigestRebuildHintProps {
  children: ReactNode;
  className?: string;
}

/**
 * Focusable control that surfaces DIGEST_REBUILD_HINT on click/tap and keyboard.
 * Replaces hover-only title= spans so mobile and keyboard users can read the hint.
 */
export function DigestRebuildHint({ children, className }: DigestRebuildHintProps) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            'inline cursor-help text-left rounded-sm',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1',
            className,
          )}
          data-testid="digest-rebuild-hint"
        >
          {children}
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="bottom"
        align="start"
        className="p-3 font-mono text-xs leading-relaxed text-popover-foreground"
        data-testid="digest-rebuild-hint-content"
      >
        {DIGEST_REBUILD_HINT}
      </PopoverContent>
    </Popover>
  );
}
