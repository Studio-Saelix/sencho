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

function container(ports: { PrivatePort: number; PublicPort: number; Type?: string }[]): ContainerInfo {
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

  it('does not render a link for a UDP-only published port', () => {
    renderHealth(container([{ PrivatePort: 53, PublicPort: 5353, Type: 'udp' }]));
    expect(screen.queryByRole('link', { name: /5353/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Copy service URL' })).toBeNull();
  });

  it('shows the port as plain text (no link) for a remote node with no reachable host', () => {
    renderHealth(container([{ PrivatePort: 80, PublicPort: 8080 }]), { id: 2, type: 'remote', api_url: '' } as Node);
    expect(screen.queryByRole('link', { name: /8080/ })).toBeNull();
    expect(screen.getByText(/8080 → 80\/tcp/)).toBeInTheDocument();
  });
});

describe('density toggle and summary strip', () => {
  function makeContainer(overrides: Partial<ContainerInfo> = {}): ContainerInfo {
    return {
      Id: overrides.Id || 'abc',
      Names: overrides.Names || ['/app'],
      State: overrides.State || 'running',
      Status: overrides.Status || 'Up 1 hour',
      Image: overrides.Image || 'nginx',
      ...overrides,
    } as unknown as ContainerInfo;
  }

  function renderMany(containers: ContainerInfo[]) {
    return render(
      <ContainersHealth
        safeContainers={containers}
        containerStats={{}}
        containerStatsError={null}
        isAdmin
        activeNode={LOCAL_NODE}
        openLogViewer={vi.fn()}
        openBashModal={vi.fn()}
        serviceAction={vi.fn()}
      />,
    );
  }

  it('does not render summary strip or density toggle for a single container', () => {
    renderMany([makeContainer()]);
    expect(screen.queryByText(/container/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Compact view' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Detailed view' })).toBeNull();
  });

  it('renders summary counts for multiple containers', () => {
    renderMany([
      makeContainer({ Id: 'a', State: 'running' }),
      makeContainer({ Id: 'b', State: 'running' }),
      makeContainer({ Id: 'c', State: 'paused' }),
    ]);
    expect(screen.getByText(/3 containers/i)).toBeInTheDocument();
    expect(screen.getByText(/2 up/i)).toBeInTheDocument();
    expect(screen.getByText(/1 paused/i)).toBeInTheDocument();
  });

  it('shows unhealthy count in summary', () => {
    renderMany([
      makeContainer({ Id: 'a', State: 'running', healthStatus: 'healthy' }),
      makeContainer({ Id: 'b', State: 'running', healthStatus: 'unhealthy' }),
    ]);
    expect(screen.getByText(/1 unhealthy/i)).toBeInTheDocument();
  });

  it('renders density toggle buttons for multiple containers', () => {
    renderMany([makeContainer({ Id: 'a' }), makeContainer({ Id: 'b' })]);
    expect(screen.getByRole('button', { name: 'Compact view' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Detailed view' })).toBeInTheDocument();
  });

  it('detailed mode is the default', () => {
    renderMany([makeContainer({ Id: 'a' }), makeContainer({ Id: 'b' })]);
    const detailed = screen.getByRole('button', { name: 'Detailed view' });
    expect(detailed).toHaveAttribute('aria-pressed', 'true');
  });

  it('hides sparkline grids in compact mode', () => {
    renderMany([makeContainer({ Id: 'a' }), makeContainer({ Id: 'b' })]);
    // Sparklines visible by default in detailed mode (two containers, two cpu labels)
    expect(screen.getAllByText('cpu')).toHaveLength(2);

    fireEvent.click(screen.getByRole('button', { name: 'Compact view' }));
    // Sparkline labels hidden in compact mode
    expect(screen.queryByText('cpu')).toBeNull();
  });

  it('shows sparkline grids again when switching back to detailed', () => {
    renderMany([makeContainer({ Id: 'a' }), makeContainer({ Id: 'b' })]);
    fireEvent.click(screen.getByRole('button', { name: 'Compact view' }));
    expect(screen.queryByText('cpu')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Detailed view' }));
    expect(screen.getAllByText('cpu')).toHaveLength(2);
  });

  it('keeps header row actions visible in compact mode', () => {
    renderMany([
      makeContainer({ Id: 'a', State: 'running', Service: 'web' }),
      makeContainer({ Id: 'b', State: 'running' }),
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'Compact view' }));
    // View logs button still present
    expect(screen.getAllByRole('button', { name: 'View logs' })).toHaveLength(2);
  });
});
