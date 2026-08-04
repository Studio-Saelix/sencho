import { Sparkles } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './ui/tooltip';
import { useWhatsNewPreference } from '@/hooks/useWhatsNewPreference';
import { whatsNewEntries } from '@/whats-new/entries';
import { cn } from '@/lib/utils';

interface WhatsNewTriggerProps {
  onClick: () => void;
}

export function WhatsNewTrigger({ onClick }: WhatsNewTriggerProps) {
  const { enabled, hasUnseen } = useWhatsNewPreference();

  // Turning the feature off removes the affordance entirely, which is what
  // "Never show again" means everywhere else. Settings > About is the way back.
  if (!enabled) return null;

  // With nothing authored yet there is nothing to announce, so the icon stays
  // out of the top bar rather than offering an empty modal. The modal keeps its
  // own empty state as a fallback for entries that fail validation at runtime.
  if (whatsNewEntries.length === 0) return null;

  return (
    <TooltipProvider delayDuration={300} disableHoverableContent>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={onClick}
            aria-label="What's new"
            // Matches the sibling search trigger in the same TopBar cluster.
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-foreground/80 transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          >
            <Sparkles
              className={cn('h-4 w-4', hasUnseen && 'animate-whats-new-breathe')}
              strokeWidth={1.5}
            />
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom">What's new</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
