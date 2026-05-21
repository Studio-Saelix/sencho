import { useEffect, useMemo, useRef, useState } from 'react';
import { ConfirmModal } from '@/components/ui/modal';
import { Input } from '@/components/ui/input';
import { FleetActionCard } from '@/components/ui/fleet-action-card';
import { SheetSection } from '@/components/ui/system-sheet';
import { apiFetch, fetchForNode } from '@/lib/api';
import { toast } from '@/components/ui/toast-store';
import { cn } from '@/lib/utils';
import type { FleetNode } from '@/components/FleetView/types';
import type { Label } from '@/components/label-types';
import { ResultsList, type ResultRow } from '../ResultsList';

interface NodeStackResult { stackName: string; success: boolean; error?: string; dryRun?: boolean }
interface FleetStopNodeResult {
  nodeId: number;
  nodeName: string;
  matched: boolean;
  stackResults: NodeStackResult[];
}

interface MatchPreviewNode { nodeId: number; nodeName: string; stackCount: number; stackNames: string[] }
interface MatchPreviewResponse { matchedNodes: number; matchedStacks: number; perNode: MatchPreviewNode[] }

type PreviewState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'unavailable' }
  | { kind: 'ready'; data: MatchPreviewResponse };

interface Props {
  nodes: FleetNode[];
}

const KICKER = 'font-mono text-[10px] uppercase tracking-[0.18em]';
const PREVIEW_ROW_LIMIT = 6;

