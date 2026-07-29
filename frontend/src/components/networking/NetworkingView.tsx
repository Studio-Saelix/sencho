import { useCallback, useEffect, useState, type ReactNode } from 'react';
import {
  LayoutDashboard, Network, GitBranch, AlertTriangle, RefreshCw, Plus, Unplug,
} from 'lucide-react';
import { Tabs, TabsContent, TabsList, TabsTrigger, TabsHighlight, TabsHighlightItem } from '@/components/ui/tabs';
import { PageMasthead, type MastheadMetadataItem } from '@/components/ui/PageMasthead';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { LockCard } from '@/components/ui/LockCard';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { apiFetch } from '@/lib/api';
import { toast } from '@/components/ui/toast-store';
import { useAuth } from '@/context/AuthContext';
import { useNodes } from '@/context/NodeContext';
import { useIsMobile } from '@/hooks/use-is-mobile';
import { Masthead, MobileSubTabs, type Tone } from '@/components/mobile/mobile-ui';
import { springs } from '@/lib/motion';
import { CreateNetworkDialog } from '@/components/resources/CreateNetworkDialog';
import { ConfirmModal } from '@/components/ui/modal';
import { NetworkDetailDrawer } from './NetworkDetailDrawer';
import { NetworkInventoryTable } from './NetworkInventoryTable';
import { NetworkingFindingsList } from './NetworkingFindingsList';
import { NetworkingTopologyPanel } from './NetworkingTopologyPanel';
import { SENCHO_OPEN_STACK_EVENT, type SenchoOpenStackDetail } from '@/lib/events';
import {
  adaptNetworkingOverview, buildExternalNetworkSnippet, canUseNetworkName, getNetworkingPosture,
  isNetworkingActionVisible,
} from '@/lib/networking';
import { rankFindings, SEVERITY_TEXT_CLASS } from '@/lib/networkingSeverity';
import { isNetworkDriftFindingKind } from '@/types/networking';
import type {
  NetworkingFinding, NetworkingOverviewEnvelope, NetworkingRecommendedAction,
  NetworkingNetworkRow, NodeNetworkingOverview,
} from '@/types/networking';

export type NetworkingTab = 'overview' | 'topology' | 'networks' | 'findings';

interface NetworkingViewProps {
  headerActions?: ReactNode;
}

const TABS: { value: NetworkingTab; label: string; icon: typeof LayoutDashboard }[] = [
  { value: 'overview', label: 'Overview', icon: LayoutDashboard },
  { value: 'networks', label: 'Networks', icon: Network },
  { value: 'topology', label: 'Topology', icon: GitBranch },
  { value: 'findings', label: 'Findings', icon: AlertTriangle },
];

const POSTURE_TONE: Record<ReturnType<typeof getNetworkingPosture>['tone'], 'error' | 'warn' | 'idle' | 'live'> = {
  critical: 'error',
  warning: 'warn',
  neutral: 'idle',
  live: 'live',
};

// Maps the shared posture tone onto the mobile masthead's dot tone, state-word
// color, and pulse, mirroring SecurityView's MOBILE_MASTHEAD_TONE table.
type StateWordClass = 'text-destructive' | 'text-warning' | 'text-stat-value' | 'text-stat-title';
const MOBILE_MASTHEAD_TONE: Record<'error' | 'warn' | 'idle' | 'live', { dot: Tone; word: StateWordClass; pulse: boolean }> = {
  error: { dot: 'destructive', word: 'text-destructive', pulse: true },
  warn: { dot: 'warning', word: 'text-warning', pulse: true },
  live: { dot: 'brand', word: 'text-stat-value', pulse: false },
  idle: { dot: 'warning', word: 'text-stat-title', pulse: false },
};

