import { SegmentedControl } from '@/components/ui/segmented-control';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { DatePicker } from '@/components/ui/date-picker';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { getCronDescription, type SimpleFrequency, type SimpleSchedule } from '@/lib/scheduling';
import { cn } from '@/lib/utils';

const FREQUENCY_OPTIONS: { value: SimpleFrequency; label: string }[] = [
  { value: 'once', label: 'Once' },
  { value: 'hourly', label: 'Hourly' },
  { value: 'daily', label: 'Daily' },
  { value: 'weekly', label: 'Weekly' },
  { value: 'monthly', label: 'Monthly' },
];

const WEEKDAYS: { value: number; short: string; full: string }[] = [
  { value: 0, short: 'Su', full: 'Sunday' },
  { value: 1, short: 'Mo', full: 'Monday' },
  { value: 2, short: 'Tu', full: 'Tuesday' },
  { value: 3, short: 'We', full: 'Wednesday' },
  { value: 4, short: 'Th', full: 'Thursday' },
  { value: 5, short: 'Fr', full: 'Friday' },
  { value: 6, short: 'Sa', full: 'Saturday' },
];

const pad2 = (n: number) => String(n).padStart(2, '0');
const numInputValue = (n: number) => (Number.isNaN(n) ? '' : n);

/** A compact 0..count-1 dropdown rendered with the design-system Select. */
function UnitSelect({ value, count, ariaLabel, onValueChange }: {
  value: number;
  count: number;
  ariaLabel: string;
  onValueChange: (n: number) => void;
}) {
  return (
    <Select value={String(value)} onValueChange={v => onValueChange(Number(v))}>
      <SelectTrigger aria-label={ariaLabel} className="w-[72px] font-mono tabular-nums">
        <SelectValue />
      </SelectTrigger>
      <SelectContent className="max-h-[240px]">
        {Array.from({ length: count }, (_, i) => i).map(n => (
          <SelectItem key={n} value={String(n)} className="font-mono tabular-nums">{pad2(n)}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

interface ScheduleSimplePanelProps {
  value: SimpleSchedule;
  onChange: (next: SimpleSchedule) => void;
  derivedCron: string;
  error: string | null;
}

export function ScheduleSimplePanel({ value, onChange, derivedCron, error }: ScheduleSimplePanelProps) {
  const patch = (partial: Partial<SimpleSchedule>) => onChange({ ...value, ...partial });

  const toggleWeekday = (day: number, checked: boolean) => {
    patch({ weekdays: checked ? [...value.weekdays, day] : value.weekdays.filter(d => d !== day) });
  };

  const timeControl = (
    <div className="flex flex-col gap-1.5">
      <Label>Time</Label>
      <div className="flex items-center gap-1.5">
        <UnitSelect value={value.hour} count={24} ariaLabel="Hour" onValueChange={hour => patch({ hour })} />
        <span className="text-sm text-muted-foreground">:</span>
        <UnitSelect value={value.minute} count={60} ariaLabel="Minute" onValueChange={minute => patch({ minute })} />
      </div>
    </div>
  );

  return (
    <div className="space-y-3">
      <SegmentedControl<SimpleFrequency>
        value={value.frequency}
        options={FREQUENCY_OPTIONS}
        onChange={freq => patch({ frequency: freq })}
        ariaLabel="Schedule frequency"
        fullWidth
      />

      <div className="flex flex-wrap items-end gap-4 max-md:gap-3">
        {value.frequency === 'once' && (
          <div className="flex flex-col gap-1.5">
            <Label>Date</Label>
            <DatePicker value={value.date ?? undefined} onChange={date => patch({ date: date ?? null })} />
          </div>
        )}

        {value.frequency === 'weekly' && (
          <div className="flex flex-col gap-1.5">
            <Label>Days</Label>
            <div className="inline-flex items-center rounded-md border border-glass-border bg-popover p-0.5 shadow-sm backdrop-blur-[10px] backdrop-saturate-[1.15]" role="group" aria-label="Weekdays">
              {WEEKDAYS.map(d => {
                const active = value.weekdays.includes(d.value);
                return (
                  <button
                    key={d.value}
                    type="button"
                    role="checkbox"
                    aria-checked={active}
                    aria-label={d.full}
                    onClick={() => toggleWeekday(d.value, !active)}
                    className={cn(
                      'rounded px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.14em] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/50',
                      active ? 'bg-brand/10 text-brand' : 'text-stat-subtitle hover:text-stat-value',
                    )}
                  >
                    {d.short}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {value.frequency === 'monthly' && (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="simple-dom">Day of month</Label>
            <Input
              id="simple-dom"
              type="number"
              min={1}
              max={31}
              value={numInputValue(value.dayOfMonth)}
              onChange={e => patch({ dayOfMonth: Number.parseInt(e.target.value, 10) })}
              className="w-24"
            />
          </div>
        )}

        {value.frequency === 'hourly' ? (
          <div className="flex flex-col gap-1.5">
            <Label>Minute</Label>
            <div className="flex items-center gap-2">
              <UnitSelect value={value.minute} count={60} ariaLabel="Minute" onValueChange={minute => patch({ minute })} />
              <span className="text-xs text-muted-foreground">past every hour</span>
            </div>
          </div>
        ) : (
          timeControl
        )}
      </div>

      {error ? (
        <p className="text-xs text-destructive">{error}</p>
      ) : (
        <p className="text-xs text-muted-foreground">
          {getCronDescription(derivedCron)} <span className="font-mono text-stat-subtitle">· {derivedCron}</span>
        </p>
      )}

      <p className="text-xs text-muted-foreground">Runs in the node's local timezone.</p>
    </div>
  );
}
