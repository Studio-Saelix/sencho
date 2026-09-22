import { ListFilter, Search, X } from 'lucide-react';
import { Combobox } from '@/components/ui/combobox';
import { cn } from '@/lib/utils';
import type { GitOpsPortfolioFilters } from '@/types/gitopsPortfolio';

interface NodeOption {
  id: number;
  name: string;
}

/**
 * Portfolio filter bar: free-text search plus the triage dimensions the issue
 * calls out (attention, target mode, node involvement). Every selection is a
 * server-side filter, so filtered views stay consistent with row-level RBAC:
 * narrowing a list is a question, never a permission decision.
 *
 * Chips are the five semantic slots in tracked-mono; the active chip gets the
 * brand fill. (Same pill vocabulary as the dashboard's filter rows.)
 */
export function PortfolioFilterBar({
  filters,
  nodes,
  onChange,
  onQueryChange,
  onClear,
}: {
  filters: GitOpsPortfolioFilters;
  nodes: NodeOption[];
  onChange: (next: GitOpsPortfolioFilters) => void;
  /** Typed search, debounced by the caller. */
  onQueryChange: (query: string) => void;
  onClear: () => void;
}) {
  const hasFilters = (['q', 'attention', 'mode', 'nodeId', 'drift', 'evidence', 'source', 'rollout', 'health'] as const)
    .some(key => filters[key] !== undefined);

  const chip = (label: string, active: boolean, onClick: () => void, count?: number) => (
    <button
      key={label}
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'inline-flex min-h-8 items-center rounded-md border px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.14em] transition-colors',
        active
          ? 'border-brand/50 bg-brand/10 text-brand'
          : 'border-card-border bg-card text-stat-subtitle hover:text-stat-value',
      )}
    >
      {label}
      {count !== undefined && <span className="ml-1.5 opacity-60">{count}</span>}
    </button>
  );

  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="relative min-w-[220px] flex-1 sm:max-w-xs">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-stat-icon" strokeWidth={1.5} />
        <input
          type="search"
          value={filters.q ?? ''}
          onChange={event => onQueryChange(event.target.value)}
          placeholder="Search applications, repositories, refs"
          aria-label="Search GitOps applications"
          className="h-8 w-full rounded-md border border-card-border bg-card pl-8 pr-3 font-mono text-xs text-stat-value placeholder:text-stat-icon focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/50"
        />
      </div>

      {chip('All', !filters.attention && !filters.mode, () => {
        const next = { ...filters };
        delete next.attention;
        delete next.mode;
        onChange(next);
      })}
      {chip('Attention', filters.attention === '1', () => {
        const next = { ...filters };
        if (next.attention) delete next.attention; else next.attention = '1';
        onChange(next);
      })}
      {chip('Direct', filters.mode === 'direct', () => {
        const next = { ...filters };
        if (next.mode === 'direct') delete next.mode; else next.mode = 'direct';
        onChange(next);
      })}
      {chip('Blueprint', filters.mode === 'blueprint', () => {
        const next = { ...filters };
        if (next.mode === 'blueprint') delete next.mode; else next.mode = 'blueprint';
        onChange(next);
      })}

      <div className="w-44">
        <Combobox
          options={nodes.map(node => ({ value: String(node.id), label: node.name }))}
          value={filters.nodeId !== undefined ? String(filters.nodeId) : ''}
          onValueChange={value => {
            const next = { ...filters };
            if (value) next.nodeId = Number(value); else delete next.nodeId;
            onChange(next);
          }}
          placeholder="All nodes"
          searchPlaceholder="Filter nodes"
          emptyText="No nodes match"
        />
      </div>

      <div className="w-44">
        <Combobox
          options={[
            { value: 'source', label: 'Source drift' },
            { value: 'managed_project', label: 'Managed project drift' },
            { value: 'invocation', label: 'Invocation drift' },
            { value: 'placement', label: 'Placement drift' },
            { value: 'rollout', label: 'Rollout drift' },
            { value: 'runtime', label: 'Runtime drift' },
            { value: 'health', label: 'Health drift' },
          ]}
          value={filters.drift ?? ''}
          onValueChange={value => {
            const next = { ...filters };
            if (value) next.drift = value; else delete next.drift;
            onChange(next);
          }}
          placeholder="Drift class"
          searchPlaceholder="Filter drift classes"
          emptyText="No drift class matches"
        />
      </div>

      <div className="w-40">
        <Combobox
          options={[
            { value: 'stale', label: 'Stale evidence' },
            { value: 'unreachable', label: 'Unreachable' },
            { value: 'unknown', label: 'Unknown' },
          ]}
          value={filters.evidence ?? ''}
          onValueChange={value => {
            const next = { ...filters };
            if (value === 'stale' || value === 'unreachable' || value === 'unknown') next.evidence = value; else delete next.evidence;
            onChange(next);
          }}
          placeholder="Any evidence"
          searchPlaceholder="Filter evidence"
          emptyText="No value matches"
        />
      </div>

      {hasFilters && (
        <button
          type="button"
          onClick={onClear}
          className="inline-flex min-h-8 items-center gap-1 rounded-md px-2 font-mono text-[10px] uppercase tracking-[0.14em] text-stat-subtitle transition-colors hover:text-stat-value"
        >
          <ListFilter className="h-3.5 w-3.5" strokeWidth={1.5} />
          Clear
          <X className="h-3 w-3" strokeWidth={1.5} />
        </button>
      )}
    </div>
  );
}
