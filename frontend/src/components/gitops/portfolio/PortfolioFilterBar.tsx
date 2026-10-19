import { useEffect, useId, useRef, useState } from 'react';
import { Search, SlidersHorizontal, X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Combobox } from '@/components/ui/combobox';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import type { GitOpsPortfolioFilters } from '@/types/gitopsPortfolio';

interface NodeOption {
  id: number;
  name: string;
}

/**
 * Portfolio filter row.
 *
 * Same shape as the Fleet toolbar: a collapsible search affordance (square
 * outline button that expands into a focused input) followed by one Filters
 * popover that groups every filter into labelled sections, with a count badge
 * for what is active. The stack and Blueprint scopes set by other surfaces stay
 * visible as removable chips.
 *
 * Choices are server-side filters; narrowing a list is a question, never a
 * permission decision, and the summary/the queue above stay portfolio-wide.
 */

const ALL = 'all';

const ATTENTION_OPTIONS = [
  { value: ALL, label: 'All' },
  { value: 'attention', label: 'Attention required' },
];

const TARGET_OPTIONS = [
  { value: ALL, label: 'All' },
  { value: 'direct', label: 'Direct' },
  { value: 'blueprint', label: 'Blueprint' },
];

const DRIFT_OPTIONS = [
  { value: ALL, label: 'Any drift' },
  { value: 'source', label: 'Source drift' },
  { value: 'managed_project', label: 'Managed project drift' },
  { value: 'invocation', label: 'Invocation drift' },
  { value: 'placement', label: 'Placement drift' },
  { value: 'rollout', label: 'Rollout drift' },
  { value: 'runtime', label: 'Runtime drift' },
  { value: 'health', label: 'Health drift' },
];

const EVIDENCE_OPTIONS = [
  { value: ALL, label: 'Any' },
  { value: 'stale', label: 'Stale evidence' },
  { value: 'unreachable', label: 'Unreachable' },
  { value: 'unknown', label: 'Unknown' },
];

/** Section heading inside the popover, same as the Fleet filters. */
const FILTER_SECTION_LABEL_CLASS = 'text-[10px] leading-3 font-mono uppercase tracking-[0.18em] text-stat-subtitle';

