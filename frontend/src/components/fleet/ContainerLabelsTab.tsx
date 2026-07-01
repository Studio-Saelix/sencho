import { useCallback, useEffect, useMemo, useState, Fragment } from 'react';
import { ChevronDown, ChevronRight, ExternalLink, Lock, RefreshCw, Search } from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { toast } from '@/components/ui/toast-store';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { useAuth } from '@/context/AuthContext';
import {
  LABEL_DISAMBIGUATION_COPY,
  SOURCE_LABELS,
  type ContainerLabelRow,
  type FleetLabelInventoryResponse,
  type LabelIndexRow,
  type LabelValue,
} from '@/lib/labelInventory';

type ViewMode = 'container' | 'label';

interface ContainerLabelsTabProps {
  onNavigateToNode: (nodeId: number, stackName: string) => void;
}

function LabelValueCell({ label, onReveal }: { label: LabelValue; onReveal?: () => void }) {
  const { isAdmin } = useAuth();
  return (
    <span className="inline-flex items-center gap-1 font-mono text-xs text-foreground/90">
      {label.redacted && <Lock className="h-3 w-3 text-stat-subtitle" strokeWidth={1.5} />}
      <span>{label.value}</span>
      {label.redacted && isAdmin && onReveal && (
        <button
          type="button"
          onClick={onReveal}
          className="font-mono text-[10px] uppercase tracking-wide text-brand hover:underline"
        >
          Reveal
        </button>
      )}
    </span>
  );
}

function matchesSearch(q: string, ...parts: (string | null | undefined)[]): boolean {
  if (!q) return true;
  const needle = q.toLowerCase();
  return parts.some(p => (p ?? '').toLowerCase().includes(needle));
}

