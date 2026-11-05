import { Badge } from '@/components/ui/badge';
import type { AgentDirFacts, ComposeDirFacts, PathFacts } from './types';

/**
 * One summary row per directory, reused by the preflight and plan steps. The
 * Answer above it carries the tone, so these rows stay quiet.
 */

function pathState(path: PathFacts, created: boolean): { word: string; detail: string | null } {
  if (path.probeError) return { word: 'Unknown', detail: null };
  if (created) return { word: 'Will be created', detail: null };
  if (!path.exists) return { word: 'Will be created', detail: null };
  return { word: 'Existing', detail: null };
}

function rowDetail(path: PathFacts, extra: string | null): string | null {
  const parts: string[] = [];
  if (path.realPath && path.realPath !== path.input) parts.push(`resolves to ${path.realPath}`);
  if (path.owner) parts.push(`${path.owner}:${path.group ?? path.owner} ${path.mode ?? ''}`.trim());
  if (extra) parts.push(extra);
  return parts.length > 0 ? parts.join(' · ') : null;
}

function PathRow({
  label,
  path,
  created,
  extra,
}: {
  label: string;
  path: PathFacts;
  created: boolean;
  extra: string | null;
}) {
  const state = pathState(path, created);
  const detail = rowDetail(path, extra);
  return (
    <div className="flex flex-col gap-1 border-t border-muted py-2 first:border-t-0">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-stat-subtitle">{label}</span>
        <Badge variant="outline" className="font-mono text-[10px]">{state.word}</Badge>
      </div>
      <code className="break-all font-mono text-[12px] text-stat-value">{path.input}</code>
      {detail && <span className="font-mono text-[10px] text-stat-subtitle">{detail}</span>}
    </div>
  );
}

export function BootstrapPathSummary({
  composeDir,
  agentDir,
}: {
  composeDir: ComposeDirFacts;
  agentDir: AgentDirFacts;
}) {
  const stackDetail = composeDir.probeError
    ? 'inspection failed'
    : composeDir.exists
      ? composeDir.inventoryError
        ? 'stack count unknown'
        : `${composeDir.stackCount ?? 0} stack${composeDir.stackCount === 1 ? '' : 's'}${composeDir.inventoryTruncated ? ' (truncated)' : ''}`
      : null;
  const agentDetail = agentDir.probeError
    ? 'inspection failed'
    : agentDir.exists
      ? agentDir.inventoryError
        ? 'contents unknown'
        : `${agentDir.entries.length}${agentDir.entriesTruncated ? '+' : ''} entr${agentDir.entries.length === 1 ? 'y' : 'ies'}`
      : null;
  return (
    <div data-testid="bootstrap-path-summary" className="rounded-lg border border-muted bg-card/40 px-3 py-1">
      <PathRow label="Compose stacks directory" path={composeDir} created={!composeDir.exists} extra={stackDetail} />
      <PathRow label="Pilot Agent installation directory" path={agentDir} created={!agentDir.exists} extra={agentDetail} />
    </div>
  );
}