export function LabelFleetStopCard({ nodes }: Props) {
  const [labelName, setLabelName] = useState('');
  const [knownLabelNames, setKnownLabelNames] = useState<string[]>([]);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<ResultRow[]>([]);
  const [preview, setPreview] = useState<PreviewState>({ kind: 'idle' });

  // Aggregate label names across reachable nodes for autocomplete.
  useEffect(() => {
    let cancelled = false;
    async function loadSuggestions() {
      const names = new Set<string>();
      const reachable = nodes.filter(n => n.status === 'online');
      await Promise.all(reachable.map(async (node) => {
        try {
          const res = await fetchForNode('/labels', node.id);
          if (!res.ok) return;
          const list = (await res.json()) as Label[];
          for (const l of list) names.add(l.name);
        } catch {
          /* unreachable node, not user-facing */
        }
      }));
      if (!cancelled) setKnownLabelNames(Array.from(names).sort());
    }
    loadSuggestions();
    return () => { cancelled = true; };
  }, [nodes]);

  // Debounced live preview. The blast-radius readout and the preview section
  // both read from the same state.
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const trimmed = labelName.trim();
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (trimmed.length === 0) {
      setPreview({ kind: 'idle' });
      return;
    }
    setPreview({ kind: 'loading' });
    debounceRef.current = setTimeout(async () => {
      try {
        const res = await apiFetch('/fleet/labels/match-preview', {
          method: 'POST',
          body: JSON.stringify({ labelName: trimmed }),
        });
        if (res.status === 404) {
          setPreview({ kind: 'unavailable' });
          return;
        }
        if (!res.ok) {
          setPreview({ kind: 'unavailable' });
          return;
        }
        const data = (await res.json()) as MatchPreviewResponse;
        setPreview({ kind: 'ready', data });
      } catch {
        setPreview({ kind: 'unavailable' });
      }
    }, 500);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [labelName]);

  const blastValue = useMemo(() => {
    const trimmed = labelName.trim();
    if (trimmed.length === 0) return 'awaiting target';
    if (preview.kind === 'loading') return 'resolving…';
    if (preview.kind === 'unavailable') return 'preview unavailable';
    if (preview.kind === 'ready') {
      const { matchedNodes, matchedStacks } = preview.data;
      if (matchedStacks === 0 || matchedNodes === 0) return '0 nodes match';
      return `${matchedStacks} stacks · ${matchedNodes} nodes`;
    }
    return 'awaiting target';
  }, [labelName, preview]);

  const blastTone = preview.kind === 'loading' || preview.kind === 'unavailable' ? 'muted' as const : undefined;

  async function run(opts: { dryRun: boolean }) {
    const trimmed = labelName.trim();
    if (!trimmed) return;
    const verb = opts.dryRun ? 'Dry-running' : 'Stopping';
    const toastId = toast.loading(`${verb} stacks labeled "${trimmed}" across the fleet…`);
    setRunning(true);
    setResults([]);
    try {
      const res = await apiFetch('/fleet/labels/fleet-stop', {
        method: 'POST',
        body: JSON.stringify({ labelName: trimmed, dryRun: opts.dryRun }),
      });
      const body = await res.json().catch(() => ({}));
      toast.dismiss(toastId);
      if (!res.ok) {
        toast.error(body.error || 'Fleet stop failed');
        return;
      }
      const apiResults = (body.results as FleetStopNodeResult[]) ?? [];
      const rows: ResultRow[] = apiResults.map((node) => ({
        key: `node-${node.nodeId}`,
        label: node.matched
          ? `${node.nodeName} · ${node.stackResults.length} stack${node.stackResults.length === 1 ? '' : 's'}${opts.dryRun ? ' (dry run)' : ''}`
          : `${node.nodeName} (no matching label)`,
        success: node.matched && node.stackResults.every(s => s.success),
        error: node.matched ? undefined : 'Label not present',
        sub: node.stackResults.map((s, i) => ({
          key: `${node.nodeId}-${s.stackName}-${i}`,
          label: s.stackName,
          success: s.success,
          error: s.error,
        })),
      }));
      setResults(rows);
      const matchedNodes = apiResults.filter(n => n.matched).length;
      const stacksTouched = apiResults.flatMap(n => n.stackResults);
      const ok = stacksTouched.filter(s => s.success).length;
      const failed = stacksTouched.length - ok;
      if (matchedNodes === 0) toast.info('No nodes have a label by that name.');
      else if (opts.dryRun) toast.success(`Dry run: would stop ${ok} stack${ok === 1 ? '' : 's'} across ${matchedNodes} node${matchedNodes === 1 ? '' : 's'}.`);
      else if (failed === 0 && ok > 0) toast.success(`Stopped ${ok} stack${ok === 1 ? '' : 's'} across ${matchedNodes} node${matchedNodes === 1 ? '' : 's'}.`);
      else if (ok === 0 && failed === 0) toast.info('Label matched but no stacks were assigned to it.');
      else toast.warning(`${ok} stopped, ${failed} failed. See results below.`);
    } catch (err) {
      toast.dismiss(toastId);
      toast.error(err instanceof Error ? err.message : 'Network error');
    } finally {
      setRunning(false);
      setConfirmOpen(false);
    }
  }

  const trimmed = labelName.trim();
  const previewSection = renderPreviewSection(preview, trimmed);

  // Freshness placeholder: until a run-record store exists, the footer carries
  // reversibility alone. Add freshness once a /fleet/labels/last-fleet-stop
  // endpoint or equivalent ships.
  // TODO(freshness): emit "last fleet-stop {age}" once the run-record source lands.
  const footerContext = 'Reversible · no';

  return (
    <>
      <FleetActionCard
        crumb={['Fleet', 'Actions', 'Stop by label']}
        name="Stop by label."
        meta="label-match · per-node fan-out · reports per-stack results"
        actionClass="destructive"
        blastRadius={{ value: blastValue, tone: blastTone }}
        secondaryAction={{
          label: running ? 'Running…' : 'Dry run',
          onClick: () => run({ dryRun: true }),
          disabled: running || trimmed.length === 0,
        }}
        primaryAction={{
          label: 'Stop fleet',
          onClick: () => setConfirmOpen(true),
          variant: 'destructive',
          disabled: running || trimmed.length === 0,
        }}
        footerContext={footerContext}
      >
        <SheetSection
          title="Label · target"
          meta={`auto-suggested · ${knownLabelNames.length} known`}
        >
          <Input
            id="fleet-stop-label-input"
            list="fleet-stop-label-suggestions"
            value={labelName}
            onChange={(e) => setLabelName(e.target.value)}
            placeholder="e.g. production"
            className="h-9 text-sm"
            disabled={running}
          />
          <datalist id="fleet-stop-label-suggestions">
            {knownLabelNames.map(n => <option key={n} value={n} />)}
          </datalist>
        </SheetSection>

        {previewSection}

        {results.length > 0 && (
          <SheetSection title="Per-node breakdown">
            <ResultsList results={results} />
          </SheetSection>
        )}
      </FleetActionCard>

      <ConfirmModal
        open={confirmOpen}
        onOpenChange={(open) => { if (!open) setConfirmOpen(false); }}
        variant="destructive"
        kicker="Fleet stop"
        title={`Stop all stacks labeled "${trimmed}"?`}
        description="Sencho will stop every stack on every node that has a label with this name. Services will be unavailable until restarted."
        confirmLabel="Stop fleet"
        confirming={running}
        onConfirm={() => run({ dryRun: false })}
      />
    </>
  );
}

