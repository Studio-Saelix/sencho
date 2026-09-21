import { useCallback, useEffect, useState } from 'react';
import { ArrowRight, RefreshCw, ServerOff } from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { cn } from '@/lib/utils';
import { formatAgeShort } from '@/lib/relativeTime';
import { Button } from '@/components/ui/button';
import { SENCHO_OPEN_STACK_EVENT, type SenchoOpenStackDetail } from '@/lib/events';
import { SENCHO_NAVIGATE_EVENT, type SenchoNavigateDetail } from '@/components/NodeManager';
import { toSecurityTab } from '@/lib/router/senchoRoute';
import { overallMeta, verdictMeta } from '@/components/stack/stackReadinessMeta';
import { FleetEmptyCard, FleetEmptyState } from './FleetEmptyState';
import { HEALTHY_META, SEVERITY_META, codeCopy, domainMeta, severityMeta } from './readinessMeta';
import type { SectionId } from '@/components/settings/types';
import {
  DOMAIN_STATE_ORDER,
  type DomainState,
  type FindingVerdict,
  type FleetReadinessNode,
  type FleetReadinessResponse,
  type NodeDomainCell,
  type ReadinessDomainKey,
  type ReadinessFinding,
  type ReadinessTarget,
} from '@/types/readiness';

const LABEL = 'font-mono text-[10px] leading-3 uppercase tracking-[0.18em] text-stat-subtitle';
const CHIP = 'rounded-md border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide';
const TH = 'px-3 py-2 text-left font-mono text-[10px] leading-3 font-normal uppercase tracking-[0.18em] text-stat-subtitle';

/** The hero word for the fleet's worst node state. Not a score: one word. */
const HEADLINE: Record<DomainState, string> = {
  attention: 'Needs attention',
  degraded: 'Degraded',
  unavailable: 'Unavailable',
  unknown: 'Partly unknown',
  healthy: 'All clear',
};

const TARGET_ACTION: Record<ReadinessTarget['surface'], string> = {
  stack: 'Open stack',
  'auto-updates': 'Auto-updates',
  'fleet-snapshots': 'Snapshots',
  security: 'Security',
  'node-details': 'Node details',
  'settings-nodes': 'Settings',
};

function worstState(counts: Record<DomainState, number>): DomainState {
  // Falls back to `unknown`, never to `healthy`: counts that are all zero mean
  // this build cannot read the tally (no rows, or a state word a newer hub
  // introduced that none of the five below match), and "I cannot tell" must not
  // render as the one word that says everything is fine. Same floor the hub's
  // own per-node rollup uses.
  return DOMAIN_STATE_ORDER.find(state => counts[state] > 0) ?? 'unknown';
}

function fleetSubline(counts: Record<DomainState, number>): string {
  const parts = DOMAIN_STATE_ORDER
    .filter((state): state is Exclude<DomainState, 'healthy'> => state !== 'healthy' && counts[state] > 0)
    .map(state => {
      const count = counts[state];
      // `attention` is the one state word that is a verb phrase, so it is the one
      // that has to agree with the count: the table already carries its singular
      // and only the plural is written out here. The other three are adjectives
      // and read the same either way.
      const phrase = state === 'attention' && count > 1 ? 'need attention' : SEVERITY_META[state].label;
      return `${count} ${count === 1 ? 'node' : 'nodes'} ${phrase}`;
    });
  if (counts.healthy > 0) parts.push(`${counts.healthy} healthy`);
  return parts.join(' · ');
}

/** The verdict this finding restates, in that verdict's own surface's words. */
function verdictBadge(verdict: FindingVerdict | null): { label: string; tone: string } | null {
  if (verdict === null) return null;
  // The accessors carry the fallback, so a badge never reads more confidently
  // here than it does on the surface the verdict came from.
  const meta = verdict.kind === 'update' ? verdictMeta(verdict.value) : overallMeta(verdict.value);
  return { label: meta.label, tone: meta.tone };
}