export function ContainerLabelsTab({ onNavigateToNode }: ContainerLabelsTabProps) {
  const { isAdmin } = useAuth();
  const [viewMode, setViewMode] = useState<ViewMode>('container');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [revealSecrets, setRevealSecrets] = useState(false);
  const [data, setData] = useState<FleetLabelInventoryResponse | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const fetchInventory = useCallback(async (reveal = revealSecrets) => {
    setLoading(true);
    try {
      const qs = reveal ? '?reveal=1' : '';
      const res = await apiFetch(`/fleet/container-labels${qs}`, { localOnly: true });
      if (!res.ok) throw new Error('Failed to load Docker label audit');
      setData(await res.json() as FleetLabelInventoryResponse);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to load Docker label audit';
      toast.error(msg);
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [revealSecrets]);

  useEffect(() => {
    void fetchInventory();
  }, [fetchInventory]);

  const allContainers = useMemo(() => {
    if (!data) return [] as Array<ContainerLabelRow & { nodeId: number; nodeName: string }>;
    const rows: Array<ContainerLabelRow & { nodeId: number; nodeName: string }> = [];
    for (const node of data.nodes) {
      if (node.status !== 'ok' || !node.inventory) continue;
      for (const c of node.inventory.containers) {
        rows.push({ ...c, nodeId: node.nodeId, nodeName: node.nodeName });
      }
    }
    return rows;
  }, [data]);

  const filteredContainers = useMemo(() => {
    const q = search.trim();
    return allContainers.filter(c =>
      matchesSearch(q, c.name, c.stack, c.service, c.state, c.nodeName)
      || c.labels.some(l => matchesSearch(q, l.key, l.value)),
    );
  }, [allContainers, search]);

  const filteredByLabel = useMemo(() => {
    const q = search.trim();
    const source = data?.aggregatedByLabel ?? [];
    return source.filter(row =>
      matchesSearch(q, row.key, row.value)
      || row.containers.some(c => matchesSearch(q, c.name, c.stack, c.nodeName)),
    );
  }, [data, search]);

  // Nodes that were unreachable (nodeErrors) or whose inventory came back partial (some
  // containers or images could not be inspected). Named so the warning is truthful.
  const degradedNodes = useMemo(() => {
    const unreachable: string[] = [];
    const partial: string[] = [];
    if (data) {
      const nameById = new Map(data.nodes.map(n => [n.nodeId, n.nodeName] as const));
      for (const idStr of Object.keys(data.nodeErrors)) {
        unreachable.push(nameById.get(Number(idStr)) ?? `node ${idStr}`);
      }
      for (const n of data.nodes) {
        if (n.status === 'ok' && n.inventory?.partial) partial.push(n.nodeName);
      }
    }
    return { unreachable, partial };
  }, [data]);

  const toggleExpanded = (id: string) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleReveal = () => {
    setRevealSecrets(true);
    void fetchInventory(true);
  };

  return (
    <div className="space-y-4" data-testid="container-labels-tab">
      <p className="text-xs text-stat-subtitle leading-relaxed max-w-3xl">{LABEL_DISAMBIGUATION_COPY}</p>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-stat-subtitle">Docker label audit</p>
          <SegmentedControl
            className="mt-2"
            value={viewMode}
            onChange={(v) => setViewMode(v as ViewMode)}
            options={[
              { value: 'container', label: 'By container' },
              { value: 'label', label: 'By label' },
            ]}
          />
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" strokeWidth={1.5} />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Filter labels, containers, stacks..."
              className="h-9 w-56 pl-8 max-md:w-full"
            />
          </div>
          <Button variant="outline" size="sm" className="h-9 w-9 p-0" onClick={() => void fetchInventory()} disabled={loading} aria-label="Refresh">
            <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
          </Button>
        </div>
      </div>

      {loading && !data && (
        <p className="text-sm text-stat-subtitle">Loading Docker label audit...</p>
      )}

      {!loading && data && (degradedNodes.unreachable.length > 0 || degradedNodes.partial.length > 0) && (
        <p className="text-xs text-warning">
          {degradedNodes.unreachable.length > 0 && `Could not reach ${degradedNodes.unreachable.join(', ')}. `}
          {degradedNodes.partial.length > 0 && `Some containers or images could not be inspected on ${degradedNodes.partial.join(', ')}. `}
          Showing partial fleet data.
        </p>
      )}

      {viewMode === 'container' && (
        <div className="rounded-lg border border-card-border border-t-card-border-top bg-card shadow-card-bevel overflow-hidden max-md:overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-8" />
                <TableHead>Container</TableHead>
                <TableHead>Stack</TableHead>
                <TableHead>Node</TableHead>
                <TableHead>State</TableHead>
                <TableHead className="text-right">Labels</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredContainers.map((c) => {
                const rowKey = `${c.nodeId}:${c.id}`;
                const isOpen = expanded.has(rowKey);
                return (
                  <Fragment key={rowKey}>
                    <TableRow className="hover:bg-muted/30">
                      <TableCell>
                        <button type="button" onClick={() => toggleExpanded(rowKey)} className="text-muted-foreground">
                          {isOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                        </button>
                      </TableCell>
                      <TableCell className="font-mono text-xs">{c.name || c.id.slice(0, 12)}</TableCell>
                      <TableCell className="text-xs">{c.stack ?? '—'}</TableCell>
                      <TableCell className="text-xs">{c.nodeName}</TableCell>
                      <TableCell className="text-xs">{c.state}</TableCell>
                      <TableCell className="text-right text-xs tabular-nums">{c.labels.length}</TableCell>
                      <TableCell className="text-right">
                        {c.stack && (
                          <Button variant="ghost" size="sm" className="h-7 text-[10px]" onClick={() => onNavigateToNode(c.nodeId, c.stack!)}>
                            <ExternalLink className="h-3 w-3 mr-1" /> Open stack
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                    {isOpen && (
                      <TableRow key={`${rowKey}-detail`}>
                        <TableCell colSpan={7} className="bg-card/40 p-0">
                          <Table>
                            <TableBody>
                              {c.labels.map((label) => (
                                <TableRow key={`${rowKey}-${label.key}`}>
                                  <TableCell className="font-mono text-xs text-muted-foreground w-[40%]">{label.key}</TableCell>
                                  <TableCell>
                                    <LabelValueCell label={label} onReveal={isAdmin && !revealSecrets ? handleReveal : undefined} />
                                  </TableCell>
                                  <TableCell className="text-[10px] text-stat-subtitle">{SOURCE_LABELS[label.source]}</TableCell>
                                </TableRow>
                              ))}
                              {c.labels.length === 0 && (
                                <TableRow>
                                  <TableCell colSpan={3} className="text-xs text-stat-subtitle py-3">No labels on this container.</TableCell>
                                </TableRow>
                              )}
                            </TableBody>
                          </Table>
                        </TableCell>
                      </TableRow>
                    )}
                  </Fragment>
                );
              })}
              {filteredContainers.length === 0 && !loading && (
                <TableRow>
                  <TableCell colSpan={7} className="text-sm text-stat-subtitle py-6 text-center">No containers match this filter.</TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      )}

      {viewMode === 'label' && (
        <div className="space-y-3">
          {filteredByLabel.map((row) => (
            <LabelGroupCard key={`${row.key}=${row.value}=${row.source}`} row={row} onReveal={isAdmin && !revealSecrets ? handleReveal : undefined} onNavigateToNode={onNavigateToNode} />
          ))}
          {filteredByLabel.length === 0 && !loading && (
            <p className="text-sm text-stat-subtitle py-4 text-center">No labels match this filter.</p>
          )}
        </div>
      )}

      <p className="text-[10px] text-stat-subtitle leading-relaxed max-w-3xl">
        Runtime labels are static until the container is recreated. Changes in Compose require save and redeploy.
      </p>
    </div>
  );
}

function LabelGroupCard({
  row,
  onReveal,
  onNavigateToNode,
}: {
  row: LabelIndexRow;
  onReveal?: () => void;
  onNavigateToNode: (nodeId: number, stackName: string) => void;
}) {
  return (
    <div className="rounded-lg border border-card-border bg-card/40 p-3">
      <div className="flex flex-wrap items-center gap-2 mb-2">
        <span className="font-mono text-xs font-medium">{row.key}</span>
        <span className="text-muted-foreground">=</span>
        <LabelValueCell label={{ key: row.key, value: row.value, source: row.source, redacted: row.redacted }} onReveal={onReveal} />
        <Badge variant="outline" className="text-[10px]">{SOURCE_LABELS[row.source]}</Badge>
      </div>
      <ul className="space-y-1">
        {row.containers.map((c) => (
          <li key={`${c.nodeId ?? 'local'}:${c.id}`} className="flex flex-wrap items-center gap-2 text-xs text-stat-subtitle">
            <span className="font-mono text-foreground/80">{c.name}</span>
            {c.nodeName && <Badge variant="secondary" className="text-[10px] h-5">{c.nodeName}</Badge>}
            {c.stack && (
              <>
                <span>· {c.stack}</span>
                {c.nodeId !== undefined && (
                  <button
                    type="button"
                    className="text-brand hover:underline font-mono text-[10px] uppercase"
                    onClick={() => onNavigateToNode(c.nodeId!, c.stack!)}
                  >
                    Open stack
                  </button>
                )}
              </>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
