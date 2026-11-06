import type { ReactElement } from 'react';
import { SetExposureIntentPopover } from '@/components/networking/SetExposureIntentPopover';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useAuth } from '@/context/AuthContext';
import { cn } from '@/lib/utils';
import { SENCHO_OPEN_STACK_EVENT, type SenchoOpenStackDetail } from '@/lib/events';
import { tunnelPathLabel } from '@/lib/tunnelExposure';
import type { ImageExposureContext } from '@/types/security';

function openNetworking(nodeId: number | undefined, stackName: string) {
  if (nodeId === undefined) return;
  window.dispatchEvent(new CustomEvent<SenchoOpenStackDetail>(SENCHO_OPEN_STACK_EVENT, {
    detail: { nodeId, stackName, destination: 'anatomy-networking' },
  }));
}

function networkingActionLabel(ctx: ImageExposureContext): string {
  return ctx.intentConflict ? 'Review networking' : 'View networking';
}

/**
 * The verb that resolves this context where it is listed, or null when it
 * cannot run here: the intent could not be read, or the session may not edit
 * the stack (the route checks `stack:edit`). The context then keeps its named
 * navigation.
 */
function useIntentVerb(nodeId: number) {
  const { can } = useAuth();
  return (ctx: ImageExposureContext): string | null => {
    if (ctx.intentStatus === 'unavailable') return null;
    if (!can('stack:edit', 'stack', ctx.stackName, nodeId)) return null;
    return ctx.intentStatus === 'set' ? 'Change intent' : 'Set intent';
  };
}

/** The work that lives in the stack (ports, networks) is a named navigation, never the verb. */
function OpenNetworkingLink({ nodeId, stackName }: { nodeId: number; stackName: string }) {
  return (
    <button
      type="button"
      className="text-xs font-medium text-brand hover:underline"
      onClick={() => openNetworking(nodeId, stackName)}
    >
      Open stack networking
    </button>
  );
}

function ContextIntentPopover({ ctx, nodeId, onIntentSaved, trigger, align }: {
  ctx: ImageExposureContext;
  nodeId: number;
  onIntentSaved: () => void;
  trigger: ReactElement;
  align?: 'start' | 'end';
}) {
  return (
    <SetExposureIntentPopover
      stack={ctx.stackName}
      service={ctx.serviceName}
      nodeId={nodeId}
      onSaved={onIntentSaved}
      trigger={trigger}
      align={align}
      footer={<OpenNetworkingLink nodeId={nodeId} stackName={ctx.stackName} />}
    />
  );
}

