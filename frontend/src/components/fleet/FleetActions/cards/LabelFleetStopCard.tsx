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
  reachable: boolean;
  matched: boolean;
  stackResults: NodeStackResult[];
  error?: string;
}

// Stop-by-label targets stack labels only. The `scope: 'stack'` tag keeps node
// labels (a separate namespace) from ever being fed into this destructive card,
// and the counts make the stack scope tangible in the picker. `nodes` lists the
// nodes that carry the label so the operator can see the spread before acting.
interface FleetStopLabelSuggestion { name: string; scope: 'stack'; nodeCount: number; stackCount: number; nodes: string[] }

interface MatchPreviewNode { nodeId: number; nodeName: string; reachable: boolean; labelExists: boolean; stackCount: number; stackNames: string[]; error?: string }
interface MatchPreviewResponse { matchedNodes: number; matchedStacks: number; unreachableNodes: number; perNode: MatchPreviewNode[] }

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
  // `nodes` is tolerated as absent (coerced to [] at render) so a suggestion is
  // never dropped over a missing optional detail field.
  const nodesOk = s.nodes === undefined
    || (Array.isArray(s.nodes) && s.nodes.every(n => typeof n === 'string'));
  return typeof s.name === 'string' && s.scope === 'stack'
    && typeof s.nodeCount === 'number' && typeof s.stackCount === 'number' && nodesOk;
}

// The preview section renders `perNode` (filter/some/flatMap) outside any
// try/catch, so a malformed success body would throw during render rather than
// degrade. Validate the load-bearing shape before trusting it; anything off
// falls to the "unavailable" state.
function isMatchPreviewResponse(value: unknown): value is MatchPreviewResponse {
  if (typeof value !== 'object' || value === null) return false;
  const d = value as Record<string, unknown>;
  if (typeof d.matchedNodes !== 'number' || typeof d.matchedStacks !== 'number') return false;
  if (!Array.isArray(d.perNode)) return false;
  return d.perNode.every((n) => {
    if (typeof n !== 'object' || n === null) return false;
    const node = n as Record<string, unknown>;
    return typeof node.nodeId === 'number'
      && typeof node.nodeName === 'string'
      && typeof node.reachable === 'boolean'
      && typeof node.stackCount === 'number'
      && Array.isArray(node.stackNames);
  });
}