/** Re-renders on an interval so "last checked" stays honest while the tab is open. */
function useTicker(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

/**
 * The server's own wording for a request it refused, when it sent one.
 *
 * Every route answers a failure with a standardized `{ error }` body, and that
 * sentence carries the one thing the status code does not: whether trying again
 * could ever help. A refused permission and a transient fault both arrive as a
 * failed request and call for different responses from the operator.
 */
async function serverErrorMessage(res: Response, fallback: string): Promise<string> {
  const body: unknown = await res.json().catch(() => null);
  if (typeof body === 'object' && body !== null && 'error' in body && typeof body.error === 'string') {
    return body.error;
  }
  return fallback;
}

function useFleetReadiness() {
  const [data, setData] = useState<FleetReadinessResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    const load = async () => {
      try {
        // Hub-owned aggregate: it answers for the whole fleet, so it is never
        // addressed to one node.
        const res = await apiFetch('/fleet/readiness', { localOnly: true, signal: controller.signal });
        if (controller.signal.aborted) return;
        if (!res.ok) {
          console.error('[FleetReadiness] request failed:', res.status);
          // A 401 never reaches here: `apiFetch` raises it as a thrown error so
          // the global session handling can see it. What does arrive with a body
          // is a refusal the server already explained, and repeating its words
          // beats a sentence that reads the same for every cause.
          setError(await serverErrorMessage(res, 'The readiness check could not be completed.'));
          return;
        }
        setData(await res.json() as FleetReadinessResponse);
        setError(null);
      } catch (e) {
        if (controller.signal.aborted) return;
        console.error('[FleetReadiness] request failed:', e);
        setError('The readiness check could not be reached.');
      }
    };
    void load();
    return () => controller.abort();
  }, [attempt]);

  const refresh = useCallback(() => setAttempt(n => n + 1), []);
  return { data, error, refresh };
}

function ReadinessHero({ data }: { data: FleetReadinessResponse }) {
  const now = useTicker(1000);
  const worst = worstState(data.summary.nodes);
  const tone = worst === 'healthy' ? HEALTHY_META.tone : SEVERITY_META[worst].tone;
  const subline = fleetSubline(data.summary.nodes);

  return (
    <div className="rounded-lg border border-card-border border-t-card-border-top bg-card p-4 shadow-card-bevel transition-colors hover:border-t-card-border-hover">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className={LABEL}>fleet readiness</div>
          <h2 className={cn('font-heading text-[1.5rem] leading-tight', tone)}>{HEADLINE[worst]}</h2>
          {subline && <p className="text-sm text-stat-subtitle">{subline}</p>}
          {/* The headline judges the domains this account was given. When the
              server withheld one, the board says so here rather than letting a
              count of the others read as a statement about the whole fleet. */}
          {data.domainsOmitted.length > 0 && (
            <p className="mt-1 text-[11px] text-stat-subtitle">
              Not evaluated for this account: {data.domainsOmitted.map(key => domainMeta(key).label).join(', ')}.
            </p>
          )}
        </div>
        <div className="shrink-0 text-right">
          <div className={LABEL}>last checked</div>
          <div className="font-mono text-xl tabular-nums tracking-tight text-stat-value">
            {formatAgeShort(now - data.generatedAt)} ago
          </div>
          <div className="font-mono text-[10px] tabular-nums text-stat-subtitle">
            {data.nodes.length} {data.nodes.length === 1 ? 'node' : 'nodes'}
          </div>
        </div>
      </div>
    </div>
  );
}

interface FindingRowProps {
  finding: ReadinessFinding;
  /** Node name, stack name, or both: what the row is about. */
  scope: string;
  /** Drill-down label, or null when the current user cannot reach that surface. */
  action: string | null;
  onOpen: (target: ReadinessTarget) => void;
}

function FindingRow({ finding, scope, action, onOpen }: FindingRowProps) {
  const meta = severityMeta(finding.severity);
  const badge = verdictBadge(finding.verdict);
  const DomainIcon = domainMeta(finding.domain).icon;
  const line = [scope, finding.detail].filter(Boolean).join(': ');

  return (
    <div className="flex items-start gap-3 border-t border-muted px-3 py-2.5 first:border-t-0">
      <DomainIcon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-stat-subtitle" strokeWidth={1.5} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className={cn(CHIP, meta.chip)}>{meta.label}</span>
          <span className="text-[12px] font-medium text-foreground/90">{codeCopy(finding.code)}</span>
          {finding.count > 1 && (
            <span className="font-mono text-[10px] tabular-nums text-stat-subtitle">×{finding.count}</span>
          )}
          {badge && <span className={cn(CHIP, badge.tone)}>{badge.label}</span>}
        </div>
        {line && <div className="mt-0.5 text-[12px] leading-relaxed text-foreground/80">{line}</div>}
      </div>
      {action && (
        <Button
          variant="ghost"
          size="sm"
          className="shrink-0 text-stat-subtitle"
          onClick={() => onOpen(finding.target)}
        >
          {action}
          <ArrowRight className="ml-1 h-3.5 w-3.5" />
        </Button>
      )}
    </div>
  );
}

