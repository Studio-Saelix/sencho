import { Sparkles } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './ui/tooltip';
import { useWhatsNewPreference } from '@/hooks/useWhatsNewPreference';
import { cn } from '@/lib/utils';

interface WhatsNewTriggerProps {
  onClick: () => void;
}

export function WhatsNewTrigger({ onClick }: WhatsNewTriggerProps) {
  const { enabled, hasUnseen } = useWhatsNewPreference();
  const breathing = enabled && hasUnseen;

  return (
    <TooltipProvider delayDuration={300} disableHoverableContent>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={onClick}
            aria-label="What's new"
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:text-foreground"
          >
            <Sparkles
              className={cn('h-4 w-4', breathing && 'animate-whats-new-breathe')}
              strokeWidth={1.5}
            />
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom">What's new</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
