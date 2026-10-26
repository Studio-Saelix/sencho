import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import type { ActionHint } from './useFleetActionHints';

interface Props {
  name: string;
  description: string;
  /** Omit for an action with no live fact worth showing. */
  hint?: ActionHint;
  /** The verb that opens the task, ending in an ellipsis because the work continues in a sheet. */
  verb: string;
  onOpen: () => void;
}

/** One action on the Actions list: what it does, one live fact, and the verb that opens it. */
export function FleetActionRow({ name, description, hint, verb, onOpen }: Props) {
  return (
    <li className="grid grid-cols-[minmax(0,1fr)_minmax(8rem,auto)_auto] items-center gap-6 px-6 py-5">
      <div className="min-w-0">
        <div className="text-[15px] font-medium text-stat-value">{name}</div>
        <div className="mt-0.5 text-[13px] text-stat-subtitle">{description}</div>
      </div>
      <div className="text-right font-mono text-xs tabular-nums text-stat-title">
        {hint?.kind === 'loading' && <Skeleton className="ml-auto h-4 w-24" aria-hidden />}
        {hint?.kind === 'ready' && hint.text}
      </div>
      <Button variant="outline" size="sm" onClick={onOpen}>
        {verb}
      </Button>
    </li>
  );
}