interface FindingsCardProps {
  findings: ReadinessFinding[];
  nodes: FleetReadinessNode[];
  canReach: (target: ReadinessTarget) => boolean;
  onOpen: (target: ReadinessTarget) => void;
}

function FindingsCard({ findings, nodes, canReach, onOpen }: FindingsCardProps) {
  const names = new Map(nodes.map(node => [node.id, node.name]));

  return (
    <section className="rounded-lg border border-card-border border-t-card-border-top bg-card shadow-card-bevel">
      <div className="flex items-center justify-between gap-2 border-b border-muted px-3 py-2">
        <span className={LABEL}>findings</span>
        <span className="font-mono text-[10px] tabular-nums text-stat-subtitle">{findings.length}</span>
      </div>
      {findings.length === 0 ? (
        <p className="px-3 py-4 text-[12px] text-stat-subtitle">Nothing needs attention across this fleet.</p>
      ) : (
        findings.map(finding => {
          const scope = [names.get(finding.nodeId), finding.stack]
            .filter((part): part is string => Boolean(part))
            .join(' / ');
          return (
            <FindingRow
              key={finding.id}
              finding={finding}
              scope={scope}
              action={canReach(finding.target) ? TARGET_ACTION[finding.target.surface] : null}
              onOpen={onOpen}
            />
          );
        })
      )}
    </section>
  );
}

function ReadinessCell({ cell }: { cell: NodeDomainCell | undefined }) {
  if (!cell) {
    // The payload promised this domain, so a missing key is a gap in what was
    // received rather than a healthy cell.
    const meta = SEVERITY_META.unavailable;
    return <span className={cn(CHIP, meta.chip)}>{meta.label}</span>;
  }
  if (cell.state === 'healthy') {
    return (
      <span className="inline-flex items-center gap-1.5">
        <span aria-hidden className={cn('h-1.5 w-1.5 rounded-full', HEALTHY_META.dot)} />
        <span className="sr-only">{HEALTHY_META.label}</span>
      </span>
    );
  }
  const meta = severityMeta(cell.state);
  return <span className={cn(CHIP, meta.chip)}>{meta.label}</span>;
}

interface ReadinessMatrixProps {
  domains: ReadinessDomainKey[];
  nodes: FleetReadinessNode[];
  onOpenNode: (nodeId: number) => void;
}

