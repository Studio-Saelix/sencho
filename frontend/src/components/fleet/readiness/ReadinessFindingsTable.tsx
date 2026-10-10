import { useEffect, useRef, useState } from 'react';
import { ArrowRight, ChevronLeft, ChevronRight, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { BusyButton } from '@/components/ui/busy-button';
import type { FindingVerbControl } from './useReadinessVerbs';
import { Combobox } from '@/components/ui/combobox';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { overallMeta, verdictMeta } from '@/components/stack/stackReadinessMeta';
import {
  FINDING_SEVERITIES,
  type FindingVerdict,
  type FleetReadinessNode,
  type ReadinessDomainKey,
  type ReadinessFinding,
  type ReadinessTarget,
} from '@/types/readiness';
import { ALL, EMPTY_FINDINGS_FILTER, VERDICT_OPTIONS, filterFindings, type FindingsFilter } from './findingsFilter';
import { TONE_CHIP, TONE_DOT, TONE_ROW, codeCopy, codeRemediation, domainMeta, stateMeta } from '../readinessMeta';
import { FindingRowActions } from '@/components/ui/finding-row-actions';
import { DismissedSection, type DismissedItem } from '@/components/ui/dismissed-section';
import type { DismissalMode, FindingDismissal } from '@/types/findingDismissal';
import type { DismissedFinding } from '@/lib/findingDismissals';
import { describeDismissal } from './describeDismissal';

const HEAD = 'text-[10px] uppercase tracking-[0.18em]';
const FILTER_CLASS = 'w-[200px] [&>button]:!bg-background';
const PAGE_SIZE = 25;

/** The canonical verdict a finding restates, in that verdict's own surface's words. */
function verdictChip(verdict: FindingVerdict | null): { label: string; tone: string } | null {
  if (verdict === null) return null;
  const meta = verdict.kind === 'update' ? verdictMeta(verdict.value) : overallMeta(verdict.value);
  return { label: `${verdict.kind} ${meta.label}`, tone: meta.tone };
}

interface FilterBarProps {
  filter: FindingsFilter;
  domains: ReadinessDomainKey[];
  nodes: FleetReadinessNode[];
  onChange: (next: FindingsFilter) => void;
}

/** Same shape as the Security Images and GitOps filter rows: collapsible search, then flat comboboxes. */
function FindingsFilterBar({ filter, domains, nodes, onChange }: FilterBarProps) {
  const [searchExpanded, setSearchExpanded] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (searchExpanded) searchInputRef.current?.focus();
  }, [searchExpanded]);

  const domainOptions = [
    { value: ALL, label: 'All domains' },
    ...domains.map(domain => ({ value: domain, label: domainMeta(domain).label })),
  ];
  const severityOptions = [
    { value: ALL, label: 'Any state' },
    ...FINDING_SEVERITIES.map(severity => ({ value: severity, label: stateMeta(severity).label })),
  ];
  const nodeOptions = [
    { value: ALL, label: 'All nodes' },
    ...nodes.map(node => ({ value: String(node.id), label: node.name })),
  ];

  return (
    <div className="flex flex-wrap items-center gap-2">
      {filter.query !== '' || searchExpanded ? (
        <div className="relative min-w-[200px] max-w-sm flex-1">
          <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" strokeWidth={1.5} />
          <Input
            ref={searchInputRef}
            placeholder="Search findings..."
            value={filter.query}
            onChange={(event) => onChange({ ...filter, query: event.target.value })}
            onBlur={() => { if (filter.query === '') setSearchExpanded(false); }}
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
                className="h-9 w-9 shrink-0 p-0"
                onClick={() => setSearchExpanded(true)}
                aria-label="Search findings"
              >
                <Search className="h-4 w-4" strokeWidth={1.5} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Search findings</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      )}
      <Combobox
        options={domainOptions}
        value={filter.domain}
        onValueChange={(value) => onChange({
          ...filter,
          domain: domains.find(domain => domain === value) ?? ALL,
        })}
        className={FILTER_CLASS}
      />
      <Combobox
        options={severityOptions}
        value={filter.severity}
        onValueChange={(value) => onChange({
          ...filter,
          severity: FINDING_SEVERITIES.find(severity => severity === value) ?? ALL,
        })}
        className={FILTER_CLASS}
      />
      <Combobox
        options={VERDICT_OPTIONS}
        value={filter.verdict}
        onValueChange={(value) => onChange({
          ...filter,
          verdict: VERDICT_OPTIONS.find(option => option.value === value)?.value ?? ALL,
        })}
        className={FILTER_CLASS}
      />
      {nodes.length > 1 && (
        <Combobox
          options={nodeOptions}
          value={String(filter.nodeId)}
          onValueChange={(value) => {
            const node = nodes.find(candidate => String(candidate.id) === value);
            onChange({ ...filter, nodeId: node ? node.id : ALL });
          }}
          className={FILTER_CLASS}
        />
      )}
    </div>
  );
}

