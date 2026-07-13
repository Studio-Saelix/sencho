import { useEffect, useState, type ReactNode } from 'react';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { SystemSheet, SheetSection } from '@/components/ui/system-sheet';
import { ScrollText, Search } from 'lucide-react';
import { cn } from '@/lib/utils';
import NetworkTopologyView from '@/components/NetworkTopologyView';
import { CapabilityGate } from '@/components/CapabilityGate';
import { SENCHO_OPEN_LOGS_EVENT, type SenchoOpenLogsDetail } from '@/lib/events';
import {
  DEFAULT_TOPOLOGY_FILTERS,
  formatTopologyPort,
  isMissingTopologyNetwork,
  type NetworkingTopologyFilters,
  type TopologyOwnershipFilter,
} from '@/lib/networkingTopology';
import type { NetworkingTopologyContainerDetail, NetworkingTopologyNetwork } from '@/types/networking';
import { NetworkDetailDrawer } from './NetworkDetailDrawer';

const BOOLEAN_FILTERS: { key: keyof Pick<NetworkingTopologyFilters, 'exposedOnly' | 'driftOnly' | 'missingExternalOnly' | 'sharedOnly'>; label: string }[] = [
  { key: 'exposedOnly', label: 'Exposed' },
  { key: 'driftOnly', label: 'Drift' },
  { key: 'missingExternalOnly', label: 'Missing external' },
  { key: 'sharedOnly', label: 'Shared' },
];

const OWNERSHIP_OPTIONS: { key: TopologyOwnershipFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'managed', label: 'Sencho-managed' },
  { key: 'external', label: 'External' },
  { key: 'system', label: 'System' },
];

// Chip toggle mirroring the Fleet Map filter strip so the two topology-style
// views share one filter affordance.
function FilterChip({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-md border px-2 py-1 font-mono text-[10px] uppercase tracking-[0.12em] transition-colors',
        active
          ? 'border-brand/60 bg-brand/15 text-brand'
          : 'border-card-border text-muted-foreground hover:text-foreground hover:bg-muted/40',
      )}
    >
      {children}
    </button>
  );
}

