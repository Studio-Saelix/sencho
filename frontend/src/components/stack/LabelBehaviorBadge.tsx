import { cn } from '@/lib/utils';
import {
  BEHAVIOR_LABELS,
  SENCHO_LABEL_NOT_REPORTED_COPY,
  isSenchoLabelKey,
  type LabelBehavior,
  type LabelValue,
} from '@/lib/labelInventory';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';

const BADGE_CLASS = 'rounded border px-1.5 py-0.5 font-mono text-[10px]';

const TONES: Record<LabelBehavior['state'], string> = {
  active: 'border-success/40 bg-success/[0.06] text-success',
  invalid: 'border-warning/40 bg-warning/[0.06] text-warning',
  unsupported: 'border-warning/40 bg-warning/[0.06] text-warning',
  inert: 'border-muted text-stat-subtitle',
};

/**
 * Whether Sencho acts on an `io.sencho.*` label. An ignored or unsupported label
 * says why inline. An inert one (image, runtime, or an unrendered model) keeps
 * the explanation behind the badge, which opens on click, tap, or keyboard, so
 * the audit stays quiet without hiding the reason from anyone.
 */
export function LabelBehaviorBadge({ behavior }: { behavior: LabelBehavior }) {
  const inline = behavior.state === 'invalid' || behavior.state === 'unsupported';
  const explanation = !inline ? behavior.reason ?? behavior.summary : undefined;
  const badge = (
    <span
      className={cn(BADGE_CLASS, TONES[behavior.state])}
      data-testid="label-behavior"
      data-state={behavior.state}
    >
      {BEHAVIOR_LABELS[behavior.state]}
    </span>
  );
  return (
    <>
      {explanation ? (
        <Popover>
          <PopoverTrigger asChild>
            <button
              type="button"
              className={cn(BADGE_CLASS, TONES[behavior.state], 'cursor-pointer hover:bg-muted/40 max-md:min-h-11')}
              data-testid="label-behavior"
              data-state={behavior.state}
              aria-label={`${BEHAVIOR_LABELS[behavior.state]}: why`}
            >
              {BEHAVIOR_LABELS[behavior.state]}
            </button>
          </PopoverTrigger>
          <PopoverContent className="max-w-xs text-xs leading-relaxed" data-testid="label-behavior-reason">
            {explanation}
          </PopoverContent>
        </Popover>
      ) : badge}
      {inline && behavior.reason && <span className="text-[11px] text-warning">{behavior.reason}</span>}
    </>
  );
}

/** The behavior badge for a label row, or a quiet cue when an `io.sencho.*` label comes from a node that does not report one. */
export function LabelBehaviorStatus({ label }: { label: Pick<LabelValue, 'key' | 'behavior'> }) {
  if (label.behavior) return <LabelBehaviorBadge behavior={label.behavior} />;
  if (!isSenchoLabelKey(label.key)) return null;
  return (
    <span
      className={cn(BADGE_CLASS, 'border-muted text-stat-subtitle')}
      title={SENCHO_LABEL_NOT_REPORTED_COPY}
      data-testid="label-behavior-not-reported"
    >
      Not reported
    </span>
  );
}