export function PortfolioFilterBar({
  filters,
  nodes,
  onChange,
  onQueryChange,
  onClear,
  blueprintLabel,
}: {
  filters: GitOpsPortfolioFilters;
  nodes: NodeOption[];
  onChange: (next: GitOpsPortfolioFilters) => void;
  /** Typed search, debounced by the caller. */
  onQueryChange: (query: string) => void;
  /** Resets every filter, including ones only a deep link can set (source, rollout, health). */
  onClear: () => void;
  /** Display name for a Blueprint scope chip (the filter carries only the id). */
  blueprintLabel?: string;
}) {
  const uid = useId();
  const without = (key: 'stack' | 'blueprintId') => () => {
    const next = { ...filters };
    delete next[key];
    onChange(next);
  };

  const [searchExpanded, setSearchExpanded] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  // The input is locally controlled so typing stays immediate while the fetch
  // and URL write stay debounced upstream; external changes (deep link, a
  // reset from elsewhere) sync back down.
  const [query, setQuery] = useState(filters.q ?? '');

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setQuery(prev => (prev === (filters.q ?? '') ? prev : (filters.q ?? '')));
  }, [filters.q]);

  useEffect(() => {
    if (searchExpanded) searchInputRef.current?.focus();
  }, [searchExpanded]);

  const attentionValue = filters.attention === '1' ? 'attention' : ALL;
  const targetValue = filters.mode ?? ALL;
  const nodeValue = filters.nodeId !== undefined ? String(filters.nodeId) : ALL;
  const driftValue = filters.drift ?? ALL;
  const evidenceValue = filters.evidence ?? ALL;
  const activeFilterCount = [attentionValue, targetValue, nodeValue, driftValue, evidenceValue]
    .filter((value) => value !== ALL).length;

  return (
    <div className="flex items-center gap-2 flex-wrap">
      {query !== '' || searchExpanded ? (
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" strokeWidth={1.5} />
          <Input
            ref={searchInputRef}
            placeholder="Search applications..."
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              onQueryChange(event.target.value);
            }}
            onBlur={() => { if (query === '') setSearchExpanded(false); }}
            className="pl-8"
          />
        </div>
      ) : (
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className="h-9 w-9 p-0 shrink-0"
                onClick={() => setSearchExpanded(true)}
                aria-label="Search applications"
              >
                <Search className="w-4 h-4" strokeWidth={1.5} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Search applications</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      )}

      {/* Scopes set by another surface (a stack's Git indicator, a
          Blueprint's detail); they have no control in the Filters popover,
          so they show as removable chips rather than as an invisible
          narrowing. */}
      {filters.stack !== undefined && (
        <ScopeChip label={`stack: ${filters.stack}`} removeLabel="Remove stack filter" onRemove={without('stack')} />
      )}
      {filters.blueprintId !== undefined && (
        <ScopeChip
          label={`blueprint: ${blueprintLabel ?? `#${filters.blueprintId}`}`}
          removeLabel="Remove blueprint filter"
          onRemove={without('blueprintId')}
        />
      )}
      <Popover>
        <PopoverTrigger asChild>
          <Button
            variant={activeFilterCount > 0 ? 'default' : 'outline'}
            size="sm"
            className="h-9 gap-2 shrink-0"
          >
            <SlidersHorizontal className="w-4 h-4" />
            Filters
            {activeFilterCount > 0 && (
              <Badge variant="secondary" className="h-5 min-w-[1.25rem] px-1.5 text-[10px] tabular-nums">
                {activeFilterCount}
              </Badge>
            )}
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-80 space-y-4">
          <div className="space-y-1.5">
            <label id={`${uid}-attention`} className={FILTER_SECTION_LABEL_CLASS}>Attention</label>
            <OptionButtons
              labelId={`${uid}-attention`}
              options={ATTENTION_OPTIONS}
              value={attentionValue}
              onSelect={(value) => {
                const next = { ...filters };
                if (value === 'attention') next.attention = '1'; else delete next.attention;
                onChange(next);
              }}
            />
          </div>
          <div className="space-y-1.5">
            <label id={`${uid}-target`} className={FILTER_SECTION_LABEL_CLASS}>Target</label>
            <OptionButtons
              labelId={`${uid}-target`}
              options={TARGET_OPTIONS}
              value={targetValue}
              onSelect={(value) => {
                const next = { ...filters };
                if (value === 'direct' || value === 'blueprint') next.mode = value; else delete next.mode;
                onChange(next);
              }}
            />
          </div>
          <div className="space-y-1.5">
            <label id={`${uid}-node`} htmlFor={`${uid}-node-control`} className={FILTER_SECTION_LABEL_CLASS}>Node</label>
            <Combobox
              id={`${uid}-node-control`}
              options={[{ value: ALL, label: 'All nodes' }, ...nodes.map(node => ({ value: String(node.id), label: node.name }))]}
              value={nodeValue}
              onValueChange={(value) => {
                const next = { ...filters };
                if (value === ALL) delete next.nodeId; else next.nodeId = Number(value);
                onChange(next);
              }}
              searchPlaceholder="Filter nodes"
              emptyText="No nodes match"
            />
          </div>
          <div className="space-y-1.5">
            <label id={`${uid}-drift`} htmlFor={`${uid}-drift-control`} className={FILTER_SECTION_LABEL_CLASS}>Drift</label>
            <Combobox
              id={`${uid}-drift-control`}
              options={DRIFT_OPTIONS}
              value={driftValue}
              onValueChange={(value) => {
                const next = { ...filters };
                if (value === ALL) delete next.drift; else next.drift = value;
                onChange(next);
              }}
            />
          </div>
          <div className="space-y-1.5">
            <label id={`${uid}-evidence`} className={FILTER_SECTION_LABEL_CLASS}>Evidence</label>
            <OptionButtons
              labelId={`${uid}-evidence`}
              options={EVIDENCE_OPTIONS}
              value={evidenceValue}
              onSelect={(value) => {
                const next = { ...filters };
                if (value === 'stale' || value === 'unreachable' || value === 'unknown') next.evidence = value; else delete next.evidence;
                onChange(next);
              }}
            />
          </div>
        </PopoverContent>
      </Popover>
      {(Object.keys(filters).length > 0 || query !== '') && (
        <Button
          variant="ghost"
          size="sm"
          className="h-9 text-xs text-muted-foreground"
          onClick={() => {
            setQuery('');
            setSearchExpanded(false);
            onClear();
          }}
        >
          Clear filters
        </Button>
      )}
    </div>
  );
}

function OptionButtons({
  labelId,
  options,
  value,
  onSelect,
}: {
  /** Id of the section label that names this group. */
  labelId: string;
  options: { value: string; label: string }[];
  value: string;
  onSelect: (value: string) => void;
}) {
  return (
    <div role="group" aria-labelledby={labelId} className="flex flex-wrap items-center gap-1.5">
      {options.map((option) => (
        <Button
          key={option.value}
          variant={value === option.value ? 'default' : 'outline'}
          size="sm"
          className="h-7 text-xs px-2.5"
          aria-pressed={value === option.value}
          onClick={() => onSelect(option.value)}
        >
          {option.label}
        </Button>
      ))}
    </div>
  );
}

function ScopeChip({ label, removeLabel, onRemove }: { label: string; removeLabel: string; onRemove: () => void }) {
  return (
    <span className="inline-flex h-9 items-center gap-1.5 rounded-md border border-brand/40 bg-brand/[0.06] pl-2.5 pr-1 font-mono text-xs text-brand">
      {label}
      <button
        type="button"
        onClick={onRemove}
        aria-label={removeLabel}
        className="flex h-6 w-6 items-center justify-center rounded-sm hover:bg-brand/10"
      >
        <X className="h-3.5 w-3.5" strokeWidth={1.5} />
      </button>
    </span>
  );
}
