import { useEffect, useState } from 'react';
import { ArrowUpRight, Check, Copy, Pencil } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { copyToClipboard } from '@/lib/clipboard';
import {
  resolvePublishedPortClick,
  serviceUrlEditBlockedMessage,
  type ServiceUrlEditBlock,
  type ServiceUrlEntry,
} from '@/lib/serviceUrlResolve';
import type { Node } from '@/context/NodeContext';
import { cn } from '@/lib/utils';

const OTHER_FILE = 'This service is not in the open compose file.';
const LIST_UNAVAILABLE = 'Service URL unavailable';
const REFRESH_FAILED = 'Could not refresh';
const EDIT_SERVICE_URL = 'Edit service URL';

function PortPencil({ label, disabled, onClick }: { label: string; disabled?: boolean; onClick?: () => void }) {
  const button = (
    <button
      type="button"
      disabled={disabled}
      title={disabled ? label : undefined}
      aria-label={label}
      onClick={onClick}
      className={cn(
        'inline-flex h-4 w-4 shrink-0 items-center justify-center rounded text-stat-subtitle max-md:h-11 max-md:w-11',
        disabled ? 'opacity-40' : 'hover:text-foreground hover:bg-muted/60',
      )}
    >
      <Pencil className="h-3 w-3" strokeWidth={1.5} />
    </button>
  );
  if (disabled) return button;
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          {button}
        </TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

interface ServicePortLinkProps {
  portLabel: string;
  publicPort: number;
  privatePort?: number;
  serviceName?: string;
  entry: ServiceUrlEntry | null;
  node: Node | null;
  canEdit: boolean;
  /** Services declared in the open compose buffer. Omit when the buffer is unknown. */
  sourceServices?: readonly string[] | null;
  /** Services whose URL the open compose file does not control, with the reason. */
  lockedServices?: ReadonlyMap<string, ServiceUrlEditBlock>;
  onEdit?: (serviceName: string) => void;
  onRetry?: () => void;
}

export function ServicePortLink({
  portLabel,
  publicPort,
  privatePort,
  serviceName,
  entry,
  node,
  canEdit,
  sourceServices,
  lockedServices,
  onEdit,
  onRetry,
}: ServicePortLinkProps) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return undefined;
    const timer = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const click = resolvePublishedPortClick({
    entry,
    serviceName,
    publicPort,
    privatePort,
    portLabel,
    node,
  });

  const inOpenFile = sourceServices === undefined
    || (sourceServices !== null && !!serviceName && sourceServices.includes(serviceName));
  const lockedState = serviceName ? lockedServices?.get(serviceName) : undefined;
  const lockedMessage = lockedState ? serviceUrlEditBlockedMessage(lockedState) : null;
  const unavailable = !inOpenFile ? OTHER_FILE : lockedMessage;
  const listUnavailable = entry?.status === 'unavailable';
  const urlsReady = entry?.status === 'ready'
    || (entry?.status === 'loading' && Object.keys(entry.serviceUrls).length > 0);
  // An unavailable list has no edit authority. The disabled pencil says so
  // unless a lock message already labels it.
  const edit = canEdit && serviceName && onEdit && urlsReady && !unavailable ? (
    <PortPencil label={EDIT_SERVICE_URL} onClick={() => onEdit(serviceName)} />
  ) : canEdit && serviceName && (urlsReady || listUnavailable) && unavailable ? (
    <PortPencil label={unavailable} disabled />
  ) : canEdit && serviceName && listUnavailable ? (
    <PortPencil label={LIST_UNAVAILABLE} disabled />
  ) : null;
  const retry = (listUnavailable || entry?.refreshFailed) && onRetry ? (
    <button type="button" onClick={onRetry} className="text-brand hover:underline max-md:min-h-11">
      Retry
    </button>
  ) : null;

  if (click.kind === 'pending') {
    // The first lookup is still in flight: a configured URL could still
    // arrive, so the port stays plain text until the outcome is known.
    return (
      <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-0.5">
        <span>{click.portLabel}</span>
      </span>
    );
  }

  if (click.kind === 'text') {
    return (
      <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-0.5">
        <span>{click.portLabel}</span>
        {click.reason ? <span className="text-stat-subtitle">{click.reason}</span> : null}
        {entry?.refreshFailed ? <span className="text-stat-subtitle">{REFRESH_FAILED}</span> : null}
        {retry}
        {edit}
      </span>
    );
  }

  return (
    <span className="inline-flex w-fit max-w-full flex-wrap items-center gap-x-1 gap-y-0.5">
      <a
        href={click.href}
        target="_blank"
        rel="noopener noreferrer"
        title={click.href}
        className="inline-flex min-w-0 max-w-full items-center gap-1 text-brand hover:underline"
      >
        <span className="shrink-0">{click.portLabel}</span>
        {click.hostLabel ? <span className="min-w-0 truncate">{click.hostLabel}</span> : null}
        <ArrowUpRight className="h-3 w-3 shrink-0" strokeWidth={1.5} />
      </a>
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label={copied ? 'Copied' : 'Copy service URL'}
              onClick={() => {
                void copyToClipboard(click.href).then(() => setCopied(true)).catch(() => { /* clipboard unavailable */ });
              }}
              className={cn('inline-flex h-4 w-4 shrink-0 items-center justify-center rounded text-stat-subtitle hover:text-foreground hover:bg-muted/60 max-md:h-11 max-md:w-11')}
            >
              {copied ? <Check className="h-3 w-3" strokeWidth={2} /> : <Copy className="h-3 w-3" strokeWidth={1.5} />}
            </button>
          </TooltipTrigger>
          <TooltipContent>Copy service URL</TooltipContent>
        </Tooltip>
      </TooltipProvider>
      {edit}
      {listUnavailable ? <span className="text-stat-subtitle">{LIST_UNAVAILABLE}</span> : null}
      {entry?.refreshFailed ? <span className="text-stat-subtitle">{REFRESH_FAILED}</span> : null}
      {retry}
    </span>
  );
}