export function NetworkingTopologyPanel({
  reloadKey,
  pendingNetworkFilter,
  onPendingNetworkFilterApplied,
  onOpenStack,
}: {
  reloadKey: number;
  pendingNetworkFilter?: string;
  onPendingNetworkFilterApplied: () => void;
  onOpenStack: (stack: string) => void;
}) {
  const [includeSystem, setIncludeSystem] = useState(false);
  const [filters, setFilters] = useState<NetworkingTopologyFilters>(DEFAULT_TOPOLOGY_FILTERS);
  const [selectedNetwork, setSelectedNetwork] = useState<NetworkingTopologyNetwork | null>(null);
  const [selectedContainer, setSelectedContainer] = useState<NetworkingTopologyContainerDetail | null>(null);

  useEffect(() => {
    if (!pendingNetworkFilter) return;
    setFilters((value) => ({ ...value, network: pendingNetworkFilter }));
    onPendingNetworkFilterApplied();
  }, [pendingNetworkFilter, onPendingNetworkFilterApplied]);

  const missingSelected = selectedNetwork !== null && isMissingTopologyNetwork(selectedNetwork);

  const viewLogs = () => {
    if (!selectedContainer) return;
    window.dispatchEvent(new CustomEvent<SenchoOpenLogsDetail>(SENCHO_OPEN_LOGS_EVENT, {
      detail: { containerId: selectedContainer.id, containerName: selectedContainer.name },
    }));
  };

  return (
    <CapabilityGate capability="network-topology" featureName="Network Topology">
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
            <Input
              className="h-8 w-56 pl-8 text-sm"
              placeholder="Filter stack or service…"
              value={filters.stack}
              onChange={(event) => setFilters((value) => ({ ...value, stack: event.target.value }))}
            />
          </div>
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
            <Input
              className="h-8 w-48 pl-8 text-sm"
              placeholder="Filter network…"
              value={filters.network}
              onChange={(event) => setFilters((value) => ({ ...value, network: event.target.value }))}
            />
          </div>
          <SegmentedControl
            value={filters.ownership}
            onChange={(key) => setFilters((value) => ({ ...value, ownership: key }))}
            ariaLabel="Network ownership"
            options={OWNERSHIP_OPTIONS.map(({ key, label }) => ({ value: key, label }))}
          />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <FilterChip active={includeSystem} onClick={() => setIncludeSystem(!includeSystem)}>
            Include system
          </FilterChip>
          {BOOLEAN_FILTERS.map(({ key, label }) => (
            <FilterChip key={key} active={filters[key]} onClick={() => setFilters((value) => ({ ...value, [key]: !value[key] }))}>
              {label}
            </FilterChip>
          ))}
        </div>
        <NetworkTopologyView
          key={`${reloadKey}-${includeSystem}`}
          endpoint="/networking/topology"
          showSystemToggle={false}
          includeSystem={includeSystem}
          filters={filters}
          onNetworkClick={setSelectedNetwork}
          onContainerSelect={setSelectedContainer}
          onStackClick={onOpenStack}
        />
        <NetworkDetailDrawer
          networkId={selectedNetwork && !isMissingTopologyNetwork(selectedNetwork) ? selectedNetwork.id : null}
          onClose={() => setSelectedNetwork(null)}
        />
        <SystemSheet
          open={missingSelected}
          onOpenChange={(open) => { if (!open) setSelectedNetwork(null); }}
          crumb={['Networking', 'Topology', selectedNetwork?.name ?? 'Missing external network']}
          name={selectedNetwork?.name ?? 'Missing external network'}
          meta="External dependency · not present in Docker"
          size="md"
        >
          {selectedNetwork && (
            <SheetSection title="Missing external network">
              <p className="text-sm text-warning">
                This external dependency is declared by Compose but is not present in Docker.
              </p>
              <div className="mt-3 space-y-2 text-sm">
                <div>
                  <span className="text-xs text-stat-subtitle">Declaring stacks</span>
                  <p className="mt-0.5">{selectedNetwork.declaredExternalByStacks.join(', ') || 'none'}</p>
                </div>
                <div>
                  <span className="text-xs text-stat-subtitle">Finding IDs</span>
                  <p className="mt-0.5 font-mono text-xs">{selectedNetwork.findingIds.join(', ') || 'none'}</p>
                </div>
              </div>
            </SheetSection>
          )}
        </SystemSheet>
        <SystemSheet
          open={selectedContainer !== null}
          onOpenChange={(open) => { if (!open) setSelectedContainer(null); }}
          crumb={['Networking', 'Topology', selectedContainer?.name ?? 'Container']}
          name={selectedContainer?.name ?? 'Container'}
          meta={selectedContainer ? `${selectedContainer.state} · ${selectedContainer.image}` : ''}
          size="md"
          primaryAction={selectedContainer && selectedContainer.state === 'running' ? {
            label: 'View logs',
            icon: ScrollText,
            onClick: viewLogs,
          } : undefined}
        >
          {selectedContainer && (
            <>
              <SheetSection title="Overview">
                <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                  <div>
                    <span className="text-xs text-muted-foreground">Stack</span>
                    <p className="mt-0.5 text-xs">
                      {selectedContainer.stack ? (
                        <button
                          type="button"
                          className="font-mono text-brand hover:underline"
                          onClick={() => onOpenStack(selectedContainer.stack!)}
                        >
                          {selectedContainer.stack}
                        </button>
                      ) : 'none'}
                    </p>
                  </div>
                  <div>
                    <span className="text-xs text-muted-foreground">Service</span>
                    <p className="mt-0.5 text-xs">{selectedContainer.service ?? 'none'}</p>
                  </div>
                  <div>
                    <span className="text-xs text-muted-foreground">Exposure intent</span>
                    <p className="mt-0.5 text-xs">{selectedContainer.exposureIntent ?? 'unknown'}</p>
                  </div>
                  <div>
                    <span className="text-xs text-muted-foreground">Aliases</span>
                    <p className="mt-0.5 text-xs">{selectedContainer.composeAliases.join(', ') || 'none'}</p>
                  </div>
                </div>
              </SheetSection>
              <SheetSection title="Network attachments">
                <div className="divide-y divide-card-border/40">
                  {selectedContainer.attachments.map((attachment) => (
                    <div key={attachment.network} className="flex items-center justify-between py-1.5">
                      <Badge variant="outline" className="h-5 font-mono text-[10px]">{attachment.network}</Badge>
                      <span className="font-mono text-xs tabular-nums">{attachment.ip?.replace(/\/\d+$/, '') || 'N/A'}</span>
                    </div>
                  ))}
                </div>
              </SheetSection>
              <SheetSection title="Published ports">
                <p className="text-xs">{selectedContainer.publishedPorts.map(formatTopologyPort).join(', ') || 'none'}</p>
              </SheetSection>
              <SheetSection title="Findings and drift">
                <div className="space-y-1 text-xs">
                  <p><span className="text-stat-subtitle">Findings</span> {selectedContainer.findingIds.join(', ') || 'none'}</p>
                  <p><span className="text-stat-subtitle">Drift</span> {selectedContainer.driftFlags.join(', ') || 'none'}</p>
                </div>
              </SheetSection>
            </>
          )}
        </SystemSheet>
      </div>
    </CapabilityGate>
  );
}