function ReadinessMatrix({ domains, nodes, onOpenNode }: ReadinessMatrixProps) {
  if (domains.length === 0) return null;

  return (
    <section className="overflow-x-auto rounded-lg border border-card-border border-t-card-border-top bg-card shadow-card-bevel">
      <table className="w-full border-collapse">
        <thead>
          <tr className="border-b border-muted">
            <th scope="col" className={TH}>Node</th>
            {domains.map(domain => {
              const meta = domainMeta(domain);
              const DomainIcon = meta.icon;
              return (
                <th key={domain} scope="col" className={TH}>
                  <span className="inline-flex items-center gap-1.5">
                    <DomainIcon className="h-3.5 w-3.5" strokeWidth={1.5} />
                    {meta.label}
                  </span>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {nodes.map(node => (
            <tr key={node.id} className="border-t border-muted transition-colors hover:bg-card/40">
              <td className="px-3 py-2">
                <button
                  type="button"
                  onClick={() => onOpenNode(node.id)}
                  className="block text-left text-[12px] font-medium text-foreground/90 transition-colors hover:text-brand"
                >
                  {node.name}
                </button>
                <span className="font-mono text-[10px] uppercase tracking-wide text-stat-subtitle">
                  {node.transport}
                </span>
              </td>
              {domains.map(domain => (
                <td key={domain} className="px-3 py-2">
                  <ReadinessCell cell={node.cells[domain]} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function ReadinessErrorCard({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="mx-auto max-w-xl space-y-4 rounded-xl border border-card-border/60 bg-popover/30 p-8 text-center">
      <p className="text-sm leading-relaxed text-stat-subtitle">{message}</p>
      <Button variant="outline" size="sm" onClick={onRetry}>
        <RefreshCw className="mr-1.5 h-4 w-4" />
        Try again
      </Button>
    </div>
  );
}

interface FleetReadinessProps {
  /** Opens the in-view node details sheet, the connectivity findings' target. */
  onOpenNodeDetails: (nodeId: number) => void;
  /** Opens a Settings section; absent when the shell did not provide one. */
  onOpenSettingsSection?: (section: SectionId) => void;
  /** Snapshots is an admin-only tab, so its shortcut follows the same gate. */
  isAdmin: boolean;
}

/**
 * Fleet Readiness: what across this fleet needs attention before you operate,
 * update, recover, or rely on it.
 *
 * Every state, reason code, and finding is decided on the hub; this surface
 * renders the payload and dispatches drill-downs to the surfaces that already
 * own each remediation. Nothing here recomputes a verdict, and nothing here
 * renders a state the caller was not told about.
 */
export function FleetReadiness({ onOpenNodeDetails, onOpenSettingsSection, isAdmin }: FleetReadinessProps) {
  const { data, error, refresh } = useFleetReadiness();

  const navigate = useCallback((detail: SenchoNavigateDetail) => {
    window.dispatchEvent(new CustomEvent<SenchoNavigateDetail>(SENCHO_NAVIGATE_EVENT, { detail }));
  }, []);

  const openTarget = useCallback((target: ReadinessTarget) => {
    switch (target.surface) {
      case 'stack':
        window.dispatchEvent(new CustomEvent<SenchoOpenStackDetail>(SENCHO_OPEN_STACK_EVENT, {
          detail: { nodeId: target.nodeId, stackName: target.stackName },
        }));
        return;
      case 'auto-updates':
        navigate({ view: 'auto-updates' });
        return;
      case 'fleet-snapshots':
        navigate({ view: 'fleet', fleetTab: 'snapshots' });
        return;
      case 'security': {
        const tab = target.tab === null ? null : toSecurityTab(target.tab);
        navigate(tab === null ? { view: 'security' } : { view: 'security', tab });
        return;
      }
      case 'node-details':
        onOpenNodeDetails(target.nodeId);
        return;
      case 'settings-nodes':
        onOpenSettingsSection?.('nodes');
    }
  }, [navigate, onOpenNodeDetails, onOpenSettingsSection]);

  // A finding is always shown; only the shortcut is withheld when the current
  // user cannot reach the surface it points at, so no row offers a dead button.
  const canReach = useCallback((target: ReadinessTarget): boolean => {
    if (target.surface === 'fleet-snapshots') return isAdmin;
    if (target.surface === 'settings-nodes') return onOpenSettingsSection !== undefined;
    return true;
  }, [isAdmin, onOpenSettingsSection]);

  if (!data) {
    return error === null
      ? <div className="p-6 text-center font-mono text-[11px] text-stat-subtitle">Checking readiness…</div>
      : <ReadinessErrorCard message={error} onRetry={refresh} />;
  }
  return (
    <div className="space-y-4 p-1">
      {/* A failed refresh keeps the last result on screen, so it has to say so:
          a readiness board that silently shows stale states is the one thing it
          must never do. It sits above both branches below, so the empty fleet
          reports its own failed refresh instead of hiding behind the empty
          state. */}
      {error !== null && (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-warning/30 bg-warning/[0.06] px-3 py-2 text-[12px] text-warning">
          <span>
            {error}
            {/* There is no previous result to speak of when the fleet is empty. */}
            {data.nodes.length > 0 && ' Showing the previous result.'}
          </span>
          <Button variant="ghost" size="sm" className="shrink-0 text-warning" onClick={refresh}>
            Try again
          </Button>
        </div>
      )}
      {data.nodes.length === 0 ? (
        <FleetEmptyState>
          <FleetEmptyCard
            icon={ServerOff}
            title="No nodes yet"
            description="Add a node to see what across the fleet needs attention."
          />
        </FleetEmptyState>
      ) : (
        <>
          <ReadinessHero data={data} />
          <FindingsCard findings={data.findings} nodes={data.nodes} canReach={canReach} onOpen={openTarget} />
          <ReadinessMatrix domains={data.domains} nodes={data.nodes} onOpenNode={onOpenNodeDetails} />
        </>
      )}
    </div>
  );
}
