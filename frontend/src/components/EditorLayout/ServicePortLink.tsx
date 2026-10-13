import { useEffect, useState } from 'react';
import { Check, Copy, Pencil } from 'lucide-react';
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
  const urlsReady = entry?.status === 'ready'
    || (entry?.status === 'loading' && Object.keys(entry.serviceUrls).length > 0);
  const edit = canEdit && serviceName && onEdit && urlsReady && !unavailable ? (
    <button
      type="button"
      aria-label={`Set URL for ${serviceName}`}
      onClick={() => onEdit(serviceName)}
      className="inline-flex h-4 w-4 items-center justify-center rounded text-stat-subtitle hover:text-foreground hover:bg-muted/60 max-md:h-11 max-md:w-11 max-md:shrink-0"
    >
      <Pencil className="h-3 w-3" strokeWidth={1.5} />
    </button>
  ) : canEdit && serviceName && urlsReady && unavailable ? (
    <button
      type="button"
      disabled
      title={unavailable}
      aria-label={unavailable}
      className="inline-flex h-4 w-4 items-center justify-center rounded text-stat-subtitle opacity-40 max-md:h-11 max-md:w-11 max-md:shrink-0"
    >
      <Pencil className="h-3 w-3" strokeWidth={1.5} />
    </button>
  ) : null;

  if (click.kind === 'text') {
    return (
      <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-0.5">
        <span>{click.portLabel}</span>
        {click.reason ? <span className="text-stat-subtitle">{click.reason}</span> : null}
        {click.reason === 'Service URL unavailable' && onRetry ? (
          <button type="button" onClick={onRetry} className="text-brand hover:underline max-md:min-h-11">
            Retry
          </button>
        ) : null}
        {edit}
      </span>
    );
  }

  const visible = click.hostLabel ? `${click.portLabel} · ${click.hostLabel}` : click.portLabel;
  return (
    <span className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap">
      <a
        href={click.href}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1 whitespace-nowrap text-brand hover:underline"
      >
        {visible}
      </a>
      <button
        type="button"
        aria-label={copied ? 'Copied' : 'Copy service URL'}
        onClick={() => {
          void copyToClipboard(click.href).then(() => setCopied(true)).catch(() => { /* clipboard unavailable */ });
        }}
        className={cn('inline-flex h-4 w-4 items-center justify-center rounded text-stat-subtitle hover:text-foreground hover:bg-muted/60')}
      >
        {copied ? <Check className="h-3 w-3" strokeWidth={2} /> : <Copy className="h-3 w-3" strokeWidth={1.5} />}
      </button>
      {edit}
    </span>
  );
}
