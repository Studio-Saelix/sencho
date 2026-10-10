import { cn } from '@/lib/utils';
import { EXPOSURE_INTENTS, type ExposureIntent } from '@/types/networking';

interface ExposureIntentPickerProps {
  value: ExposureIntent | null;
  /** Present on a per-service row: clearing then falls back to the stack's intent. */
  inherited?: ExposureIntent | null;
  canEdit: boolean;
  disabled?: boolean;
  onChange: (intent: ExposureIntent | null) => void;
}

/**
 * Exposure-intent picker: a row of pills plus a clear option. `value` null means
 * the scope is cleared. The clear option reads "unset" on the stack row and
 * "inherit" on a per-service row, where the service then falls back to the stack
 * intent. Disabled and read-only when the user cannot edit the stack.
 */
export function ExposureIntentPicker({ value, inherited, canEdit, disabled = false, onChange }: ExposureIntentPickerProps) {
  const locked = !canEdit || disabled;
  const pill = (active: boolean) => cn(
    'rounded px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide border transition-colors max-md:min-h-11 max-md:px-2.5',
    active ? 'border-brand/50 bg-brand/15 text-brand' : 'border-muted bg-card/40 text-stat-subtitle',
    locked ? 'cursor-default opacity-90' : 'hover:border-brand/40',
  );
  const clearLabel = inherited !== undefined ? 'inherit' : 'unset';
  return (
    <div className="flex flex-wrap items-center gap-1">
      {EXPOSURE_INTENTS.map(option => (
        <button key={option} type="button" disabled={locked} className={pill(value === option)} aria-pressed={value === option} onClick={() => onChange(option)}>
          {option}
        </button>
      ))}
      <button type="button" disabled={locked} className={pill(value === null)} aria-pressed={value === null} onClick={() => onChange(null)}>
        {clearLabel}
      </button>
      {value === null && inherited && (
        <span className="font-mono text-[10px] text-stat-subtitle">→ {inherited}</span>
      )}
    </div>
  );
}
