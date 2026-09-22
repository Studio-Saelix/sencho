import { useEffect, useRef, useState } from 'react';
import { Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Combobox } from '@/components/ui/combobox';
import { Input } from '@/components/ui/input';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import type { GitOpsPortfolioFilters } from '@/types/gitopsPortfolio';

interface NodeOption {
  id: number;
  name: string;
}

/**
 * Portfolio filter row.
 *
 * Same shape as the Security Images tab and the Fleet tabs: a collapsible
 * search affordance (square outline button that expands into a focused input)
 * followed by flat Combobox filters on one wrapping row, so a filtered triage
 * view looks and behaves like every other filtered list in the app.
 *
 * Choices are server-side filters; narrowing a list is a question, never a
 * permission decision, and the summary/the queue above stay portfolio-wide.
 */

const ALL = 'all';

const ATTENTION_OPTIONS = [
  { value: ALL, label: 'All applications' },
  { value: 'attention', label: 'Attention required' },
];

const TARGET_OPTIONS = [
  { value: ALL, label: 'All targets' },
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
  { value: ALL, label: 'Any evidence' },
  { value: 'stale', label: 'Stale evidence' },
  { value: 'unreachable', label: 'Unreachable' },
  { value: 'unknown', label: 'Unknown' },
];

/** Flat combobox trigger styling, matching the Security and Fleet filter rows. */
const FILTER_CLASS = 'w-[200px] [&>button]:!bg-background';

export function PortfolioFilterBar({
  filters,
  nodes,
  onChange,
  onQueryChange,
}: {
  filters: GitOpsPortfolioFilters;
  nodes: NodeOption[];
  onChange: (next: GitOpsPortfolioFilters) => void;
  /** Typed search, debounced by the caller. */
  onQueryChange: (query: string) => void;
}) {
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

      <Combobox
        options={ATTENTION_OPTIONS}
        value={attentionValue}
        onValueChange={(value) => {
          const next = { ...filters };
          if (value === 'attention') next.attention = '1'; else delete next.attention;
          onChange(next);
        }}
        className={FILTER_CLASS}
      />
      <Combobox
        options={TARGET_OPTIONS}
        value={targetValue}
        onValueChange={(value) => {
          const next = { ...filters };
          if (value === 'direct' || value === 'blueprint') next.mode = value; else delete next.mode;
          onChange(next);
        }}
        className={FILTER_CLASS}
      />
      <Combobox
        options={[{ value: ALL, label: 'All nodes' }, ...nodes.map(node => ({ value: String(node.id), label: node.name }))]}
        value={nodeValue}
        onValueChange={(value) => {
          const next = { ...filters };
          if (value === ALL) delete next.nodeId; else next.nodeId = Number(value);
          onChange(next);
        }}
        className={FILTER_CLASS}
        searchPlaceholder="Filter nodes"
        emptyText="No nodes match"
      />
      <Combobox
        options={DRIFT_OPTIONS}
        value={driftValue}
        onValueChange={(value) => {
          const next = { ...filters };
          if (value === ALL) delete next.drift; else next.drift = value;
          onChange(next);
        }}
        className={FILTER_CLASS}
      />
      <Combobox
        options={EVIDENCE_OPTIONS}
        value={evidenceValue}
        onValueChange={(value) => {
          const next = { ...filters };
          if (value === 'stale' || value === 'unreachable' || value === 'unknown') next.evidence = value; else delete next.evidence;
          onChange(next);
        }}
        className={FILTER_CLASS}
      />
    </div>
  );
}
