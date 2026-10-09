import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { FindingRowActions } from '@/components/ui/finding-row-actions';
import { UpdateReadinessDialog } from '@/components/stack/UpdateReadinessDialog';
import { ExposureIntentPicker } from '@/components/networking/ExposureIntentPicker';
import { toast } from '@/components/ui/toast-store';
import { useExposureIntent } from '@/hooks/useExposureIntent';
import { useStackUpdate } from '@/hooks/useStackUpdate';
import type { DismissalMode } from '@/types/findingDismissal';
import type { PostureReason } from '@/types/security';
import { isReasonDismissable } from '@/lib/securityDismissals';
import type { ReasonVerb, StackServiceRef } from './securityVerbs';

/** What the page wires into every reason row so the queue and the masthead act the same way. */
export interface SecurityReasonControls {
  nodeId: number | undefined;
  /** The one handler for a verb that runs in place or navigates; the page owns busy state. */
  run: (reason: PostureReason, verb: ReasonVerb) => void | Promise<void>;
  busy: (verb: ReasonVerb) => boolean;
  /** A verb changed what the overview says, so the page should re-read it. */
  onResolved: () => void;
  /** Mirrors the dismissal route's guard (`node:manage` on the node). */
  canDismiss: boolean;
  isDismissing: (reason: PostureReason) => boolean;
  onDismiss: (reason: PostureReason, mode: DismissalMode, days?: number) => void;
}

const VERB_CLASS = 'h-7 px-2 text-xs max-md:min-h-11';
const MAX_LISTED_SERVICES = 8;

function ReviewUpdateVerb({ verb, nodeId, onResolved }: {
  verb: Extract<ReasonVerb, { kind: 'review-update' }>;
  nodeId: number | undefined;
  onResolved: () => void;
}) {
  const updateStack = useStackUpdate();
  const [stack, setStack] = useState<string | null>(null);
  const trigger = (onClick?: () => void) => (
    <Button variant="ghost" size="sm" className={VERB_CLASS} onClick={onClick} data-testid="reason-verb-review-update">
      {verb.label}
    </Button>
  );

  return (
    <>
      {verb.stacks.length === 1 ? trigger(() => setStack(verb.stacks[0])) : (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>{trigger()}</DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {verb.stacks.map(name => (
              <DropdownMenuItem key={name} onSelect={() => setStack(name)}>{name}</DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      {stack !== null && nodeId !== undefined && (
        <UpdateReadinessDialog
          open
          stackName={stack}
          nodeId={nodeId}
          onCancel={() => setStack(null)}
          onProceed={() => {
            const name = stack;
            setStack(null);
            void updateStack({ nodeId, stackName: name }).then(result => {
              if (result.ok) onResolved();
            });
          }}
        />
      )}
    </>
  );
}

function ServiceIntentRow({ target, nodeId, onResolved }: { target: StackServiceRef; nodeId: number | undefined; onResolved: () => void }) {
  const { intents, saving, load, save } = useExposureIntent(target.stack, nodeId);
  useEffect(() => { void load(); }, [load]);
  const stackIntent = intents?.find(entry => entry.service === '')?.intent ?? null;
  const current = intents?.find(entry => entry.service === target.service)?.intent ?? null;

  return (
    <div className="space-y-1">
      <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-stat-subtitle">{target.service} in {target.stack}</p>
      {intents === null ? (
        <p className="text-xs text-stat-subtitle">Loading…</p>
      ) : (
        <ExposureIntentPicker
          value={current}
          inherited={stackIntent}
          canEdit
          disabled={saving}
          onChange={intent => {
            void save(target.service, intent).then(ok => {
              if (!ok) return;
              toast.success(intent === null ? 'Exposure intent cleared.' : `Exposure intent set to ${intent}.`);
              onResolved();
            });
          }}
        />
      )}
    </div>
  );
}

function SetExposureIntentVerb({ verb, nodeId, onResolved }: {
  verb: Extract<ReasonVerb, { kind: 'set-exposure-intent' }>;
  nodeId: number | undefined;
  onResolved: () => void;
}) {
  const listed = verb.services.slice(0, MAX_LISTED_SERVICES);
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="sm" className={VERB_CLASS} data-testid="reason-verb-set-exposure-intent">{verb.label}</Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 space-y-3">
        {listed.map(target => (
          <ServiceIntentRow key={`${target.stack}/${target.service}`} target={target} nodeId={nodeId} onResolved={onResolved} />
        ))}
        {verb.services.length > listed.length && (
          <p className="text-xs text-stat-subtitle">
            {verb.services.length - listed.length} more. Set the rest from Networking.
          </p>
        )}
      </PopoverContent>
    </Popover>
  );
}

/**
 * The action cluster for one posture reason: its resolving verb, then Dismiss
 * where the reason allows it. Shared by the Overview review queue and the
 * masthead, so both run the same verb.
 */
export function SecurityReasonActions({ reason, verb, controls }: {
  reason: PostureReason;
  verb: ReasonVerb | null;
  controls: SecurityReasonControls;
}) {
  const body = verb === null ? null : verb.kind === 'review-update' ? (
    <ReviewUpdateVerb verb={verb} nodeId={controls.nodeId} onResolved={controls.onResolved} />
  ) : verb.kind === 'set-exposure-intent' ? (
    <SetExposureIntentVerb verb={verb} nodeId={controls.nodeId} onResolved={controls.onResolved} />
  ) : (
    <Button
      variant="ghost"
      size="sm"
      className={VERB_CLASS}
      disabled={controls.busy(verb)}
      data-testid={`reason-verb-${verb.kind}`}
      onClick={() => void controls.run(reason, verb)}
    >
      {controls.busy(verb) ? 'Working…' : verb.kind === 'navigate' ? `${verb.label} →` : verb.label}
    </Button>
  );

  if (!isReasonDismissable(reason)) return <div className="flex items-center gap-1">{body}</div>;
  return (
    <FindingRowActions
      dismissPolicy={reason.dismissPolicy ?? 'none'}
      canDismiss={controls.canDismiss}
      pending={controls.isDismissing(reason)}
      subject={reason.label}
      onDismiss={(mode, days) => controls.onDismiss(reason, mode, days)}
    >
      {body}
    </FindingRowActions>
  );
}