export function LabelFleetStopCard() {
  const [labelName, setLabelName] = useState('');
  const [suggestions, setSuggestions] = useState<FleetStopLabelSuggestion[]>([]);
  const [suggestUnreachable, setSuggestUnreachable] = useState(0);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<ResultRow[]>([]);
  const [preview, setPreview] = useState<PreviewState>({ kind: 'idle' });

  // Stack-label suggestions for the target picker. The fleet endpoint queries
  // every node authoritatively (local DB + live remote reads), so node labels
  // can never appear here and remote-only stack labels do. `unreachableNodes`
  // flags that the counts cover only the nodes Sencho could reach. A non-ok or
  // malformed response leaves the list empty rather than crashing: the Actions
  // tab renders without an admin gate while the endpoint is admin-only, so a
  // viewer simply gets no suggestions and can still type a name by hand.
  useEffect(() => {
    let cancelled = false;
    async function loadSuggestions() {
      try {
        const res = await apiFetch('/fleet/labels/suggestions');
        const data = res.ok ? await res.json().catch(() => null) : null;
        const list = Array.isArray(data?.suggestions) ? data.suggestions.filter(isSuggestion) : [];
        if (!cancelled) {
          setSuggestions(list);
          setSuggestUnreachable(typeof data?.unreachableNodes === 'number' ? data.unreachableNodes : 0);
        }
      } catch {
        if (!cancelled) { setSuggestions([]); setSuggestUnreachable(0); }
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
        const data = await res.json().catch(() => null);
        if (!isMatchPreviewResponse(data)) {
          // A 200 with a shape we can't render is a server/contract bug, not a
          // transport miss; log it like the catch path so it's diagnosable.
          console.error('[FleetStop] match-preview returned a malformed body', data);
          setPreview({ kind: 'unavailable' });
          return;
        }
        setPreview({ kind: 'ready', data });
      } catch (err) {
        // Non-destructive readout: the operator can still type a name and run the
        // stop, so we degrade to "unavailable" rather than toasting, but leave a
        // console trail so a recurring preview failure is diagnosable.
        console.error('[FleetStop] match-preview failed', err);
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
      const { matchedNodes, matchedStacks, unreachableNodes } = preview.data;
      if (matchedStacks === 0 || matchedNodes === 0) {
        return unreachableNodes > 0 ? `0 reachable · ${unreachableNodes} unreachable` : '0 matching stacks';
      }
      const suffix = unreachableNodes > 0 ? ` · ${unreachableNodes} unreachable` : '';
      return `${matchedStacks} stacks · ${matchedNodes} nodes${suffix}`;
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
      // A 200 with a non-array `results` is a server/contract bug, not an empty
      // fleet: don't let it masquerade as the legitimate "No reachable nodes"
      // outcome (a valid empty array below still reports that honestly). Log it
      // and tell the operator it was unexpected. A node's `stackResults` is
      // guarded per node further down so one bad node never nukes the readout.
      if (!Array.isArray(body.results)) {
        console.error('[FleetStop] fleet-stop returned a malformed body', body);
        toast.error('Fleet stop returned an unexpected response. Check the server logs and retry.');
        return;
      }
      const apiResults = body.results as FleetStopNodeResult[];
      const rows: ResultRow[] = apiResults.map((node) => {
        if (!node.reachable) {
          return {
            key: `node-${node.nodeId}`,
            label: `${node.nodeName} (unreachable)`,
            success: false,
            error: node.error || 'Node unreachable',
            sub: [],
          };
        }
        const stackResults = Array.isArray(node.stackResults) ? node.stackResults : [];
        return {
          key: `node-${node.nodeId}`,
          label: node.matched
            ? `${node.nodeName} · ${stackResults.length} stack${stackResults.length === 1 ? '' : 's'}${opts.dryRun ? ' (dry run)' : ''}`
            : `${node.nodeName} (no matching stack label)`,
          success: node.matched && stackResults.every(s => s.success),
          error: node.matched ? undefined : 'Stack label not present',
          sub: stackResults.map((s, i) => ({
            key: `${node.nodeId}-${s.stackName}-${i}`,
            label: s.stackName,
            success: s.success,
            error: s.error,
          })),
        };
      });
      setResults(rows);
      const reachable = apiResults.filter(n => n.reachable);
      const unreachableCount = apiResults.length - reachable.length;
      const matchedNodes = reachable.filter(n => n.matched).length;
      const stacksTouched = apiResults.flatMap(n => Array.isArray(n.stackResults) ? n.stackResults : []);
      const ok = stacksTouched.filter(s => s.success).length;
      const failed = stacksTouched.length - ok;
      const unreachableSuffix = unreachableCount > 0 ? ` ${unreachableCount} node${unreachableCount === 1 ? '' : 's'} unreachable.` : '';
      if (matchedNodes === 0) {
        if (reachable.length === 0) toast.warning(`No reachable nodes.${unreachableSuffix}`);
        else toast.info(`No reachable node carries a stack label by that name.${unreachableSuffix}`);
      }
      else if (opts.dryRun) toast.success(`Dry run: would stop ${ok} stack${ok === 1 ? '' : 's'} across ${matchedNodes} node${matchedNodes === 1 ? '' : 's'}.${unreachableSuffix}`);
      else if (failed === 0 && ok > 0) toast.success(`Stopped ${ok} stack${ok === 1 ? '' : 's'} across ${matchedNodes} node${matchedNodes === 1 ? '' : 's'}.${unreachableSuffix}`);
      else if (ok === 0 && failed === 0) toast.info(`Stack label matched but no stacks were assigned to it.${unreachableSuffix}`);
      else toast.warning(`${ok} stopped, ${failed} failed. See results below.${unreachableSuffix}`);
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
            Stops every stack assigned this stack label on every reachable node across the fleet. Node labels are not used by this action.
          </p>
          {suggestUnreachable > 0 && (
            <p className={cn(KICKER, 'text-stat-icon mb-2 normal-case tracking-normal text-[11px]')}>
              {suggestUnreachable} node{suggestUnreachable === 1 ? '' : 's'} unreachable; suggestions may be incomplete.
            </p>
          )}
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
        description="Sencho will stop every stack assigned this stack label on every reachable node at execution time. Node labels are not used by this action. Services will be unavailable until restarted."
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
    const { matchedStacks, matchedNodes, unreachableNodes, perNode } = preview.data;
    const unreachable = perNode.filter(n => !n.reachable);
    const matchingNodes = perNode.filter(n => n.reachable && n.stackCount > 0);
    if (matchedStacks === 0) {
      // Distinguish "label exists but no stacks" from "no such label", and still
      // surface unreachable nodes so a 0-count never hides a node we could not ask.
      const labelExistsSomewhere = perNode.some(n => n.reachable && n.labelExists);
      const message = labelExistsSomewhere
        ? 'This stack label exists but has no stacks assigned on the reachable nodes'
        : 'No reachable node carries a stack label by that name';
      return (
        <SheetSection title="Preview" meta={unreachableNodes > 0 ? `${unreachableNodes} unreachable` : '0 stacks'}>
          <div className={cn(KICKER, 'text-stat-icon normal-case tracking-normal text-[11px]')}>{message}</div>
          {unreachable.length > 0 && <UnreachableList nodes={unreachable} />}
        </SheetSection>
      );
    }
    const meta = `across ${matchedNodes} node${matchedNodes === 1 ? '' : 's'}${unreachableNodes > 0 ? ` · ${unreachableNodes} unreachable` : ''}`;
    return (
      <SheetSection
        title={`Preview · ${matchedStacks} stack${matchedStacks === 1 ? '' : 's'}`}
        meta={meta}
      >
        <PreviewWell perNode={matchingNodes} />
        {unreachable.length > 0 && <UnreachableList nodes={unreachable} />}
      </SheetSection>
    );
  }
  return null;
}

// Muted list of nodes Sencho could not query, shown beneath the preview so a
// partial blast radius is observable rather than silently dropped.
function UnreachableList({ nodes }: { nodes: MatchPreviewNode[] }) {
  return (
    <div className="mt-2 rounded border border-card-border/60 bg-card/40 p-2">
      <div className={cn(KICKER, 'text-stat-icon mb-1')}>unreachable · {nodes.length}</div>
      <ul className="space-y-1">
        {nodes.map(n => (
          <li key={n.nodeId} className="flex items-center gap-2">
            <span className="flex-1 min-w-0 truncate font-mono text-[11px] text-stat-subtitle">{n.nodeName}</span>
            {n.error && <span className={cn(KICKER, 'shrink-0 max-w-[55%] truncate text-stat-icon')}>{n.error}</span>}
          </li>
        ))}
      </ul>
    </div>
  );
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
            {filtered.map((s) => {
              const nodes = s.nodes ?? [];
              return (
              <li key={s.name}>
                <button
                  type="button"
                  // mousedown + preventDefault keeps the input focused so the
                  // selection registers before any blur-driven close fires.
                  onMouseDown={(e) => { e.preventDefault(); handleSelect(s.name); }}
                  title={nodes.join(', ')}
                  className="flex w-full flex-col gap-0.5 rounded-sm px-2 py-1.5 font-mono text-xs text-stat-value hover:bg-accent hover:text-accent-foreground"
                >
                  <span className="flex w-full items-center gap-2">
                    <span className="flex-1 min-w-0 truncate text-left">{s.name}</span>
                    <span className="shrink-0 text-[10px] text-stat-subtitle">
                      {s.stackCount} stack{s.stackCount === 1 ? '' : 's'} · {s.nodeCount} node{s.nodeCount === 1 ? '' : 's'}
                    </span>
                  </span>
                  {nodes.length > 0 && (
                    <span className="w-full truncate text-left text-[10px] text-stat-icon">{nodes.join(', ')}</span>
                  )}
                </button>
              </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
