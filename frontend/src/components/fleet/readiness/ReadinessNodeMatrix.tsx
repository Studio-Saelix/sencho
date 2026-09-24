import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { cn } from '@/lib/utils';
import { formatAgeShort } from '@/lib/relativeTime';
import type { FleetReadinessNode, ReadinessDomainKey, ReadinessFinding } from '@/types/readiness';
import { TONE_CHIP, TONE_DOT, TONE_ROW, cellValue, domainMeta, stateMeta } from '../readinessMeta';

const HEAD = 'text-[10px] uppercase tracking-[0.18em]';

const TRANSPORT_LABEL: Record<FleetReadinessNode['transport'], string> = {
  local: 'local',
  proxy: 'proxy',
  pilot: 'pilot',
  unreachable: 'no route',
};

function nodeSubline(node: FleetReadinessNode, now: number): string {
  const parts = [TRANSPORT_LABEL[node.transport] ?? node.transport];
  if (node.stackCount !== null) parts.push(`${node.stackCount} ${node.stackCount === 1 ? 'stack' : 'stacks'}`);
  if (node.type === 'remote' && !node.reachability.probedLive && node.reachability.contactAt !== null) {
    parts.push(`seen ${formatAgeShort(now - node.reachability.contactAt)} ago`);
  }
  return parts.join(' · ');
}

interface MatrixCellProps {
  domain: ReadinessDomainKey;
  node: FleetReadinessNode;
  findings: readonly ReadinessFinding[];
  onFocus: (nodeId: number, domain: ReadinessDomainKey) => void;
}

function MatrixCell({ domain, node, findings, onFocus }: MatrixCellProps) {
  const cell = node.cells[domain];
  if (!cell && domain === 'control') {
    // Policy sync does not push to this node (the hub itself, a Pilot-agent node,
    // or a remote without an API URL and token).
    return <span className="font-mono text-[11px] text-stat-icon" title="Does not apply to this node">--</span>;
  }
  if (!cell) {
    // Any other domain the payload promised but did not deliver is a gap in the
    // evidence, never a quiet cell.
    return (
      <span className={cn('inline-block rounded-md border px-1.5 py-0.5 font-mono text-[10px] leading-4', TONE_CHIP.neutral)}>
        not reported
      </span>
    );
  }
  const value = cellValue(domain, cell, node, findings);
  if (cell.state === 'healthy') {
    return (
      <span className="inline-flex items-center gap-1.5 font-mono text-[11px] text-stat-subtitle">
        <span aria-hidden className={cn('h-1.5 w-1.5 shrink-0 rounded-full', TONE_DOT.success)} />
        {value}
      </span>
    );
  }
  const meta = stateMeta(cell.state);
  return (
    <button
      type="button"
      onClick={() => onFocus(node.id, domain)}
      title={`${meta.label}: show the findings behind this`}
      className={cn(
        'inline-block max-w-full truncate rounded-md border px-1.5 py-0.5 font-mono text-[10px] leading-4 transition-colors hover:brightness-125',
        TONE_CHIP[meta.tone],
      )}
    >
      {value}
    </button>
  );
}

interface ReadinessNodeMatrixProps {
  domains: ReadinessDomainKey[];
  nodes: FleetReadinessNode[];
  findings: readonly ReadinessFinding[];
  now: number;
  onOpenNode: (nodeId: number) => void;
  /** Narrows the findings table to one node and domain. */
  onFocusCell: (nodeId: number, domain: ReadinessDomainKey) => void;
}

/**
 * One row per node, one column per domain, worst rows first (the hub sorts
 * them). A problem cell names its reason in the domain's own words and, when
 * clicked, narrows the findings table to itself (or to its node, when the cause
 * is reported once on Connectivity).
 */
export function ReadinessNodeMatrix({ domains, nodes, findings, now, onOpenNode, onFocusCell }: ReadinessNodeMatrixProps) {
  if (domains.length === 0) return null;

  return (
    <section aria-label="Readiness by node" className="space-y-2">
      <h3 className="font-mono text-[10px] leading-3 uppercase tracking-[0.18em] text-stat-subtitle">nodes</h3>
      <div className="overflow-hidden rounded-lg border border-card-border border-t-card-border-top bg-card shadow-card-bevel">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className={cn(HEAD, 'w-8')} aria-label="State" />
              <TableHead className={HEAD}>Node</TableHead>
              {domains.map(domain => {
                const meta = domainMeta(domain);
                const DomainIcon = meta.icon;
                return (
                  <TableHead key={domain} className={HEAD}>
                    <span className="inline-flex items-center gap-1.5">
                      <DomainIcon className="h-3.5 w-3.5" strokeWidth={1.5} />
                      {meta.label}
                    </span>
                  </TableHead>
                );
              })}
            </TableRow>
          </TableHeader>
          <TableBody>
            {nodes.map(node => {
              const state = stateMeta(node.state);
              return (
                <TableRow key={node.id} className={cn('transition-colors hover:bg-muted/30', TONE_ROW[state.tone])}>
                  <TableCell>
                    <span
                      aria-label={state.label}
                      role="img"
                      className={cn('inline-block h-2 w-2 rounded-full', TONE_DOT[state.tone])}
                    />
                  </TableCell>
                  <TableCell>
                    <div className="min-w-0 max-w-[220px]">
                      <button
                        type="button"
                        onClick={() => onOpenNode(node.id)}
                        className="block max-w-full truncate text-left font-mono text-xs hover:text-brand"
                      >
                        {node.name}
                      </button>
                      <span className="block truncate font-mono text-[10px] text-stat-subtitle">{nodeSubline(node, now)}</span>
                    </div>
                  </TableCell>
                  {domains.map(domain => (
                    <TableCell key={domain}>
                      <MatrixCell domain={domain} node={node} findings={findings} onFocus={onFocusCell} />
                    </TableCell>
                  ))}
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </section>
  );
}
