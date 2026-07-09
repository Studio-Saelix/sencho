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
import { NetworkInventoryTable, type NetworkingNetworkRow } from './NetworkInventoryTable';
import { NetworkingFindingsList, type NetworkingFinding } from './NetworkingFindingsList';
import { NetworkingTopologyPanel } from './NetworkingTopologyPanel';

export type NetworkingTab = 'overview' | 'topology' | 'networks' | 'findings';

interface NodeNetworkingOverview {
  networkCount: number;
  stackCount: number;
  connectedContainerCount: number;
  systemNetworkCount: number;
  exposedStackCount: number;
  unknownExposureStackCount: number;
  missingExternalCount: number;
  networkCollisionCount: number;
  findingCount: number;
  renderFailedStacks: string[];
}

interface NetworkingViewProps {
  headerActions?: ReactNode;
}

const TABS: { value: NetworkingTab; label: string; icon: typeof LayoutDashboard }[] = [
  { value: 'overview', label: 'Overview', icon: LayoutDashboard },
  { value: 'topology', label: 'Topology', icon: GitBranch },
  { value: 'networks', label: 'Networks', icon: Network },
  { value: 'findings', label: 'Findings', icon: AlertTriangle },
];

export function NetworkingView({ headerActions }: NetworkingViewProps) {
  const { isAdmin } = useAuth();
  const { activeNode } = useNodes();
  const isMobile = useIsMobile();
  const nodeId = activeNode?.id;

  const [tab, setTab] = useState<NetworkingTab>('overview');
  const [loading, setLoading] = useState(true);
  const [unsupported, setUnsupported] = useState(false);
  const [overview, setOverview] = useState<NodeNetworkingOverview | null>(null);
  const [networks, setNetworks] = useState<NetworkingNetworkRow[]>([]);
  const [findings, setFindings] = useState<NetworkingFinding[]>([]);
  const [reloadKey, setReloadKey] = useState(0);
  const [showCreateNetwork, setShowCreateNetwork] = useState(false);
  const [selectedNetworkId, setSelectedNetworkId] = useState<string | null>(null);
  const [confirmDeleteNetwork, setConfirmDeleteNetwork] = useState<{ id: string; name: string } | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setUnsupported(false);
    try {
      const [overviewRes, findingsRes] = await Promise.all([
        apiFetch('/networking/overview'),
        apiFetch('/networking/findings'),
      ]);
      if (overviewRes.status === 404) {
        setUnsupported(true);
        return;
      }
      if (!overviewRes.ok) throw new Error('overview failed');
      const overviewBody = await overviewRes.json() as { overview: NodeNetworkingOverview; networks: NetworkingNetworkRow[] };
      setOverview(overviewBody.overview);
      setNetworks(overviewBody.networks);
      if (findingsRes.ok) {
        setFindings(await findingsRes.json() as NetworkingFinding[]);
      }
    } catch {
      toast.error('Failed to load networking data.');
    } finally {
      setLoading(false);
    }
  }, []);

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
    void load();
  }, [load, nodeId, reloadKey]);

  if (unsupported) {
    return (
      <LockCard
        icon={Unplug}
        title="Networking is not available on this node"
        body="Upgrade the node to use the Networking page."
      />
    );
  }

  const masthead = isMobile ? (
    <Masthead
      kicker="networking"
      state="Networking"
      meta={activeNode?.name}
      right={headerActions}
    />
  ) : (
    <PageMasthead
      kicker="networking"
      state="Networking"
      tone="live"
      subtitle="Compose-first network inventory, topology, and findings for this node."
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
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      {[
        { label: 'Networks', value: overview.networkCount },
        { label: 'Stacks', value: overview.stackCount },
        { label: 'Connected containers', value: overview.connectedContainerCount },
        { label: 'Findings', value: overview.findingCount },
        { label: 'Exposed stacks', value: overview.exposedStackCount },
        { label: 'Unknown exposure', value: overview.unknownExposureStackCount },
        { label: 'Missing external', value: overview.missingExternalCount },
        { label: 'Name collisions', value: overview.networkCollisionCount },
      ].map(item => (
        <Card key={item.label} className="border-card-border bg-card/40">
          <CardContent className="p-4">
            <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-stat-subtitle">{item.label}</p>
            <p className="mt-1 text-2xl font-semibold tabular-nums text-stat-value">{item.value}</p>
          </CardContent>
        </Card>
      ))}
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
          <NetworkingTopologyPanel reloadKey={reloadKey} />
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
          />
        </TabsContent>

        <TabsContent value="findings" className="mt-4 flex-1 overflow-auto">
          <NetworkingFindingsList findings={findings} loading={loading} />
        </TabsContent>
      </Tabs>

      <CreateNetworkDialog
        open={showCreateNetwork}
        onOpenChange={setShowCreateNetwork}
        onCreated={() => setReloadKey(k => k + 1)}
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
