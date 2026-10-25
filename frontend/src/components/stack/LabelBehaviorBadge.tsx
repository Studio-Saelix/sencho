import { cn } from '@/lib/utils';
import { BEHAVIOR_LABELS, type LabelBehavior } from '@/lib/labelInventory';

const TONES: Record<LabelBehavior['state'], string> = {
  active: 'border-success/40 bg-success/[0.06] text-success',
  invalid: 'border-warning/40 bg-warning/[0.06] text-warning',
  unsupported: 'border-warning/40 bg-warning/[0.06] text-warning',
  inert: 'border-muted text-stat-subtitle',
};

/**
 * Whether Sencho acts on an `io.sencho.*` label. An ignored or unsupported label
 * says why inline; an inert one (image, runtime, or an unrendered model) keeps
 * the explanation on hover so the audit stays quiet.
 */
export function LabelBehaviorBadge({ behavior }: { behavior: LabelBehavior }) {
  const showReason = behavior.reason && (behavior.state === 'invalid' || behavior.state === 'unsupported');
  return (
    <>
      <span
        className={cn('rounded border px-1.5 py-0.5 font-mono text-[10px]', TONES[behavior.state])}
        title={behavior.reason ?? behavior.summary}
        data-testid="label-behavior"
        data-state={behavior.state}
      >
        {BEHAVIOR_LABELS[behavior.state]}
      </span>
      {showReason && <span className="text-[11px] text-warning">{behavior.reason}</span>}
    </>
  );
}
