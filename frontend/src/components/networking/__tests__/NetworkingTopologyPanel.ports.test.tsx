/**
 * The container sheet renders the published-port line from the topology facts,
 * not from the authored `published`/`target` fields. A fixed port, a fixed
 * range, and an auto-assigned port each read as a real host and port, and the
 * line never shows `undefined`.
 */
import type { ReactNode } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { NetworkingTopologyContainerDetail } from '@/types/networking';

const selectedContainer: NetworkingTopologyContainerDetail = {
  id: 'container-1',
  name: 'port-probe-web',
  stack: 'port-probe',
  service: 'web',
  image: 'nginx:alpine',
  state: 'running',
  attachments: [{ network: 'bridge', ip: '172.17.0.2' }],
  composeAliases: ['web'],
  publishedPorts: [
    { hostIp: '', startPort: 18080, endPort: 18080, protocol: 'tcp', allInterfaces: true, loopbackOnly: false },
    { hostIp: '', startPort: 18081, endPort: 18082, protocol: 'tcp', allInterfaces: true, loopbackOnly: false },
    { hostIp: '', startPort: 0, endPort: 0, protocol: 'tcp', dynamic: true, allInterfaces: true, loopbackOnly: false },
  ],
  exposureIntent: null,
  findingIds: [],
  driftFlags: [],
};

vi.mock('@/components/CapabilityGate', () => ({
  CapabilityGate: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock('@/components/NetworkTopologyView', () => ({
  default: ({ onContainerSelect }: { onContainerSelect: (container: NetworkingTopologyContainerDetail) => void }) => (
    <button type="button" onClick={() => onContainerSelect(selectedContainer)}>select probe container</button>
  ),
}));
vi.mock('@/components/networking/NetworkDetailDrawer', () => ({ NetworkDetailDrawer: () => null }));

import { NetworkingTopologyPanel } from '../NetworkingTopologyPanel';

describe('NetworkingTopologyPanel published ports', () => {
  it('renders fixed, ranged, and auto-assigned publications from the topology facts', async () => {
    const user = userEvent.setup();
    render(
      <NetworkingTopologyPanel
        reloadKey={0}
        onPendingNetworkFilterApplied={() => {}}
        onOpenStack={() => {}}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'select probe container' }));

    const sheet = await screen.findByRole('dialog', { name: 'port-probe-web' });
    expect(within(sheet).getByText('Published ports')).toBeInTheDocument();
    const line = '0.0.0.0:18080/tcp, 0.0.0.0:18081-18082/tcp, 0.0.0.0:auto/tcp';
    expect(within(sheet).getByText(line)).toBeInTheDocument();
    expect(within(sheet).queryByText(/undefined/)).toBeNull();
  });
});