function destinationForAction(kind: NetworkingRecommendedAction['kind']): SenchoOpenStackDetail['destination'] {
  switch (kind) {
    case 'open-stack-networking':
    case 'set-exposure-intent':
      return 'anatomy-networking';
    case 'open-stack-doctor':
      return 'doctor';
    case 'open-stack-editor':
      return 'editor';
    case 'open-stack-dossier':
      return 'dossier';
    case 'open-stack-drift':
      return 'drift';
    default:
      return 'stack';
  }
}

export function NetworkingView({ headerActions }: NetworkingViewProps) {
  const { isAdmin, can } = useAuth();
  const { activeNode } = useNodes();
  const isMobile = useIsMobile();
  const nodeId = activeNode?.id;

  const [tab, setTab] = useState<NetworkingTab>('overview');
  const [loading, setLoading] = useState(true);
  const [unsupported, setUnsupported] = useState(false);
  const [overview, setOverview] = useState<NodeNetworkingOverview | null>(null);
  const [networks, setNetworks] = useState<NetworkingNetworkRow[]>([]);
  const [findings, setFindings] = useState<NetworkingFinding[]>([]);
  const [recentActivity, setRecentActivity] = useState<NetworkingOverviewEnvelope['recentActivity']>([]);
  const [runtimeAvailable, setRuntimeAvailable] = useState(true);
  const [isLegacy, setIsLegacy] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [showCreateNetwork, setShowCreateNetwork] = useState(false);
  const [initialNetworkName, setInitialNetworkName] = useState<string | undefined>();
  const [selectedNetworkId, setSelectedNetworkId] = useState<string | null>(null);
  const [pendingTopologyFilter, setPendingTopologyFilter] = useState<string | undefined>();
  const [confirmDeleteNetwork, setConfirmDeleteNetwork] = useState<{ id: string; name: string } | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  const handleDeleteNetwork = useCallback(async () => {
    if (!confirmDeleteNetwork) return;
    setIsDeleting(true);
    const loadingId = toast.loading('Deleting network...');
    try {
      const res = await apiFetch('/system/networks/delete', {
        method: 'POST',
        body: JSON.stringify({ id: confirmDeleteNetwork.id }),
      });
      const data = await res.json().catch(() => null) as { error?: string } | null;
      if (!res.ok) {
        throw new Error(data?.error || 'Failed to delete network');
      }
      toast.success('Network deleted');
      setReloadKey(k => k + 1);
    } catch (error) {
      const err = error as Record<string, unknown>;
      toast.error(String(err?.message || 'Failed to delete network'));
    } finally {
      toast.dismiss(loadingId);
      setIsDeleting(false);
      setConfirmDeleteNetwork(null);
    }
  }, [confirmDeleteNetwork]);

  useEffect(() => {
    const controller = new AbortController();
    let stale = false;
    setLoading(true);
    setUnsupported(false);
    setOverview(null);
    setNetworks([]);
    setFindings([]);
    setRecentActivity([]);
    setIsLegacy(false);
    const load = async () => {
      try {
        const response = await apiFetch('/networking/overview', { nodeId, signal: controller.signal });
        if (response.status === 404) {
          if (!stale) setUnsupported(true);
          return;
        }
        if (!response.ok) throw new Error('Failed to load networking data.');
        const body = await response.json() as Partial<NetworkingOverviewEnvelope>;
        if (stale) return;
        const adapted = adaptNetworkingOverview(body);
        setIsLegacy(adapted.isLegacy);
        setRuntimeAvailable(adapted.runtimeAvailable);
        setOverview(adapted.overview);
        setNetworks(adapted.networks);
        setFindings(adapted.findings);
        setRecentActivity(adapted.recentActivity);
      } catch (error) {
        if (!stale && !(error instanceof DOMException && error.name === 'AbortError')) {
          console.error('[Networking] Failed to load overview:', error);
          toast.error('Failed to load networking data.');
        }
      } finally {
        if (!stale) setLoading(false);
      }
    };
    void load();
    return () => {
      stale = true;
      controller.abort();
    };
  }, [nodeId, reloadKey]);

  const openStack = useCallback((stackName: string, destination: SenchoOpenStackDetail['destination'] = 'stack') => {
    if (nodeId === undefined) return;
    window.dispatchEvent(new CustomEvent<SenchoOpenStackDetail>(SENCHO_OPEN_STACK_EVENT, {
      detail: { nodeId, stackName, destination },
    }));
  }, [nodeId]);

  const dispatchAction = useCallback(async (action: NetworkingRecommendedAction) => {
    switch (action.kind) {
      case 'open-stack':
      case 'open-stack-networking':
      case 'open-stack-doctor':
      case 'open-stack-editor':
      case 'open-stack-dossier':
      case 'open-stack-drift':
      case 'set-exposure-intent':
        openStack(action.stack, destinationForAction(action.kind));
        return;
      case 'create-network':
        if (!isAdmin) {
          toast.error('Creating networks requires admin access.');
          return;
        }
        setInitialNetworkName(action.networkName);
        setShowCreateNetwork(true);
        return;
      case 'inspect-network':
        setSelectedNetworkId(action.networkId);
        return;
      case 'filter-topology':
        setPendingTopologyFilter(action.networkName);
        setTab('topology');
        return;
      case 'refresh':
        setReloadKey((value) => value + 1);
        return;
      case 'open-docs':
        if (action.docsPath.startsWith('/features/') || action.docsPath.startsWith('/operations/')) {
          window.open(action.docsPath, '_blank', 'noopener,noreferrer');
        }
        return;
      case 'copy-compose-snippet':
      case 'copy-docker-command': {
        if (!canUseNetworkName(action.networkName)) {
          toast.error('Network name is not safe to copy.');
          return;
        }
        const text = action.kind === 'copy-compose-snippet'
          ? `networks:\n  ${action.networkName}:\n    external: true`
          : `docker network create ${action.networkName}`;
        try {
          await navigator.clipboard.writeText(text);
          toast.success('Copied to clipboard');
        } catch {
          toast.error('Failed to copy to clipboard.');
        }
        return;
      }
      default:
        return;
    }
  }, [isAdmin, openStack]);

  if (unsupported) {
    return (
      <LockCard
        icon={Unplug}
        title="Networking is not available on this node"
        body="Upgrade the node to use the Networking page."
      />
    );
  }

  const posture = getNetworkingPosture(findings, runtimeAvailable, isLegacy);
  const mobileTone = MOBILE_MASTHEAD_TONE[POSTURE_TONE[posture.tone]];
  const needsActionCount = findings.filter((f) => f.severity === 'critical' || f.severity === 'high').length;
  const reviewCount = findings.filter((f) => f.severity === 'medium').length;
  const driftCount = findings.filter((f) => isNetworkDriftFindingKind(f.kind)).length;

  const mastheadMetadata: MastheadMetadataItem[] | undefined = overview ? [
    { label: 'NEEDS ACTION', value: String(needsActionCount), tone: needsActionCount > 0 ? 'error' : 'value' },
    { label: 'REVIEW', value: String(reviewCount), tone: reviewCount > 0 ? 'warn' : 'value' },
    { label: 'DRIFT', value: overview.networkCount === null ? '—' : String(driftCount) },
  ] : undefined;

  const masthead = isMobile ? (
    <Masthead
      kicker="networking"
      state={posture.label}
      meta={activeNode?.name}
      right={headerActions}
      stateTone={mobileTone.dot}
      stateClassName={mobileTone.word}
      live={mobileTone.pulse}
    />
  ) : (
    <PageMasthead
      kicker="networking"
      state={posture.label}
      tone={POSTURE_TONE[posture.tone]}
      subtitle={isLegacy ? 'Update this node to unlock findings and attention.' : 'Compose-first network inventory, topology, and findings for this node.'}
      metadata={mastheadMetadata}
      size="hero"
      className="rounded-lg"
    />
  );

  const externalDependencies = networks.filter((n) => n.isExternalDependency);
  const sharedNetworks = networks.filter((n) => n.sharedStackCount >= 2);
  const unclassifiedExposureNetworks = networks.filter((n) => (n.exposureSummary?.unclassifiedStackCount ?? 0) > 0);
  const topFindings = rankFindings(findings).slice(0, 5);

  const overviewCards = overview ? (
    <div className="space-y-4">
      {!runtimeAvailable && !isLegacy && (
        <Card className="border-warning/40 bg-warning/5">
          <CardContent className="p-3 text-sm text-warning">Docker runtime is unavailable. Compose-model signals remain available.</CardContent>
        </Card>
      )}
      <div className="grid overflow-hidden rounded-lg border border-card-border bg-card shadow-card-bevel sm:grid-cols-2 xl:grid-cols-4">
        {[
          { label: 'Networks', value: overview.networkCount ?? '—', tab: 'networks' as const },
          { label: 'Managed', value: overview.senchoManagedNetworkCount ?? '—', tab: 'networks' as const },
          { label: 'External deps.', value: overview.externalDependencyNetworkCount ?? '—', tab: 'networks' as const },
          { label: 'System', value: overview.systemNetworkCount ?? '—', tab: 'networks' as const },
          { label: 'Exposed stacks', value: overview.exposedStackCount, tab: 'networks' as const },
          { label: 'Unknown exposure', value: overview.unknownExposureStackCount, tab: 'findings' as const },
          { label: 'Missing externals', value: overview.missingExternalCount, tab: 'findings' as const },
          { label: 'Collisions', value: overview.networkCollisionCount, tab: 'findings' as const },
        ].map((item) => (
          <button
            key={item.label}
            type="button"
            onClick={() => setTab(item.tab)}
            className="border-r border-b border-card-border p-4 text-left hover:bg-muted/20 sm:[&:nth-child(2n)]:border-r-0 xl:[&:nth-child(4n)]:border-r-0 xl:[&:nth-child(n+5)]:border-b-0"
          >
            <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-stat-subtitle">{item.label}</p>
            <p className="mt-1 text-2xl font-semibold tabular-nums text-stat-value">{item.value}</p>
          </button>
        ))}
      </div>

      <Card>
        <CardContent className="p-4">
          <div className="mb-2 flex items-center justify-between">
            <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-stat-subtitle">Operator attention</p>
            {findings.length > 5 && (
              <button type="button" className="text-xs text-brand hover:underline" onClick={() => setTab('findings')}>
                View all findings
              </button>
            )}
          </div>
          {isLegacy ? (
            <p className="text-sm text-stat-value">This node provides a partial networking response. Update it to review enriched findings.</p>
          ) : topFindings.length === 0 ? (
            <p className="text-sm text-stat-value">No networking issues detected.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-20">Severity</TableHead>
                  <TableHead>Finding</TableHead>
                  <TableHead>Stack</TableHead>
                  <TableHead className="w-44">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {topFindings.map((finding) => {
                  const primary = finding.recommendedActions.find((action) =>
                    isNetworkingActionVisible(action, isAdmin, (stack) => can('stack:edit', 'stack', stack, nodeId)),
                  );
                  return (
                    <TableRow key={finding.id}>
                      <TableCell className="w-20">
                        <span className={`font-mono text-[10px] uppercase tracking-wide ${SEVERITY_TEXT_CLASS[finding.severity]}`}>
                          {finding.severity}
                        </span>
                      </TableCell>
                      <TableCell className="text-sm text-stat-value">{finding.title}</TableCell>
                      <TableCell className="font-mono text-xs text-stat-subtitle">{finding.stack ?? finding.network ?? ''}</TableCell>
                      <TableCell className="w-44">
                        {primary && (
                          <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => void dispatchAction(primary)}>
                            {primary.label}
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {!isLegacy && (
        <div className="grid gap-4 md:grid-cols-3">
          <Card>
            <CardContent className="p-4">
              <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-stat-subtitle">External network dependencies</p>
              {externalDependencies.length === 0 ? (
                <p className="mt-2 text-sm text-stat-subtitle">No stack depends on an external network.</p>
              ) : (
                <ul className="mt-2 space-y-1 text-sm">
                  {externalDependencies.slice(0, 5).map((n) => (
                    <li key={n.id} className="flex items-center justify-between gap-2">
                      <span className="truncate font-mono text-xs">{n.name}</span>
                      <span className="text-xs text-stat-subtitle">{n.declaredExternalByStacks.join(', ')}</span>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-stat-subtitle">Shared networks</p>
              {sharedNetworks.length === 0 ? (
                <p className="mt-2 text-sm text-stat-subtitle">No network is shared across stacks.</p>
              ) : (
                <ul className="mt-2 space-y-1 text-sm">
                  {sharedNetworks.slice(0, 5).map((n) => (
                    <li key={n.id} className="flex items-center justify-between gap-2">
                      <span className="truncate font-mono text-xs">{n.name}</span>
                      <span className="text-xs text-stat-subtitle">{n.sharedStackCount} stacks</span>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-stat-subtitle">Exposure without intent</p>
              {unclassifiedExposureNetworks.length === 0 ? (
                <p className="mt-2 text-sm text-stat-subtitle">Every publishing service has a classified intent.</p>
              ) : (
                <ul className="mt-2 space-y-1 text-sm">
                  {unclassifiedExposureNetworks.slice(0, 5).map((n) => (
                    <li key={n.id} className="flex items-center justify-between gap-2">
                      <span className="truncate font-mono text-xs">{n.name}</span>
                      <span className="text-xs text-stat-subtitle">{n.exposureSummary?.unclassifiedStackCount ?? 0}</span>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </div>
      )}

      {recentActivity.length > 0 && (
        <Card>
          <CardContent className="p-4">
            <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-stat-subtitle">Recent activity</p>
            <ul className="mt-2 space-y-1 text-sm text-stat-subtitle">
              {recentActivity.slice(0, 5).map((activity) => (
                <li key={activity.id}>
                  {activity.stack_name ? (
                    <button type="button" className="hover:underline" onClick={() => openStack(activity.stack_name!)}>
                      {activity.message}
                    </button>
                  ) : activity.message}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
    </div>
  ) : null;

  const tabControls = (
    <TabsList className="border-transparent bg-transparent max-md:w-full max-md:overflow-x-auto max-md:[scrollbar-width:none]">
      <TabsHighlight className="rounded-md bg-brand/20" transition={springs.snappy}>
        {TABS.map(t => (
          <TabsHighlightItem key={t.value} value={t.value}>
            <TabsTrigger value={t.value}>
              <t.icon className="mr-1.5 h-4 w-4" strokeWidth={1.5} />
              {t.label}
            </TabsTrigger>
          </TabsHighlightItem>
        ))}
      </TabsHighlight>
    </TabsList>
  );

  return (
    <div className="h-full overflow-auto p-4 md:p-6">
      {masthead}

      <Tabs value={tab} onValueChange={(v) => setTab(v as NetworkingTab)}>
        {isMobile ? (
          <MobileSubTabs
            ariaLabel="Networking sections"
            active={tab}
            onSelect={(v) => setTab(v as NetworkingTab)}
            tabs={TABS.map(t => ({ value: t.value, label: t.label }))}
          />
        ) : (
          <div className="flex items-center justify-between gap-3 mb-4 mt-4 flex-wrap rounded-lg border border-card-border bg-card/40 px-2.5 py-1.5">
            {tabControls}
            <div className="flex items-center gap-2">
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setReloadKey(k => k + 1)}
                      disabled={loading}
                      className="h-9 w-9 p-0"
                      aria-label="Refresh"
                    >
                      <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Refresh</TooltipContent>
                </Tooltip>
              </TooltipProvider>
              {isAdmin && (
                <Button size="sm" className="gap-1.5" onClick={() => setShowCreateNetwork(true)}>
                  <Plus className="w-3.5 h-3.5" strokeWidth={1.5} />
                  Create network
                </Button>
              )}
            </div>
          </div>
        )}

        <TabsContent value="overview" className="mt-4">
          {loading ? <p className="text-sm text-muted-foreground">Loading overview…</p> : overviewCards}
          {overview && overview.renderFailedStacks.length > 0 && (
            <p className="mt-3 text-sm text-warning">
              {overview.renderFailedStacks.length} stack(s) could not render for full findings.
            </p>
          )}
        </TabsContent>

        <TabsContent value="networks" className="mt-4">
          <NetworkInventoryTable
            rows={networks}
            findings={findings}
            loading={loading}
            isAdmin={isAdmin}
            onInspect={(id) => setSelectedNetworkId(id)}
            onDelete={(id, name) => setConfirmDeleteNetwork({ id, name })}
            onOpenStack={openStack}
            onFilterTopology={(networkName) => {
              setPendingTopologyFilter(networkName);
              setTab('topology');
            }}
          />
        </TabsContent>

        <TabsContent value="topology" className="mt-4">
          {isLegacy ? (
            <Card>
              <CardContent className="p-4 text-sm text-stat-subtitle">
                Topology enrichment requires the complete networking response. Update this node to view it.
              </CardContent>
            </Card>
          ) : (
            <NetworkingTopologyPanel
              reloadKey={reloadKey}
              pendingNetworkFilter={pendingTopologyFilter}
              onPendingNetworkFilterApplied={() => setPendingTopologyFilter(undefined)}
              onOpenStack={openStack}
            />
          )}
        </TabsContent>

        <TabsContent value="findings" className="mt-4">
          <NetworkingFindingsList findings={findings} loading={loading} canEdit={can} isAdmin={isAdmin} onAction={dispatchAction} disabled={isLegacy} />
        </TabsContent>
      </Tabs>

      <CreateNetworkDialog
        open={showCreateNetwork}
        onOpenChange={setShowCreateNetwork}
        initialName={initialNetworkName}
        onCreated={({ name }) => {
          if (initialNetworkName) {
            const snippet = buildExternalNetworkSnippet(name);
            if (snippet) {
              toast.success(`Network "${name}" created`, {
                action: {
                  label: 'Copy Compose YAML',
                  onClick: () => {
                    void navigator.clipboard.writeText(snippet)
                      .then(() => toast.success('Compose YAML copied'))
                      .catch(() => toast.error('Failed to copy Compose YAML.'));
                  },
                },
              });
            }
          }
          setInitialNetworkName(undefined);
          setReloadKey(k => k + 1);
        }}
      />

      <NetworkDetailDrawer
        networkId={selectedNetworkId}
        onClose={() => setSelectedNetworkId(null)}
      />

      <ConfirmModal
        open={confirmDeleteNetwork !== null}
        onOpenChange={(open) => { if (!open) setConfirmDeleteNetwork(null); }}
        variant="destructive"
        kicker="NETWORKING · DELETE · IRREVERSIBLE"
        title="Delete network"
        confirmLabel={isDeleting ? 'Deleting...' : 'Delete'}
        confirming={isDeleting}
        onConfirm={handleDeleteNetwork}
      >
        <p className="text-sm text-stat-subtitle">
          Permanently deletes{' '}
          <span className="font-mono font-medium text-stat-value">
            {confirmDeleteNetwork?.name ?? confirmDeleteNetwork?.id.substring(0, 12)}
          </span>.
        </p>
      </ConfirmModal>
    </div>
  );
}
