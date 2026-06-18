import { useEffect, useMemo, useRef, useState } from 'react';
import { ConfirmModal } from '@/components/ui/modal';
import { Input } from '@/components/ui/input';
import { FleetActionCard } from '@/components/ui/fleet-action-card';
import { SheetSection } from '@/components/ui/system-sheet';
import { apiFetch } from '@/lib/api';
import { toast } from '@/components/ui/toast-store';
import { cn } from '@/lib/utils';
import { ResultsList, type ResultRow } from '../ResultsList';

interface NodeStackResult { stackName: string; success: boolean; error?: string; dryRun?: boolean }
interface FleetStopNodeResult {
  nodeId: number;
  nodeName: string;
  matched: boolean;
  reachable?: boolean;
  error?: string;
  stackResults: NodeStackResult[];
}

// Stop-by-label targets stack labels only. The `scope: 'stack'` tag keeps node
// labels (a separate namespace) from ever being fed into this destructive card,
// and the counts make the stack scope tangible in the picker. `color` is the
// representative node-local color the fleet aggregate reports.
interface FleetStopLabelSuggestion { name: string; scope: 'stack'; color?: string; nodeCount: number; stackCount: number }

interface MatchPreviewNode { nodeId: number; nodeName: string; reachable?: boolean; error?: string; stackCount: number; stackNames: string[] }
interface MatchPreviewResponse { matchedNodes: number; matchedStacks: number; perNode: MatchPreviewNode[] }

type PreviewState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'unavailable' }
  | { kind: 'ready'; data: MatchPreviewResponse };

const KICKER = 'font-mono text-[10px] uppercase tracking-[0.18em]';
const PREVIEW_ROW_LIMIT = 6;

function isSuggestion(value: unknown): value is FleetStopLabelSuggestion {
  if (typeof value !== 'object' || value === null) return false;
  const s = value as Record<string, unknown>;
  return typeof s.name === 'string' && s.scope === 'stack'
    && typeof s.nodeCount === 'number' && typeof s.stackCount === 'number';
}

