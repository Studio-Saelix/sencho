import { useEffect, useState } from 'react';
import { Label } from '@/components/ui/label';
import { TogglePill } from '@/components/ui/toggle-pill';
import { Input } from '@/components/ui/input';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import NetworkTopologyView from '@/components/NetworkTopologyView';
import { CapabilityGate } from '@/components/CapabilityGate';
import { SENCHO_OPEN_LOGS_EVENT, type SenchoOpenLogsDetail } from '@/lib/events';
import {
  DEFAULT_TOPOLOGY_FILTERS,
  formatTopologyPort,
  isMissingTopologyNetwork,
  type NetworkingTopologyFilters,
} from '@/lib/networkingTopology';
import type { NetworkingTopologyContainer, NetworkingTopologyNetwork } from '@/types/networking';
import { NetworkDetailDrawer } from './NetworkDetailDrawer';

const BOOLEAN_FILTERS: { key: keyof Pick<NetworkingTopologyFilters, 'exposedOnly' | 'driftOnly' | 'missingExternalOnly' | 'sharedOnly'>; label: string }[] = [
  { key: 'exposedOnly', label: 'Exposed' },
  { key: 'driftOnly', label: 'Drift' },
  { key: 'missingExternalOnly', label: 'Missing external' },
  { key: 'sharedOnly', label: 'Shared' },
];

export function NetworkingTopologyPanel({
  reloadKey,
  pendingNetworkFilter,
  onPendingNetworkFilterApplied,
}: {
  reloadKey: number;
  pendingNetworkFilter?: string;
  onPendingNetworkFilterApplied: () => void;
}) {
  const [includeSystem, setIncludeSystem] = useState(false);
  const [filters, setFilters] = useState<NetworkingTopologyFilters>(DEFAULT_TOPOLOGY_FILTERS);
  const [selectedNetwork, setSelectedNetwork] = useState<NetworkingTopologyNetwork | null>(null);
  const [selectedContainer, setSelectedContainer] = useState<NetworkingTopologyContainer | null>(null);

  useEffect(() => {
    if (!pendingNetworkFilter) return;
    setFilters((value) => ({ ...value, network: pendingNetworkFilter }));
    onPendingNetworkFilterApplied();
  }, [pendingNetworkFilter, onPendingNetworkFilterApplied]);

  const missingSelected = selectedNetwork !== null && isMissingTopologyNetwork(selectedNetwork);

  return (
    <CapabilityGate capability="network-topology" featureName="Network Topology">
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <TogglePill id="networking-topology-system" checked={includeSystem} onChange={setIncludeSystem} />
          <Label htmlFor="networking-topology-system" className="text-xs cursor-pointer">
            Include system networks
          </Label>
        </div>
        <div className="flex flex-wrap gap-2">
          <Input
            className="h-8 max-w-48"
            placeholder="Filter stack or service"
            value={filters.stack}
            onChange={(event) => setFilters((value) => ({ ...value, stack: event.target.value }))}
          />
          <Input
            className="h-8 max-w-48"
            placeholder="Filter network"
            value={filters.network}
            onChange={(event) => setFilters((value) => ({ ...value, network: event.target.value }))}
          />
          {BOOLEAN_FILTERS.map(({ key, label }) => (
            <div key={key} className="flex items-center gap-1.5">
              <TogglePill
                id={`topology-${key}`}
                checked={filters[key]}
                onChange={(next) => setFilters((value) => ({ ...value, [key]: next }))}
              />
              <Label htmlFor={`topology-${key}`} className="text-xs">{label}</Label>
            </div>
          ))}
        </div>
        <div className="flex flex-wrap gap-2 font-mono text-[10px] uppercase tracking-[0.14em] text-stat-subtitle">
          <span>Sencho-managed</span><span>Compose-managed</span><span>Unmanaged</span><span>System</span>
          <span>Exposed</span><span>Drift</span><span>Missing external</span>
        </div>
        <NetworkTopologyView
          key={`${reloadKey}-${includeSystem}`}
          endpoint="/networking/topology"
          showSystemToggle={false}
          includeSystem={includeSystem}
          filters={filters}
          onNetworkClick={setSelectedNetwork}
          onContainerSelect={setSelectedContainer}
          onContainerClick={(id, name) => {
            window.dispatchEvent(new CustomEvent<SenchoOpenLogsDetail>(SENCHO_OPEN_LOGS_EVENT, {
              detail: { containerId: id, containerName: name },
            }));
          }}
        />
        <NetworkDetailDrawer
          networkId={selectedNetwork && !isMissingTopologyNetwork(selectedNetwork) ? selectedNetwork.id : null}
          onClose={() => setSelectedNetwork(null)}
        />
        <Sheet open={missingSelected} onOpenChange={(open) => { if (!open) setSelectedNetwork(null); }}>
          <SheetContent>
            <SheetHeader>
              <SheetTitle>{selectedNetwork?.name ?? 'Missing external network'}</SheetTitle>
            </SheetHeader>
            {selectedNetwork && (
              <div className="mt-4 space-y-3 text-sm">
                <p className="text-warning">
                  This external dependency is declared by Compose but is not present in Docker.
                </p>
                <p>
                  <span className="text-stat-subtitle">Declaring stacks</span>
                  <br />
                  {selectedNetwork.declaredExternalByStacks.join(', ') || 'none'}
                </p>
                <p>
                  <span className="text-stat-subtitle">Finding IDs</span>
                  <br />
                  {selectedNetwork.findingIds.join(', ') || 'none'}
                </p>
              </div>
            )}
          </SheetContent>
        </Sheet>
        <Sheet open={selectedContainer !== null} onOpenChange={(open) => { if (!open) setSelectedContainer(null); }}>
          <SheetContent>
            <SheetHeader>
              <SheetTitle>{selectedContainer?.name ?? 'Container'}</SheetTitle>
            </SheetHeader>
            {selectedContainer && (
              <div className="mt-4 space-y-3 text-sm">
                <p>
                  <span className="text-stat-subtitle">Service</span>
                  <br />
                  {selectedContainer.service ?? 'none'}
                </p>
                <p>
                  <span className="text-stat-subtitle">Exposure intent</span>
                  <br />
                  {selectedContainer.exposureIntent ?? 'unknown'}
                </p>
                <p>
                  <span className="text-stat-subtitle">Aliases</span>
                  <br />
                  {selectedContainer.composeAliases.join(', ') || 'none'}
                </p>
                <p>
                  <span className="text-stat-subtitle">Published ports</span>
                  <br />
                  {selectedContainer.publishedPorts.map(formatTopologyPort).join(', ') || 'none'}
                </p>
                <p>
                  <span className="text-stat-subtitle">Findings</span>
                  <br />
                  {selectedContainer.findingIds.join(', ') || 'none'}
                </p>
                <p>
                  <span className="text-stat-subtitle">Drift</span>
                  <br />
                  {selectedContainer.driftFlags.join(', ') || 'none'}
                </p>
              </div>
            )}
          </SheetContent>
        </Sheet>
      </div>
    </CapabilityGate>
  );
}
