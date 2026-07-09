import { useState } from 'react';
import { Label } from '@/components/ui/label';
import { TogglePill } from '@/components/ui/toggle-pill';
import NetworkTopologyView from '@/components/NetworkTopologyView';
import { CapabilityGate } from '@/components/CapabilityGate';
import { SENCHO_OPEN_LOGS_EVENT, type SenchoOpenLogsDetail } from '@/lib/events';

export function NetworkingTopologyPanel({ reloadKey }: { reloadKey: number }) {
  const [includeSystem, setIncludeSystem] = useState(false);

  return (
    <CapabilityGate capability="network-topology" featureName="Network Topology">
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <TogglePill id="networking-topology-system" checked={includeSystem} onChange={setIncludeSystem} />
          <Label htmlFor="networking-topology-system" className="text-xs cursor-pointer">
            Include system networks
          </Label>
        </div>
        <NetworkTopologyView
          key={`${reloadKey}-${includeSystem}`}
          endpoint="/networking/topology"
          showSystemToggle={false}
          includeSystem={includeSystem}
          onContainerClick={(id, name) => {
            window.dispatchEvent(new CustomEvent<SenchoOpenLogsDetail>(SENCHO_OPEN_LOGS_EVENT, {
              detail: { containerId: id, containerName: name },
            }));
          }}
        />
      </div>
    </CapabilityGate>
  );
}
