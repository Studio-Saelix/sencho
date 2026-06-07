import { memo, useCallback } from 'react';
import { cn } from '@/lib/utils';
import { useDeployFeedback, VERB_LABELS } from '@/context/DeployFeedbackContext';

interface DeployFeedbackPillProps {
  isVisible: boolean;
  onExpand: () => void;
}

function DeployFeedbackPillBase({ isVisible, onExpand }: DeployFeedbackPillProps) {
  const { panelState } = useDeployFeedback();
  const { stackName, action, status } = panelState;

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') onExpand();
  }, [onExpand]);

  if (!isVisible) return null;

  const verbLabel = VERB_LABELS[action];

  const dotClass = cn(
    'h-2 w-2 rounded-full shrink-0',
    (status === 'preparing' || status === 'streaming') && 'bg-brand animate-pulse',
    status === 'succeeded' && 'bg-success',
    status === 'failed' && 'bg-destructive',
  );

  const textClass = cn(
    'text-xs',
    (status === 'preparing' || status === 'streaming') && 'text-foreground',
    status === 'succeeded' && 'text-success',
    status === 'failed' && 'text-destructive',
  );

  return (
    <div
      role="button"
      tabIndex={0}
      data-testid="deploy-feedback-pill"
      onClick={onExpand}
      onKeyDown={handleKeyDown}
      className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 w-[280px] bg-popover/95 backdrop-blur-[10px] backdrop-saturate-[1.15] border border-glass-border rounded-full px-3 py-1.5 shadow-lg cursor-pointer flex items-center gap-2 max-md:bottom-[calc(var(--sn-mobile-tabbar-h)_+_env(safe-area-inset-bottom)_+_0.75rem)]"
    >
      <span className={dotClass} />
      <span className={cn(textClass, 'flex items-center gap-1 min-w-0 flex-1 overflow-hidden')}>
        <span className="shrink-0">{verbLabel.present}</span>
        <span className="font-mono truncate">{stackName}</span>
      </span>
    </div>
  );
}

export const DeployFeedbackPill = memo(DeployFeedbackPillBase);