interface ReadinessFindingsTableProps {
  findings: ReadinessFinding[];
  domains: ReadinessDomainKey[];
  nodes: FleetReadinessNode[];
  filter: FindingsFilter;
  onFilterChange: (next: FindingsFilter) => void;
  /** Drill-down label, or null when the current user cannot reach that surface. */
  actionFor: (target: ReadinessTarget) => string | null;
  onOpen: (finding: ReadinessFinding) => void;
  /** The verb that resolves a finding in place, or null to keep its named navigation. */
  verbFor: (finding: ReadinessFinding) => FindingVerbControl | null;
  /** Whether this account may dismiss the finding; Dismiss is omitted rather than left to 403. */
  canDismiss: (finding: ReadinessFinding) => boolean;
  onDismiss: (finding: ReadinessFinding, mode: DismissalMode, days?: number) => void;
  isDismissing: (finding: ReadinessFinding) => boolean;
  /** Findings a dismissal still covers, listed under the table with a Restore. They follow the filter. */
  dismissed: DismissedFinding<ReadinessFinding>[];
  onRestore: (dismissal: FindingDismissal) => void;
  isRestoring: (dismissal: FindingDismissal) => boolean;
  now: number;
}

/**
 * Every reason a cell is not healthy, worst first (the hub sorts them), each
 * with a route to the surface that owns its remediation.
 */
export function ReadinessFindingsTable({
  findings,
  domains,
  nodes,
  filter,
  onFilterChange,
  actionFor,
  onOpen,
  verbFor,
  canDismiss,
  onDismiss,
  isDismissing,
  dismissed,
  onRestore,
  isRestoring,
  now,
}: ReadinessFindingsTableProps) {
  // The page belongs to the filter it was chosen under, so any filter change,
  // including one made from the matrix, starts again at the first page.
  const [paging, setPaging] = useState({ filter, page: 0 });
  const page = paging.filter === filter ? paging.page : 0;
  const setPage = (next: number) => setPaging({ filter, page: next });
  const nodeNames = new Map(nodes.map(node => [node.id, node.name]));
  const visible = filterFindings(findings, filter, nodeNames);
  const totalPages = Math.max(1, Math.ceil(visible.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages - 1);
  const pageItems = visible.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE);
  const filtered = visible.length !== findings.length;
  // The dismissed list answers to the same filter, so a node filter does not
  // list the rest of the fleet's dismissals under one node's findings.
  const visibleDismissedIds = new Set(filterFindings(dismissed.map(item => item.finding), filter, nodeNames).map(item => item.id));
  const dismissedItems: DismissedItem[] = dismissed
    .filter(item => visibleDismissedIds.has(item.finding.id))
    .map(({ finding, dismissal }) => ({
      id: dismissal.id,
      title: `${codeCopy(finding.code)} · ${[nodeNames.get(finding.nodeId) ?? `node ${finding.nodeId}`, finding.stack].filter(Boolean).join(' / ')}`,
      meta: describeDismissal(dismissal, now),
      onRestore: canDismiss(finding) ? () => onRestore(dismissal) : undefined,
      restoring: isRestoring(dismissal),
    }));
  const onlyDismissedHere = visible.length === 0 && dismissedItems.length > 0;

  return (
    <section aria-label="Readiness findings" className="space-y-2">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="font-mono text-[10px] leading-3 uppercase tracking-[0.18em] text-stat-subtitle">findings</h3>
        <span className="font-mono text-[10px] tabular-nums text-stat-subtitle">
          {filtered ? `${visible.length} of ${findings.length}` : findings.length}
        </span>
      </div>
      <FindingsFilterBar filter={filter} domains={domains} nodes={nodes} onChange={onFilterChange} />
      <div className="overflow-hidden rounded-lg border border-card-border border-t-card-border-top bg-card shadow-card-bevel">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className={cn(HEAD, 'w-8')} aria-label="Severity" />
              <TableHead className={HEAD}>Finding</TableHead>
              <TableHead className={cn(HEAD, 'max-md:hidden')}>Node</TableHead>
              <TableHead className={cn(HEAD, 'max-md:hidden')}>Stack</TableHead>
              <TableHead className={cn(HEAD, 'max-md:hidden')}>Domain</TableHead>
              <TableHead className={HEAD}>State</TableHead>
              <TableHead className={cn(HEAD, 'text-right')}>Action</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {pageItems.map(finding => (
              <FindingRow
                key={finding.id}
                finding={finding}
                nodeName={nodeNames.get(finding.nodeId) ?? `node ${finding.nodeId}`}
                action={actionFor(finding.target)}
                onOpen={onOpen}
                verb={verbFor(finding)}
                canDismiss={canDismiss(finding)}
                dismissing={isDismissing(finding)}
                onDismiss={onDismiss}
              />
            ))}
          </TableBody>
        </Table>
        {pageItems.length === 0 && (
          <div className="py-12 text-center text-sm text-muted-foreground">
            {onlyDismissedHere
              ? 'Everything here is dismissed.'
              : findings.length > 0 || dismissed.length > 0
                ? 'No finding matches the current filters.'
                : 'Nothing needs attention across this fleet.'}
          </div>
        )}
      </div>
      {filtered && (
        <button
          type="button"
          onClick={() => onFilterChange(EMPTY_FINDINGS_FILTER)}
          className="text-xs font-medium text-brand hover:underline"
        >
          Clear filters
        </button>
      )}
      <DismissedSection items={dismissedItems} forceOpen={onlyDismissedHere} />
      {visible.length > PAGE_SIZE && (
        <div className="flex items-center justify-end gap-1">
          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setPage(Math.max(0, safePage - 1))} disabled={safePage === 0} aria-label="Previous page">
            <ChevronLeft className="h-4 w-4" strokeWidth={1.5} />
          </Button>
          <span className="px-1 text-xs tabular-nums text-stat-subtitle">{safePage + 1} / {totalPages}</span>
          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setPage(Math.min(totalPages - 1, safePage + 1))} disabled={safePage >= totalPages - 1} aria-label="Next page">
            <ChevronRight className="h-4 w-4" strokeWidth={1.5} />
          </Button>
        </div>
      )}
    </section>
  );
}

