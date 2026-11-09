import { useEffect, useState, type ReactElement, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { toast } from '@/components/ui/toast-store';
import { useExposureIntent, type IntentEntry } from '@/hooks/useExposureIntent';
import type { NetworkingFinding } from '@/types/networking';
import { ExposureIntentPicker } from './ExposureIntentPicker';

type PopoverTriggerProps =
  | { label: string; finding: Pick<NetworkingFinding, 'id'>; trigger?: never }
  /** A surface that already has its own control (a badge) opens the picker from it. */
  | { trigger: ReactElement; label?: never; finding?: never };

type SetExposureIntentPopoverProps = PopoverTriggerProps & {
  stack: string;
  /** The service the finding is about; absent classifies the whole stack. */
  service: string | undefined;
  nodeId: number | undefined;
  /** The save was confirmed; the stack's intents after it are handed over so the
   *  surface can keep showing the confirmed result even if its reread fails.
   *  Saves made here to a stack arrive in the order they were made. */
  onSaved: (saved: IntentEntry[]) => void;
  /** A named way out for the work that lives elsewhere, under the picker. */
  footer?: ReactNode;
  /** Which edge of the trigger the popover lines up with; a trigger at the row's start passes `start`. */
  align?: 'start' | 'end';
};

/**
 * Classify what a service publishes without leaving the surface that shows it. The verb is
 * the first click and choosing an intent is the second, which saves it: the
 * route is the one the stack networking panel uses.
 */
export function SetExposureIntentPopover(props: SetExposureIntentPopoverProps) {
  const { stack, service, nodeId, onSaved, footer, align = 'end' } = props;
  const [open, setOpen] = useState(false);
  const { intents, saving, load, save } = useExposureIntent(stack, nodeId);
  const scope = service ?? '';

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  const stackIntent = intents?.find(entry => entry.service === '')?.intent ?? null;
  const current = intents?.find(entry => entry.service === scope)?.intent ?? null;

  const choose = async (intent: Parameters<typeof save>[1]): Promise<void> => {
    const saved = await save(scope, intent);
    if (saved === null) return;
    toast.success(intent === null ? 'Exposure intent cleared.' : `Exposure intent set to ${intent}.`);
    setOpen(false);
    onSaved(saved);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        {props.trigger !== undefined ? props.trigger : (
          <Button variant="ghost" size="sm" className="h-7 px-2 text-xs max-md:min-h-11" data-testid={`finding-verb-${props.finding.id}`}>
            {props.label}
          </Button>
        )}
      </PopoverTrigger>
      <PopoverContent align={align} className="w-80 space-y-2" onClick={e => e.stopPropagation()}>
        {/* Portaled content still bubbles React clicks to the row it opened from (a phone image row inspects on click). */}
        <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-stat-subtitle">
          {service ? `${service} in ${stack}` : stack}
        </p>
        {intents === null ? (
          <p className="text-xs text-stat-subtitle">Loading…</p>
        ) : (
          <ExposureIntentPicker
            value={current}
            inherited={service ? stackIntent : undefined}
            canEdit
            disabled={saving}
            onChange={intent => void choose(intent)}
          />
        )}
        {footer}
      </PopoverContent>
    </Popover>
  );
}
