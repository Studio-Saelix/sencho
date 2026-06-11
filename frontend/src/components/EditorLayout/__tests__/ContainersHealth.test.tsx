import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('@/lib/clipboard', () => ({ copyToClipboard: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../Terminal', () => ({ default: () => null }));
vi.mock('../../StructuredLogViewer', () => ({ default: () => null }));
vi.mock('../../ImageSourceMenu', () => ({ ImageSourceMenu: () => null }));

import { ContainersHealth } from '../editor-view-blocks';
import { copyToClipboard } from '@/lib/clipboard';
import type { ContainerInfo } from '../EditorView';
import type { Node } from '@/context/NodeContext';

const LOCAL_NODE = { id: 1, type: 'local' } as Node;

function container(ports: { PrivatePort: number; PublicPort: number }[]): ContainerInfo {
  return {
    Id: 'abc123def456',
    Names: ['/web'],
    State: 'running',
    Status: 'Up 2 hours',
    Image: 'nginx',
    Ports: ports,
  } as unknown as ContainerInfo;
}

function renderHealth(c: ContainerInfo, activeNode: Node | null = LOCAL_NODE) {
  return render(
    <ContainersHealth
      safeContainers={[c]}
      containerStats={{}}
      containerStatsError={null}
      isAdmin
      activeNode={activeNode}
      openLogViewer={vi.fn()}
      openBashModal={vi.fn()}
      serviceAction={vi.fn()}
    />,
  );
}

describe('ContainersHealth published port link', () => {
  beforeEach(() => {
    vi.mocked(copyToClipboard).mockClear();
  });

  it('renders the port mapping as a real anchor with safe new-tab attributes', () => {
    renderHealth(container([{ PrivatePort: 80, PublicPort: 8080 }]));
    const link = screen.getByRole('link', { name: /8080/ });
    expect(link).toHaveAttribute('href', 'http://localhost:8080');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('uses https when the container port is 443', () => {
    renderHealth(container([{ PrivatePort: 443, PublicPort: 8443 }]));
    expect(screen.getByRole('link', { name: /8443/ })).toHaveAttribute('href', 'https://localhost:8443');
  });

  it('appends the known service path for a recognised app, keyed by the container port', () => {
    renderHealth(container([{ PrivatePort: 32400, PublicPort: 12345 }]));
    expect(screen.getByRole('link', { name: /12345/ })).toHaveAttribute('href', 'http://localhost:12345/web');
  });

  it('copies the service URL from the row', async () => {
    renderHealth(container([{ PrivatePort: 80, PublicPort: 8080 }]));
    fireEvent.click(screen.getByRole('button', { name: 'Copy service URL' }));
    await waitFor(() => expect(copyToClipboard).toHaveBeenCalledWith('http://localhost:8080'));
  });

  it('shows the port as plain text (no link) for a remote node with no reachable host', () => {
    renderHealth(container([{ PrivatePort: 80, PublicPort: 8080 }]), { id: 2, type: 'remote', api_url: '' } as Node);
    expect(screen.queryByRole('link', { name: /8080/ })).toBeNull();
    expect(screen.getByText(/8080 → 80\/tcp/)).toBeInTheDocument();
  });
});