export function LabelFleetStopCard() {
  const [labelName, setLabelName] = useState('');
  const [suggestions, setSuggestions] = useState<FleetStopLabelSuggestion[]>([]);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<ResultRow[]>([]);
  const [preview, setPreview] = useState<PreviewState>({ kind: 'idle' });

  // Stack-label suggestions for the target picker. The fleet endpoint reads each
  // node's stack labels live (local in process, remotes over the proxy), so a
  // label that exists only on a reachable remote appears; offline remotes cannot
  // be queried and do not contribute, and node labels never appear here. A non-ok
  // or malformed response leaves the list empty rather than crashing: the Actions
  // tab renders without an admin gate while the endpoint is admin-only, so a
  // viewer simply gets no suggestions and can still type a name by hand.
  useEffect(() => {
    let cancelled = false;
    async function loadSuggestions() {
      try {
        const res = await apiFetch('/fleet/labels/suggestions');
        const data = res.ok ? await res.json().catch(() => null) : null;
        const list = Array.isArray(data?.suggestions) ? data.suggestions.filter(isSuggestion) : [];
        if (!cancelled) setSuggestions(list);
      } catch {
        if (!cancelled) setSuggestions([]);
      }
    }
    loadSuggestions();
    return () => { cancelled = true; };
  }, []);

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
      if (matchedStacks === 0 || matchedNodes === 0) return '0 matching stacks';
      return `${matchedStacks} stacks · ${matchedNodes} nodes`;
    }
    return 'awaiting target';
  }, [labelName, preview]);

  const blastTone = preview.kind === 'loading' || preview.kind === 'unavailable' ? 'muted' as const : undefined;

  async function run(opts: { dryRun: boolean }) {
    const trimmed = labelName.trim();
    if (!trimmed) return;
    const verb = opts.dryRun ? 'Dry-running' : 'Stopping';
    const toastId = toast.loading(`${verb} stacks with the stack label "${trimmed}" across the fleet…`);
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
      const rows: ResultRow[] = apiResults.map((node) => {
        const unreachable = node.reachable === false;
        return {
          key: `node-${node.nodeId}`,
          label: unreachable
            ? `${node.nodeName} (unreachable)`
            : node.matched
              ? `${node.nodeName} · ${node.stackResults.length} stack${node.stackResults.length === 1 ? '' : 's'}${opts.dryRun ? ' (dry run)' : ''}`
              : `${node.nodeName} (no matching stack label)`,
          success: !unreachable && node.matched && node.stackResults.every(s => s.success),
          error: unreachable ? (node.error || 'Node unreachable') : node.matched ? undefined : 'Stack label not present',
          sub: node.stackResults.map((s, i) => ({
            key: `${node.nodeId}-${s.stackName}-${i}`,
            label: s.stackName,
            success: s.success,
            error: s.error,
          })),
        };
      });
      setResults(rows);
      const matchedNodes = apiResults.filter(n => n.matched).length;
      const unreachableCount = apiResults.filter(n => n.reachable === false).length;
      const unreachableSuffix = unreachableCount > 0 ? `, ${unreachableCount} node${unreachableCount === 1 ? '' : 's'} unreachable` : '';
      const stacksTouched = apiResults.flatMap(n => n.stackResults);
      const ok = stacksTouched.filter(s => s.success).length;
      const failed = stacksTouched.length - ok;
      if (matchedNodes === 0 && unreachableCount === 0) toast.info('No node carries a stack label by that name.');
      else if (opts.dryRun) toast.success(`Dry run: would stop ${ok} stack${ok === 1 ? '' : 's'} across ${matchedNodes} node${matchedNodes === 1 ? '' : 's'}${unreachableSuffix}.`);
      else if (failed === 0 && ok > 0 && unreachableCount === 0) toast.success(`Stopped ${ok} stack${ok === 1 ? '' : 's'} across ${matchedNodes} node${matchedNodes === 1 ? '' : 's'}.`);
      else if (ok === 0 && failed === 0 && unreachableCount === 0) toast.info('Stack label matched but no stacks were assigned to it.');
      else toast.warning(`${ok} stopped, ${failed} failed${unreachableSuffix}. See results below.`);
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
          title="Stack label · target"
          meta={`stack labels · ${suggestions.length}`}
        >
          <p className={cn(KICKER, 'text-stat-subtitle mb-2 normal-case tracking-normal text-[11px]')}>
            Stops stacks assigned to this stack label across matching nodes. Node labels are not used by this action.
          </p>
          <LabelAutocomplete
            value={labelName}
            onChange={setLabelName}
            suggestions={suggestions}
            disabled={running}
            placeholder="e.g. production"
          />
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
        title={`Stop all stacks with the stack label "${trimmed}"?`}
        description="Sencho will stop every stack assigned this stack label on every node. Node labels are not used by this action. Services will be unavailable until restarted."
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
        <div className={cn(KICKER, 'text-stat-icon')}>looking up stack label across the fleet</div>
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
    const unreachable = perNode.filter(n => n.reachable === false);
    const unreachableNote = unreachable.length > 0 ? (
      <div className={cn(KICKER, 'text-stat-icon mt-2')}>
        {unreachable.length} node{unreachable.length === 1 ? '' : 's'} unreachable: {unreachable.map(n => n.nodeName).join(', ')}
      </div>
    ) : null;
    if (matchedStacks === 0) {
      return (
        <SheetSection title="Preview" meta="0 stacks">
          <div className={cn(KICKER, 'text-stat-icon')}>No stacks are assigned to this stack label</div>
          {unreachableNote}
        </SheetSection>
      );
    }
    return (
      <SheetSection
        title={`Preview · ${matchedStacks} stack${matchedStacks === 1 ? '' : 's'}`}
        meta={`across ${matchedNodes} node${matchedNodes === 1 ? '' : 's'}`}
      >
        <PreviewWell perNode={perNode} />
        {unreachableNote}
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

interface LabelAutocompleteProps {
  value: string;
  onChange: (next: string) => void;
  suggestions: FleetStopLabelSuggestion[];
  disabled?: boolean;
  placeholder?: string;
}

// Free-form text input with a Sencho-styled suggestion popover. Replaces the
// browser-native <datalist> so the dropdown matches the rest of the kit (same
// surface tokens as <Combobox>). Each suggestion is a stack label and carries
// its stack/node counts so the scope is unmistakable. The operator can still
// type a name that was not suggested; the server-side match-preview resolves it
// or reports 0 matching stacks.
function LabelAutocomplete({ value, onChange, suggestions, disabled, placeholder }: LabelAutocompleteProps) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

  const filtered = useMemo(() => {
    const q = value.trim().toLowerCase();
    if (q.length === 0) return suggestions;
    return suggestions.filter(s => s.name.toLowerCase().includes(q));
  }, [value, suggestions]);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

  const handleSelect = (next: string) => {
    onChange(next);
    setOpen(false);
  };

  return (
    <div ref={wrapperRef} className="relative">
      <Input
        id="fleet-stop-label-input"
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          if (!open) setOpen(true);
        }}
        onFocus={() => { if (!disabled) setOpen(true); }}
        placeholder={placeholder}
        className="h-9 text-sm"
        disabled={disabled}
        autoComplete="off"
        spellCheck={false}
      />
      {open && filtered.length > 0 && (
        <div className="absolute left-0 top-full mt-1 z-50 w-full rounded-md border border-glass-border bg-popover text-popover-foreground shadow-md backdrop-blur-[10px] backdrop-saturate-[1.15]">
          <ul className="max-h-[200px] overflow-y-auto overflow-x-hidden p-1">
            {filtered.map((s) => (
              <li key={s.name}>
                <button
                  type="button"
                  // mousedown + preventDefault keeps the input focused so the
                  // selection registers before any blur-driven close fires.
                  onMouseDown={(e) => { e.preventDefault(); handleSelect(s.name); }}
                  className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 font-mono text-xs text-stat-value hover:bg-accent hover:text-accent-foreground"
                >
                  <span className="flex-1 min-w-0 truncate text-left">{s.name}</span>
                  <span className="shrink-0 text-[10px] text-stat-subtitle">
                    {s.stackCount} stack{s.stackCount === 1 ? '' : 's'} · {s.nodeCount} node{s.nodeCount === 1 ? '' : 's'}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