function NetworkingContextList({
  contexts,
  nodeId,
  onIntentSaved,
  showConflictHint = false,
}: {
  contexts: ImageExposureContext[];
  nodeId: number;
  onIntentSaved: () => void;
  showConflictHint?: boolean;
}) {
  const intentVerb = useIntentVerb(nodeId);
  return (
    <ul className="space-y-1">
      {contexts.map((ctx) => {
        const verb = intentVerb(ctx);
        return (
          <li
            key={`${ctx.stackName}\0${ctx.serviceName}`}
            className="flex items-start justify-between gap-2 rounded-md px-2 py-1.5 hover:bg-muted/40"
          >
            <button
              type="button"
              className="flex min-w-0 flex-1 items-start justify-between gap-2 text-left"
              onClick={() => openNetworking(nodeId, ctx.stackName)}
            >
              <span className="min-w-0">
                <span className="block truncate font-mono text-[11px] text-stat-value">
                  {ctx.stackName}/{ctx.serviceName}
                </span>
                {ctx.tunnel ? (
                  <span className="block font-mono text-[10px] text-stat-subtitle">{tunnelPathLabel(ctx.tunnel)}</span>
                ) : null}
                {showConflictHint && ctx.intentConflict ? (
                  <span className="font-mono text-[10px] text-warning">Intent mismatch</span>
                ) : null}
              </span>
              {verb === null ? (
                <span className="shrink-0 font-mono text-[10px] text-brand whitespace-nowrap">
                  {networkingActionLabel(ctx)}
                </span>
              ) : null}
            </button>
            {verb !== null ? (
              <ContextIntentPopover
                ctx={ctx}
                nodeId={nodeId}
                onIntentSaved={onIntentSaved}
                trigger={(
                  <button
                    type="button"
                    className="shrink-0 font-mono text-[10px] text-brand whitespace-nowrap hover:underline"
                    aria-label={`${verb} for ${ctx.stackName}/${ctx.serviceName}`}
                  >
                    {verb}
                  </button>
                )}
              />
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

/** Network exposed badge + optional multi-context Networking popover. */
export function NetworkExposedControl({
  contexts,
  nodeId,
  onIntentSaved = () => undefined,
  className,
}: {
  contexts: ImageExposureContext[];
  nodeId?: number;
  /** An intent was saved from the popover, so the exposure conclusions should be re-read. */
  onIntentSaved?: () => void;
  className?: string;
}) {
  const intentVerb = useIntentVerb(nodeId ?? 0);
  // With one context there is no list to open, so a tunnel says so on the badge itself.
  const singleTunnel = contexts.length === 1 ? contexts[0]!.tunnel : undefined;
  const badge = (
    <span className={cn('font-mono text-[10px] uppercase tracking-[0.14em] text-warning whitespace-nowrap', className)}>
      {singleTunnel ? 'Network exposed · tunnel' : 'Network exposed'}
    </span>
  );

  if (contexts.length === 0 || nodeId === undefined) {
    return badge;
  }

  if (contexts.length === 1) {
    const only = contexts[0]!;
    const via = only.tunnel ? `, ${tunnelPathLabel(only.tunnel)}` : '';
    const verb = intentVerb(only);
    const title = only.tunnel ? tunnelPathLabel(only.tunnel) : undefined;
    if (verb !== null) {
      return (
        <ContextIntentPopover
          ctx={only}
          nodeId={nodeId}
          onIntentSaved={onIntentSaved}
          align="start"
          trigger={(
            <button
              type="button"
              className="hover:underline"
              title={title}
              onClick={(e) => e.stopPropagation()}
              aria-label={`${verb} for ${only.stackName}/${only.serviceName}${via}`}
            >
              {badge}
            </button>
          )}
        />
      );
    }
    return (
      <button
        type="button"
        className="hover:underline"
        title={title}
        onClick={(e) => {
          e.stopPropagation();
          openNetworking(nodeId, only.stackName);
        }}
        aria-label={`${networkingActionLabel(only)} for ${only.stackName}/${only.serviceName}${via}`}
      >
        {badge}
      </button>
    );
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="hover:underline"
          onClick={(e) => e.stopPropagation()}
          aria-label="View networking contexts"
        >
          {badge}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-2" onClick={(e) => e.stopPropagation()}>
        <NetworkingContextList contexts={contexts} nodeId={nodeId} onIntentSaved={onIntentSaved} showConflictHint />
      </PopoverContent>
    </Popover>
  );
}

const BANNER_VERB_CLASS = 'text-xs font-medium text-brand hover:underline whitespace-nowrap shrink-0';

/**
 * Banner control: one context sets its intent in place (or names the stack's
 * networking when it cannot), several open the list of contexts to choose from.
 */
export function ViewNetworkingAction({
  contexts,
  nodeId,
  onIntentSaved = () => undefined,
}: {
  contexts: ImageExposureContext[];
  nodeId?: number;
  onIntentSaved?: () => void;
}) {
  const intentVerb = useIntentVerb(nodeId ?? 0);
  if (contexts.length === 0 || nodeId === undefined) return null;

  if (contexts.length === 1) {
    const only = contexts[0]!;
    const verb = intentVerb(only);
    if (verb !== null) {
      return (
        <ContextIntentPopover
          ctx={only}
          nodeId={nodeId}
          onIntentSaved={onIntentSaved}
          trigger={<button type="button" className={BANNER_VERB_CLASS}>{verb}</button>}
        />
      );
    }
    return (
      <button type="button" className={BANNER_VERB_CLASS} onClick={() => openNetworking(nodeId, only.stackName)}>
        View networking
      </button>
    );
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" className={BANNER_VERB_CLASS}>
          View networking
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-2">
        <NetworkingContextList contexts={contexts} nodeId={nodeId} onIntentSaved={onIntentSaved} />
      </PopoverContent>
    </Popover>
  );
}