function renderPreviewSection(preview: PreviewState, trimmed: string) {
  if (trimmed.length === 0) return null;
  if (preview.kind === 'loading') {
    return (
      <SheetSection title="Preview" meta="resolving…">
        <div className={cn(KICKER, 'text-stat-icon')}>looking up label across the fleet</div>
      </SheetSection>
    );
  }
  if (preview.kind === 'unavailable') {
    return (
      <SheetSection title="Preview" meta="unavailable">
        <div className={cn(KICKER, 'text-stat-icon')}>preview endpoint did not respond</div>
      </SheetSection>
    );
  }
  if (preview.kind === 'ready') {
    const { matchedStacks, matchedNodes, perNode } = preview.data;
    if (matchedStacks === 0) {
      return (
        <SheetSection title="Preview" meta="0 stacks">
          <div className={cn(KICKER, 'text-stat-icon')}>no node has a label by that name</div>
        </SheetSection>
      );
    }
    return (
      <SheetSection
        title={`Preview · ${matchedStacks} stack${matchedStacks === 1 ? '' : 's'}`}
        meta={`across ${matchedNodes} node${matchedNodes === 1 ? '' : 's'}`}
      >
        <PreviewWell perNode={perNode} />
      </SheetSection>
    );
  }
  return null;
}

interface PreviewWellProps {
  perNode: MatchPreviewNode[];
}

function PreviewWell({ perNode }: PreviewWellProps) {
  const flat = perNode.flatMap(n => n.stackNames.map(s => ({ stack: s, node: n.nodeName })));
  const visible = flat.slice(0, PREVIEW_ROW_LIMIT);
  const remaining = flat.length - visible.length;
  const remainingNodes = remaining > 0
    ? new Set(flat.slice(PREVIEW_ROW_LIMIT).map(r => r.node)).size
    : 0;
  return (
    <div className="rounded border border-card-border/60 bg-card/40 shadow-[inset_0_2px_4px_0_oklch(0_0_0_/_0.35)] p-2">
      <ul className="space-y-1">
        {visible.map((row, i) => (
          <li key={`${row.node}-${row.stack}-${i}`} className="flex items-center gap-2">
            <span className={cn(KICKER, 'inline-flex items-center px-1 py-0.5 rounded-sm border border-success/40 bg-success/10 text-success shrink-0')}>
              UP
            </span>
            <span className="flex-1 min-w-0 truncate font-mono text-[11px] text-stat-value">{row.stack}</span>
            <span className={cn(KICKER, 'shrink-0 text-stat-subtitle')}>{row.node}</span>
          </li>
        ))}
        {remaining > 0 && (
          <li className={cn(KICKER, 'text-stat-icon pt-1')}>
            + {remaining} more across {remainingNodes} node{remainingNodes === 1 ? '' : 's'}
          </li>
        )}
      </ul>
    </div>
  );
}
