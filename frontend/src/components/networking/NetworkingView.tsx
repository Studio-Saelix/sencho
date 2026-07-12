import { useCallback, useEffect, useState, type ReactNode } from 'react';
import {
  LayoutDashboard, Network, GitBranch, AlertTriangle, RefreshCw, Plus, Unplug,
} from 'lucide-react';
import { Tabs, TabsContent, TabsList, TabsTrigger, TabsHighlight, TabsHighlightItem } from '@/components/ui/tabs';
import { PageMasthead } from '@/components/ui/PageMasthead';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { LockCard } from '@/components/ui/LockCard';
import { apiFetch } from '@/lib/api';
import { toast } from '@/components/ui/toast-store';
import { useAuth } from '@/context/AuthContext';
import { useNodes } from '@/context/NodeContext';
import { useIsMobile } from '@/hooks/use-is-mobile';
import { Masthead, MobileSubTabs } from '@/components/mobile/mobile-ui';
import { springs } from '@/lib/motion';
import { CreateNetworkDialog } from '@/components/resources/CreateNetworkDialog';
import { ConfirmModal } from '@/components/ui/modal';
import { NetworkDetailDrawer } from './NetworkDetailDrawer';
import { NetworkInventoryTable } from './NetworkInventoryTable';
import { NetworkingFindingsList, isNetworkingActionVisible } from './NetworkingFindingsList';
import { NetworkingTopologyPanel } from './NetworkingTopologyPanel';
import { SENCHO_OPEN_STACK_EVENT, type SenchoOpenStackDetail } from '@/lib/events';
import {
  adaptNetworkingOverview, buildExternalNetworkSnippet, canUseNetworkName, getNetworkingPosture,
} from '@/lib/networking';
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
  { value: 'topology', label: 'Topology', icon: GitBranch },
  { value: 'networks', label: 'Networks', icon: Network },
  { value: 'findings', label: 'Findings', icon: AlertTriangle },
];

