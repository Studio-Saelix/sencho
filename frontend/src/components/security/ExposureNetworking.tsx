import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
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

function NetworkingContextList({
  contexts,
  nodeId,
  showConflictHint = false,
}: {
  contexts: ImageExposureContext[];
  nodeId: number;
  showConflictHint?: boolean;
}) {
  return (
    <ul className="space-y-1">
      {contexts.map((ctx) => (
        <li key={`${ctx.stackName}\0${ctx.serviceName}`}>
          <button
            type="button"
            className="flex w-full items-start justify-between gap-2 rounded-md px-2 py-1.5 text-left hover:bg-muted/40"
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
            <span className="shrink-0 font-mono text-[10px] text-brand whitespace-nowrap">
              {networkingActionLabel(ctx)}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/** Network exposed badge + optional multi-context Networking popover. */
export function NetworkExposedControl({
  contexts,
  nodeId,
  className,
}: {
  contexts: ImageExposureContext[];
  nodeId?: number;
  className?: string;
}) {
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
    return (
      <button
        type="button"
        className="hover:underline"
        title={only.tunnel ? tunnelPathLabel(only.tunnel) : undefined}
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
        <NetworkingContextList contexts={contexts} nodeId={nodeId} showConflictHint />
      </PopoverContent>
    </Popover>
  );
}

/** Banner-only View networking control (single dispatch or multi popover). */
export function ViewNetworkingAction({
  contexts,
  nodeId,
}: {
  contexts: ImageExposureContext[];
  nodeId?: number;
}) {
  if (contexts.length === 0 || nodeId === undefined) return null;

  if (contexts.length === 1) {
    const only = contexts[0]!;
    return (
      <button
        type="button"
        className="text-xs font-medium text-brand hover:underline whitespace-nowrap shrink-0"
        onClick={() => openNetworking(nodeId, only.stackName)}
      >
        View networking
      </button>
    );
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" className="text-xs font-medium text-brand hover:underline whitespace-nowrap shrink-0">
          View networking
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-2">
        <NetworkingContextList contexts={contexts} nodeId={nodeId} />
      </PopoverContent>
    </Popover>
  );
}