interface FindingRowProps {
  finding: ReadinessFinding;
  nodeName: string;
  action: string | null;
  onOpen: (finding: ReadinessFinding) => void;
  verb: FindingVerbControl | null;
  canDismiss: boolean;
  dismissing: boolean;
  onDismiss: (finding: ReadinessFinding, mode: DismissalMode, days?: number) => void;
}

function FindingRow({ finding, nodeName, action, onOpen, verb, canDismiss, dismissing, onDismiss }: FindingRowProps) {
  const state = stateMeta(finding.severity);
  // A finding that restates a canonical verdict shows that verdict; any other shows its state.
  const chip = verdictChip(finding.verdict) ?? { label: state.label, tone: TONE_CHIP[state.tone] };
  const domain = domainMeta(finding.domain);
  const DomainIcon = domain.icon;
  const remediation = codeRemediation(finding.code);

  return (
    <TableRow className={cn('transition-colors hover:bg-muted/30', TONE_ROW[state.tone])}>
      <TableCell className="align-top">
        <span aria-hidden className={cn('mt-1 inline-block h-2 w-2 rounded-full', TONE_DOT[state.tone])} />
      </TableCell>
      <TableCell className="align-top">
        <div className="min-w-[240px] max-w-[420px]">
          <span className="text-xs font-medium text-stat-value">
            {codeCopy(finding.code)}
            {finding.count > 1 && <span className="ml-1.5 font-mono text-[10px] tabular-nums text-stat-subtitle">×{finding.count}</span>}
          </span>
          {finding.detail && <span className="mt-0.5 block text-[11px] leading-snug text-stat-subtitle">{finding.detail}</span>}
          {remediation && <span className="mt-0.5 block text-[11px] leading-snug text-stat-subtitle">{remediation}</span>}
          {/* The scope columns are hidden on a phone, so the row names it inline. */}
          <span className="mt-0.5 hidden font-mono text-[10px] text-stat-subtitle max-md:block">
            {[nodeName, finding.stack].filter(Boolean).join(' / ')}
          </span>
        </div>
      </TableCell>
      <TableCell className="align-top font-mono text-xs max-md:hidden">
        <span className="block max-w-[160px] truncate">{nodeName}</span>
      </TableCell>
      <TableCell className="align-top font-mono text-xs max-md:hidden">
        {finding.stack
          ? <span className="block max-w-[160px] truncate">{finding.stack}</span>
          : <span className="text-[11px] text-stat-icon">--</span>}
      </TableCell>
      <TableCell className="align-top max-md:hidden">
        <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-[11px] text-stat-subtitle">
          <DomainIcon className="h-3.5 w-3.5" strokeWidth={1.5} />
          {domain.label}
        </span>
      </TableCell>
      <TableCell className="align-top">
        <span className="flex flex-wrap gap-1">
          <span className={cn('whitespace-nowrap rounded-md border px-1.5 py-0.5 font-mono text-[10px] leading-4', chip.tone)}>
            {chip.label}
          </span>
        </span>
      </TableCell>
      <TableCell className="text-right align-top">
        <FindingRowActions
          dismissPolicy={finding.dismissPolicy ?? 'none'}
          canDismiss={canDismiss}
          pending={dismissing}
          subject={codeCopy(finding.code)}
          onDismiss={(mode, days) => onDismiss(finding, mode, days)}
        >
          {verb ? (
            <BusyButton
              variant="ghost"
              size="sm"
              className="h-auto min-h-7 max-w-[8rem] whitespace-normal px-2 py-1 text-right text-xs leading-tight text-brand hover:text-brand"
              pending={verb.busy}
              aria-label={`${verb.label}: ${codeCopy(finding.code)}`}
              onClick={verb.run}
            >
              {verb.label}
            </BusyButton>
          ) : action && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 whitespace-nowrap px-2 text-xs text-stat-subtitle hover:text-stat-value"
              onClick={() => onOpen(finding)}
            >
              {action}
              <ArrowRight className="ml-1 h-3.5 w-3.5" strokeWidth={1.5} />
            </Button>
          )}
        </FindingRowActions>
      </TableCell>
    </TableRow>
  );
}
