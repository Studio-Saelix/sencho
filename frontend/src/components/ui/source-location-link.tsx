import { FileCode } from 'lucide-react';

import { cn } from '@/lib/utils';
import { useIsMobile } from '@/hooks/use-is-mobile';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { isFileHash, isUsableAuthoredLocation, type AuthoredLocation } from '@/lib/authoredLocation';

/**
 * The one rendering of an authored location. A quiet in-row navigation verb on
 * desktop, plain text below `md` where the phone stack detail has no Monaco
 * editor and no Files tab. A location without a verifiable content revision is
 * shown as plain text too: it must not look like a control that opens nothing.
 */
export function SourceLocationLink({
  location,
  onOpen,
  className,
}: {
  location: AuthoredLocation;
  onOpen: (location: AuthoredLocation) => void;
  className?: string;
}) {
  const isMobile = useIsMobile();
  const label = `${location.file}:${location.line}`;
  const accessibleName = `Open ${location.file} at line ${location.line}`;
  const opensLocation = !isMobile
    && isUsableAuthoredLocation(location)
    && isFileHash(location.fileHash);

  if (!opensLocation) {
    return (
      <span
        className={cn('inline-flex items-center gap-1 font-mono text-[10px] text-stat-subtitle', className)}
        data-testid="source-location-text"
      >
        <FileCode className="h-2.5 w-2.5 shrink-0" strokeWidth={1.5} />
        {label}
      </span>
    );
  }

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label={accessibleName}
            data-testid="source-location-link"
            onClick={() => onOpen(location)}
            className={cn(
              'inline-flex items-center gap-1 rounded font-mono text-[10px] text-stat-subtitle underline-offset-2',
              'hover:text-brand hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-brand/50',
              className,
            )}
          >
            <FileCode className="h-2.5 w-2.5 shrink-0" strokeWidth={1.5} />
            {label}
          </button>
        </TooltipTrigger>
        <TooltipContent>
          <span>{accessibleName}</span>
          {location.path ? <span className="block font-mono text-[10px] opacity-80">{location.path}</span> : null}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
