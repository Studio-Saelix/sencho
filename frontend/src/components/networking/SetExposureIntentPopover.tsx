import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { toast } from '@/components/ui/toast-store';
import { useExposureIntent } from '@/hooks/useExposureIntent';
import type { NetworkingFinding } from '@/types/networking';
import { ExposureIntentPicker } from './ExposureIntentPicker';

interface SetExposureIntentPopoverProps {
  stack: string;
  /** The service the finding is about; absent classifies the whole stack. */
  service: string | undefined;
  nodeId: number | undefined;
  label: string;
  /** The intent was saved, so the finding should be re-evaluated. */
  onSaved: () => void;
  finding: Pick<NetworkingFinding, 'id'>;
}

/**
 * Classify what a service publishes without leaving the finding. The verb is
 * the first click and choosing an intent is the second, which saves it: the
 * route is the one the stack networking panel uses.
 */
export function SetExposureIntentPopover({ stack, service, nodeId, label, onSaved, finding }: SetExposureIntentPopoverProps) {
  const [open, setOpen] = useState(false);
  const { intents, saving, load, save } = useExposureIntent(stack, nodeId);
  const scope = service ?? '';

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  const stackIntent = intents?.find(entry => entry.service === '')?.intent ?? null;
  const current = intents?.find(entry => entry.service === scope)?.intent ?? null;

  const choose = async (intent: Parameters<typeof save>[1]): Promise<void> => {
    if (!(await save(scope, intent))) return;
    toast.success(intent === null ? 'Exposure intent cleared.' : `Exposure intent set to ${intent}.`);
    setOpen(false);
    onSaved();
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="sm" className="h-7 px-2 text-xs max-md:min-h-11" data-testid={`finding-verb-${finding.id}`}>
          {label}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 space-y-2">
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
      </PopoverContent>
    </Popover>
  );
}