const POSTURE_TONE: Record<ReturnType<typeof getNetworkingPosture>['tone'], 'error' | 'warn' | 'idle' | 'live'> = {
  critical: 'error',
  warning: 'warn',
  neutral: 'idle',
  live: 'live',
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
  const masthead = isMobile ? (
    <Masthead
      kicker="networking"
      state={posture.label}
      meta={activeNode?.name}
      right={headerActions}
    />
  ) : (
    <PageMasthead
      kicker="networking"
      state={posture.label}
      tone={POSTURE_TONE[posture.tone]}
      subtitle={isLegacy ? 'Update this node to unlock findings and attention.' : 'Compose-first network inventory, topology, and findings for this node.'}
      size="hero"
      className="rounded-lg"
    >
      <Button variant="outline" size="sm" className="gap-1.5" onClick={() => setReloadKey(k => k + 1)} disabled={loading}>
        <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} strokeWidth={1.5} />
        Refresh
      </Button>
    </PageMasthead>
  );

  const overviewCards = overview ? (
    <div className="space-y-4">
      {!runtimeAvailable && !isLegacy && (
        <Card className="border-warning/40 bg-warning/5">
          <CardContent className="p-3 text-sm text-warning">Docker runtime is unavailable. Compose-model signals remain available.</CardContent>
        </Card>
      )}
      <div className="grid overflow-hidden rounded-lg border border-card-border bg-card shadow-card-bevel sm:grid-cols-2 xl:grid-cols-4">
        {[
          { label: 'Needs action', value: findings.filter((finding) => finding.severity === 'critical' || finding.severity === 'high').length, tab: 'findings' as const },
          { label: 'Review', value: findings.filter((finding) => finding.severity === 'medium').length, tab: 'findings' as const },
          { label: 'Networks', value: overview.networkCount ?? '—', tab: 'networks' as const },
          { label: 'Exposed stacks', value: overview.exposedStackCount, tab: 'networks' as const },
        ].map((item) => (
          <button
            key={item.label}
            type="button"
            onClick={() => setTab(item.tab)}
            className="border-r border-card-border p-4 text-left last:border-r-0 hover:bg-muted/20"
          >
            <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-stat-subtitle">{item.label}</p>
            <p className="mt-1 text-2xl font-semibold tabular-nums text-stat-value">{item.value}</p>
          </button>
        ))}
      </div>
      <Card>
        <CardContent className="p-4">
          <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-stat-subtitle">Operator attention</p>
          <p className="mt-1 text-sm text-stat-value">
            {isLegacy
              ? 'This node provides a partial networking response. Update it to review enriched findings.'
              : findings.length
                ? `${findings.length} finding${findings.length === 1 ? '' : 's'} need review on this node.`
                : 'No networking findings need attention.'}
          </p>
          {!isLegacy && (() => {
            const primary = findings[0]?.recommendedActions.find((action) =>
              isNetworkingActionVisible(action, can, isAdmin),
            );
            return primary ? (
              <Button className="mt-3" size="sm" onClick={() => void dispatchAction(primary)}>
                {primary.label}
              </Button>
            ) : null;
          })()}
        </CardContent>
      </Card>
      {recentActivity.length > 0 && (
        <Card>
          <CardContent className="p-4">
            <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-stat-subtitle">Recent activity</p>
            <ul className="mt-2 space-y-1 text-sm text-stat-subtitle">
              {recentActivity.slice(0, 5).map((activity) => <li key={activity.id}>{activity.message}</li>)}
            </ul>
          </CardContent>
        </Card>
      )}
    </div>
  ) : null;

  const tabControls = isMobile ? (
    <MobileSubTabs
      ariaLabel="Networking sections"
      active={tab}
      onSelect={(v) => setTab(v as NetworkingTab)}
      tabs={TABS.map(t => ({ value: t.value, label: t.label }))}
    />
  ) : (
    <TabsList className="border-transparent bg-transparent">
      <TabsHighlight className="rounded-md bg-brand/20" transition={springs.snappy}>
        {TABS.map(t => (
          <TabsHighlightItem key={t.value} value={t.value}>
            <TabsTrigger value={t.value} className="gap-1.5">
              <t.icon className="w-3.5 h-3.5" strokeWidth={1.5} />
              {t.label}
            </TabsTrigger>
          </TabsHighlightItem>
        ))}
      </TabsHighlight>
    </TabsList>
  );

  return (
    <div className="flex h-full flex-col gap-4 p-4 md:p-6">
      {masthead}

      <Tabs value={tab} onValueChange={(v) => setTab(v as NetworkingTab)} className="flex min-h-0 flex-1 flex-col">
        {!isMobile && <div className="mb-2">{tabControls}</div>}
        {isMobile && tabControls}

        <TabsContent value="overview" className="mt-4 flex-1 overflow-auto">
          {loading ? <p className="text-sm text-muted-foreground">Loading overview…</p> : overviewCards}
          {overview && overview.renderFailedStacks.length > 0 && (
            <p className="mt-3 text-sm text-warning">
              {overview.renderFailedStacks.length} stack(s) could not render for full findings.
            </p>
          )}
        </TabsContent>

        <TabsContent value="topology" className="mt-4 flex-1 overflow-auto">
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
            />
          )}
        </TabsContent>

        <TabsContent value="networks" className="mt-4 flex-1 overflow-auto">
          <div className="mb-3 flex justify-end">
            {isAdmin && (
              <Button variant="outline" size="sm" className="gap-1.5" onClick={() => setShowCreateNetwork(true)}>
                <Plus className="w-3.5 h-3.5" strokeWidth={1.5} />
                Create network
              </Button>
            )}
          </div>
          <NetworkInventoryTable
            rows={networks}
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

        <TabsContent value="findings" className="mt-4 flex-1 overflow-auto">
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
