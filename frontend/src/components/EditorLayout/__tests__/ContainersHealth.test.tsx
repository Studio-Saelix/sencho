import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('@/lib/clipboard', () => ({ copyToClipboard: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../Terminal', () => ({ default: () => null }));
vi.mock('../../StructuredLogViewer', () => ({ default: () => null }));
vi.mock('../../ImageSourceMenu', () => ({ ImageSourceMenu: () => <button type="button" aria-label="Image source links" /> }));

import { ContainersHealth, type ContainersHealthProps } from '../editor-view-blocks';
import { copyToClipboard } from '@/lib/clipboard';
import type { ContainerInfo } from '../EditorView';
import type { Node } from '@/context/NodeContext';
import type { EffectiveServiceSpec } from '@/types/effectiveServices';
import type { StackServiceUpdateStatus } from '@/types/imageUpdates';

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

  function renderMany(
    containers: ContainerInfo[],
    containerStats: ContainersHealthProps['containerStats'] = {},
  ) {
    return render(
      <ContainersHealth
        safeContainers={containers}
        containerStats={containerStats}
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

  it('compact mode is the default', () => {
    renderMany([makeContainer({ Id: 'a' }), makeContainer({ Id: 'b' })]);
    const compact = screen.getByRole('button', { name: 'Compact view' });
    expect(compact).toHaveAttribute('aria-pressed', 'true');
  });

  it('hides sparkline grids in compact mode', () => {
    renderMany([makeContainer({ Id: 'a' }), makeContainer({ Id: 'b' })]);
    // Sparklines hidden by default (compact is the default)
    expect(screen.queryByText('cpu')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Detailed view' }));
    // Sparklines visible after switching to detailed
    expect(screen.getAllByText('cpu')).toHaveLength(2);

    fireEvent.click(screen.getByRole('button', { name: 'Compact view' }));
    // Sparkline labels hidden again in compact mode
    expect(screen.queryByText('cpu')).toBeNull();
  });

  it('shows sparkline grids again when switching back to detailed', () => {
    renderMany([makeContainer({ Id: 'a' }), makeContainer({ Id: 'b' })]);
    fireEvent.click(screen.getByRole('button', { name: 'Compact view' }));
    expect(screen.queryByText('cpu')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Detailed view' }));
    expect(screen.getAllByText('cpu')).toHaveLength(2);
  });

  it('gives NET I/O more column share and keeps the value on one line', () => {
    renderMany([makeContainer({ Id: 'abc123def456' })], {
      abc123def456: {
        cpu: '0.12%',
        ram: '12.3 MB',
        net: '132 B/s ↓ / 168 B/s ↑',
        history: { cpu: [], mem: [], netIn: [], netOut: [] },
      },
    });

    const netValue = screen.getByText('132 B/s ↓ / 168 B/s ↑');
    expect(netValue).toHaveClass('truncate');
    expect(netValue).toHaveAttribute('title', '132 B/s ↓ / 168 B/s ↑');
    const metricsGrid = netValue.closest('.grid');
    expect(metricsGrid?.className).toContain('0.85fr');
    expect(metricsGrid?.className).toContain('1.3fr');
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

  it('renders empty state for zero containers without summary strip', () => {
    renderMany([]);
    expect(screen.getByText(/no containers running/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Compact view' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Detailed view' })).toBeNull();
  });

  it('resets density to detailed on remount (key change)', () => {
    const { unmount } = render(
      <ContainersHealth
        safeContainers={[makeContainer({ Id: 'a' }), makeContainer({ Id: 'b' })]}
        containerStats={{}}
        containerStatsError={null}
        isAdmin
        activeNode={LOCAL_NODE}
        openLogViewer={vi.fn()}
        openBashModal={vi.fn()}
        serviceAction={vi.fn()}
      />,
    );
    // Switch to detailed
    fireEvent.click(screen.getByRole('button', { name: 'Detailed view' }));
    expect(screen.getAllByText('cpu')).toHaveLength(2);

    // Simulate navigating to a single-container stack (new key)
    unmount();
    render(
      <ContainersHealth
        safeContainers={[makeContainer({ Id: 'x' })]}
        containerStats={{}}
        containerStatsError={null}
        isAdmin
        activeNode={LOCAL_NODE}
        openLogViewer={vi.fn()}
        openBashModal={vi.fn()}
        serviceAction={vi.fn()}
      />,
    );
    // Density reset; single container shows sparklines
    expect(screen.getByText('cpu')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Compact view' })).toBeNull();
  });
});

describe('declared-service headers (multi-service only)', () => {
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

  function spec(overrides: Partial<EffectiveServiceSpec> = {}): EffectiveServiceSpec {
    return {
      name: 'web',
      declaredImage: 'nginx:latest',
      hasBuild: false,
      expectedReplicas: 1,
      dependsOn: [],
      hasHealthcheck: false,
      ...overrides,
    };
  }

  function status(overrides: Partial<StackServiceUpdateStatus> = {}): StackServiceUpdateStatus {
    return {
      service: 'web',
      image: 'nginx:latest',
      hasUpdate: false,
      checkStatus: 'ok',
      lastError: null,
      ...overrides,
    };
  }

  it('renders no declared-service header for a single effective service (unchanged single-service UX)', () => {
    render(
      <ContainersHealth
        safeContainers={[makeContainer({ Service: 'web' })]}
        containerStats={{}}
        containerStatsError={null}
        isAdmin
        activeNode={LOCAL_NODE}
        openLogViewer={vi.fn()}
        openBashModal={vi.fn()}
        serviceAction={vi.fn()}
        effectiveServices={[spec()]}
      />,
    );
    // No grouped "X/Y running" service header; the flat per-container card
    // layout (with its own pre-existing "Service actions" menu) is unchanged.
    expect(screen.queryByText(/running$/)).toBeNull();
    expect(screen.getByLabelText('Service actions')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'View logs' })).toBeInTheDocument();
  });

  it('flattens single-container multi-service rows without a declared-service header', () => {
    render(
      <ContainersHealth
        safeContainers={[
          makeContainer({ Id: 'w1', Names: ['/web'], Service: 'web', State: 'running' }),
          makeContainer({ Id: 'd1', Names: ['/db'], Service: 'db', State: 'running' }),
        ]}
        containerStats={{}}
        containerStatsError={null}
        isAdmin
        activeNode={LOCAL_NODE}
        openLogViewer={vi.fn()}
        openBashModal={vi.fn()}
        serviceAction={vi.fn()}
        effectiveServices={[spec({ name: 'web' }), spec({ name: 'db', declaredImage: 'postgres:16' })]}
      />,
    );
    expect(screen.queryByText(/running$/)).toBeNull();
    expect(screen.getByText('web')).toBeInTheDocument();
    expect(screen.getByText('db')).toBeInTheDocument();
    // Flattened rows restore the per-container Service actions kebab.
    expect(screen.getAllByLabelText('Service actions')).toHaveLength(2);
    expect(screen.getAllByLabelText('Open bash shell')).toHaveLength(2);
  });

  it('shows the Update badge and button on the flattened container card', () => {
    render(
      <ContainersHealth
        safeContainers={[
          makeContainer({ Id: 'w1', Names: ['/web'], Service: 'web' }),
          makeContainer({ Id: 'd1', Names: ['/db'], Service: 'db' }),
        ]}
        containerStats={{}}
        containerStatsError={null}
        isAdmin
        activeNode={LOCAL_NODE}
        openLogViewer={vi.fn()}
        openBashModal={vi.fn()}
        serviceAction={vi.fn()}
        // db is not update-eligible (no image, no build) so it renders no
        // Update button/badge at all, keeping the "web" button unambiguous.
        effectiveServices={[spec({ name: 'web' }), spec({ name: 'db', declaredImage: null })]}
        serviceUpdateStatuses={[status({ service: 'web', hasUpdate: true })]}
      />,
    );
    expect(screen.getByText('Update', { selector: 'span' })).toBeInTheDocument();
    const updateBtn = screen.getByRole('button', { name: /^Update$/ });
    expect(updateBtn).toBeInTheDocument();
    const imageSource = screen.getAllByLabelText('Image source links')[0];
    // Update sits left of ImageSourceMenu in the action row.
    expect(
      updateBtn.compareDocumentPosition(imageSource) & globalThis.Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('uses Rebuild wording with no badge for a build-backed service without a detected update', () => {
    const onRequestServiceUpdate = vi.fn();
    render(
      <ContainersHealth
        safeContainers={[
          makeContainer({ Id: 'w1', Names: ['/web'], Service: 'web' }),
          makeContainer({ Id: 'd1', Names: ['/db'], Service: 'db' }),
        ]}
        containerStats={{}}
        containerStatsError={null}
        isAdmin
        activeNode={LOCAL_NODE}
        openLogViewer={vi.fn()}
        openBashModal={vi.fn()}
        serviceAction={vi.fn()}
        effectiveServices={[spec({ name: 'web', hasBuild: true, declaredImage: null }), spec({ name: 'db' })]}
        onRequestServiceUpdate={onRequestServiceUpdate}
      />,
    );
    expect(screen.queryByText('Update', { selector: 'span' })).toBeNull();
    const rebuildBtn = screen.getByRole('button', { name: /^Rebuild$/ });
    expect(rebuildBtn).toBeInTheDocument();
    fireEvent.click(rebuildBtn);
    expect(onRequestServiceUpdate).toHaveBeenCalledWith('web', 'rebuild');
  });

  it('keeps Start/Stop/Restart on the multi-replica service header menu', async () => {
    const user = userEvent.setup();
    const serviceAction = vi.fn();
    render(
      <ContainersHealth
        safeContainers={[
          makeContainer({ Id: 'w1', Names: ['/web-1'], Service: 'web', State: 'running' }),
          makeContainer({ Id: 'w2', Names: ['/web-2'], Service: 'web', State: 'running' }),
          makeContainer({ Id: 'd1', Names: ['/db'], Service: 'db', State: 'running' }),
        ]}
        containerStats={{}}
        containerStatsError={null}
        isAdmin
        activeNode={LOCAL_NODE}
        openLogViewer={vi.fn()}
        openBashModal={vi.fn()}
        serviceAction={serviceAction}
        effectiveServices={[
          spec({ name: 'web', expectedReplicas: 2 }),
          spec({ name: 'db' }),
        ]}
      />,
    );
    // web keeps a header (2 containers); db is flattened (1 container).
    expect(screen.getByText(/2\/2 running/i)).toBeInTheDocument();
    // Only the web header kebab + the flattened db card kebab.
    expect(screen.getAllByLabelText('Service actions')).toHaveLength(2);
    await user.click(screen.getAllByLabelText('Service actions')[0]);
    await user.click(await screen.findByRole('menuitem', { name: 'Restart service' }));
    expect(serviceAction).toHaveBeenCalledWith('restart', 'web');
  });

  it('retains multi-replica header Update without leaking onto nested children', () => {
    render(
      <ContainersHealth
        safeContainers={[
          makeContainer({ Id: 'w1', Names: ['/web-1'], Service: 'web', State: 'running' }),
          makeContainer({ Id: 'w2', Names: ['/web-2'], Service: 'web', State: 'running' }),
          makeContainer({ Id: 'd1', Names: ['/db'], Service: 'db', State: 'running' }),
        ]}
        containerStats={{}}
        containerStatsError={null}
        isAdmin
        activeNode={LOCAL_NODE}
        openLogViewer={vi.fn()}
        openBashModal={vi.fn()}
        serviceAction={vi.fn()}
        effectiveServices={[
          spec({ name: 'web', expectedReplicas: 2 }),
          spec({ name: 'db', declaredImage: null }),
        ]}
        serviceUpdateStatuses={[status({ service: 'web', hasUpdate: true })]}
      />,
    );
    expect(screen.getByText(/2\/2 running/i)).toBeInTheDocument();
    // One Update badge + one Update button on the web header only (db ineligible).
    expect(screen.getAllByText('Update', { selector: 'span' })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: /^Update$/ })).toHaveLength(1);
    // Nested web children hide the Service actions kebab (header owns it).
    // web header kebab + db flattened kebab = 2.
    expect(screen.getAllByLabelText('Service actions')).toHaveLength(2);
    expect(screen.getAllByLabelText('Open bash shell')).toHaveLength(3);
  });

  it('renders a compact Update row for a declared service with zero containers', () => {
    render(
      <ContainersHealth
        safeContainers={[
          makeContainer({ Id: 'd1', Names: ['/db'], Service: 'db', State: 'running' }),
        ]}
        containerStats={{}}
        containerStatsError={null}
        isAdmin
        activeNode={LOCAL_NODE}
        openLogViewer={vi.fn()}
        openBashModal={vi.fn()}
        serviceAction={vi.fn()}
        // db is flattened but not update-eligible so only the empty web row
        // owns the Update button under test.
        effectiveServices={[spec({ name: 'web' }), spec({ name: 'db', declaredImage: null })]}
        serviceUpdateStatuses={[status({ service: 'web', hasUpdate: true })]}
      />,
    );
    expect(screen.queryByText(/No containers running for this service/i)).toBeNull();
    expect(screen.queryByText(/running$/)).toBeNull();
    expect(screen.getByText('web')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Update$/ })).toBeInTheDocument();
    // Compact empty row + flattened db card each have a Service actions kebab.
    expect(screen.getAllByLabelText('Service actions')).toHaveLength(2);
  });

  it('still surfaces summary strip and density toggle on multi-service stacks', () => {
    render(
      <ContainersHealth
        safeContainers={[
          makeContainer({ Id: 'w1', Service: 'web', State: 'running' }),
          makeContainer({ Id: 'd1', Service: 'db', State: 'running' }),
          makeContainer({ Id: 'd2', Service: 'db', State: 'paused' }),
        ]}
        containerStats={{}}
        containerStatsError={null}
        isAdmin
        activeNode={LOCAL_NODE}
        openLogViewer={vi.fn()}
        openBashModal={vi.fn()}
        serviceAction={vi.fn()}
        effectiveServices={[spec({ name: 'web' }), spec({ name: 'db' })]}
      />,
    );
    expect(screen.getByText(/3 containers/i)).toBeInTheDocument();
    expect(screen.getByText(/2 up/i)).toBeInTheDocument();
    expect(screen.getByText(/1 paused/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Compact view' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Detailed view' })).toBeInTheDocument();
  });

  it('toggles detailed sparklines on the multi-service path', () => {
    render(
      <ContainersHealth
        safeContainers={[
          makeContainer({ Id: 'w1', Service: 'web', State: 'running' }),
          makeContainer({ Id: 'd1', Service: 'db', State: 'running' }),
        ]}
        containerStats={{}}
        containerStatsError={null}
        isAdmin
        activeNode={LOCAL_NODE}
        openLogViewer={vi.fn()}
        openBashModal={vi.fn()}
        serviceAction={vi.fn()}
        effectiveServices={[spec({ name: 'web' }), spec({ name: 'db' })]}
      />,
    );
    expect(screen.queryByText('cpu')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Detailed view' }));
    expect(screen.getAllByText('cpu')).toHaveLength(2);
  });

  it('surfaces expand control on multi-service stacks when wired', () => {
    const onToggle = vi.fn();
    render(
      <ContainersHealth
        safeContainers={[
          makeContainer({ Id: 'w1', Service: 'web', State: 'running' }),
          makeContainer({ Id: 'd1', Service: 'db', State: 'running' }),
        ]}
        containerStats={{}}
        containerStatsError={null}
        isAdmin
        activeNode={LOCAL_NODE}
        openLogViewer={vi.fn()}
        openBashModal={vi.fn()}
        serviceAction={vi.fn()}
        effectiveServices={[spec({ name: 'web' }), spec({ name: 'db' })]}
        containersExpanded={false}
        onToggleContainersExpand={onToggle}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Expand containers' }));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });
});

describe('containers load states', () => {
  it('does not show empty copy while loading', () => {
    render(
      <ContainersHealth
        safeContainers={[]}
        containerStats={{}}
        containerStatsError={null}
        isAdmin
        activeNode={LOCAL_NODE}
        openLogViewer={vi.fn()}
        openBashModal={vi.fn()}
        serviceAction={vi.fn()}
        containersLoadStatus="loading"
      />,
    );
    expect(screen.queryByText(/No containers running for this stack/i)).toBeNull();
    expect(screen.queryByText(/No containers running for this service/i)).toBeNull();
  });

  it('shows confirmed empty only after success', () => {
    render(
      <ContainersHealth
        safeContainers={[]}
        containerStats={{}}
        containerStatsError={null}
        isAdmin
        activeNode={LOCAL_NODE}
        openLogViewer={vi.fn()}
        openBashModal={vi.fn()}
        serviceAction={vi.fn()}
        containersLoadStatus="success"
      />,
    );
    expect(screen.getByText(/No containers running for this stack/i)).toBeInTheDocument();
  });

  it('shows error and invokes retry once', async () => {
    const onRetry = vi.fn();
    const user = userEvent.setup();
    render(
      <ContainersHealth
        safeContainers={[]}
        containerStats={{}}
        containerStatsError={null}
        isAdmin
        activeNode={LOCAL_NODE}
        openLogViewer={vi.fn()}
        openBashModal={vi.fn()}
        serviceAction={vi.fn()}
        containersLoadStatus="error"
        containersLoadError="Could not load containers."
        onRetryContainersLoad={onRetry}
      />,
    );
    expect(screen.queryByText(/No containers running for this stack/i)).toBeNull();
    await user.click(screen.getByRole('button', { name: /retry/i }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('shows Monitor when Service is set and calls onOpenServiceMonitor', async () => {
    const onOpenServiceMonitor = vi.fn();
    const user = userEvent.setup();
    const c = { ...container([{ PrivatePort: 80, PublicPort: 8080 }]), Service: 'web' } as ContainerInfo;
    render(
      <ContainersHealth
        safeContainers={[c]}
        containerStats={{}}
        containerStatsError={null}
        isAdmin
        activeNode={LOCAL_NODE}
        openLogViewer={vi.fn()}
        openBashModal={vi.fn()}
        serviceAction={vi.fn()}
        onOpenServiceMonitor={onOpenServiceMonitor}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Monitor web' }));
    expect(onOpenServiceMonitor).toHaveBeenCalledWith('web');
  });

  it('hides Monitor when the container has no Service label', () => {
    render(
      <ContainersHealth
        safeContainers={[container([{ PrivatePort: 80, PublicPort: 8080 }])]}
        containerStats={{}}
        containerStatsError={null}
        isAdmin
        activeNode={LOCAL_NODE}
        openLogViewer={vi.fn()}
        openBashModal={vi.fn()}
        serviceAction={vi.fn()}
        onOpenServiceMonitor={vi.fn()}
      />,
    );
    expect(screen.queryByRole('button', { name: /Monitor / })).toBeNull();
  });
});

describe('ContainersHealth Docker health status labels', () => {
  const OLD_PHRASES = ['healthcheck passing', 'healthcheck failing', 'healthcheck starting'] as const;
  const HEALTH_TOKENS = ['healthy', 'unhealthy', 'starting'] as const;

  function metaLine(): HTMLElement {
    const parent = screen.getByText('up 2 hours').parentElement;
    if (!parent) throw new Error('expected meta line parent');
    return parent;
  }

  function metaSpanTexts(meta: HTMLElement = metaLine()): Array<string | null> {
    return Array.from(meta.querySelectorAll('span')).map((el) => el.textContent);
  }

  function renderWithHealth(healthStatus?: ContainerInfo['healthStatus']) {
    const base = container([{ PrivatePort: 80, PublicPort: 8080 }]);
    return renderHealth(
      healthStatus === undefined ? base : ({ ...base, healthStatus } as ContainerInfo),
    );
  }

  function expectNoLegacyPhrases(meta: HTMLElement) {
    for (const phrase of OLD_PHRASES) {
      expect(meta.textContent).not.toContain(phrase);
    }
  }

  it.each(HEALTH_TOKENS)('renders exact meta-line token for healthStatus %s', (token) => {
    renderWithHealth(token);
    const meta = metaLine();
    const labels = metaSpanTexts(meta);
    expect(labels[0]).toBe('up 2 hours');
    expect(labels).toContain(token);
    expect(labels.filter((t) => t === token)).toHaveLength(1);
    expectNoLegacyPhrases(meta);
    expect(screen.getByRole('link', { name: /8080/ })).toBeInTheDocument();
  });

  it.each([
    ['none', 'none'],
    ['omitted', undefined],
  ] as const)('omits a health token when healthStatus is %s', (_case, healthStatus) => {
    renderWithHealth(healthStatus);
    const meta = metaLine();
    const labels = metaSpanTexts(meta);
    expect(labels).toContain('up 2 hours');
    for (const token of HEALTH_TOKENS) {
      expect(labels).not.toContain(token);
    }
    expect(labels.filter((t) => t === '·')).toHaveLength(1);
    expectNoLegacyPhrases(meta);
    expect(screen.getByRole('link', { name: /8080/ })).toBeInTheDocument();
  });
});

describe('live-refresh stale chip', () => {
  it('shows stale chip with Retry when syncStale and cards are visible', () => {
    const onRetrySync = vi.fn();
    render(
      <ContainersHealth
        safeContainers={[{
          Id: 'a',
          Names: ['/web'],
          State: 'running',
          Status: 'Up 1 hour',
          healthStatus: 'healthy',
        }]}
        containerStats={{}}
        containerStatsError={null}
        isAdmin
        activeNode={LOCAL_NODE}
        openLogViewer={vi.fn()}
        openBashModal={vi.fn()}
        serviceAction={vi.fn()}
        containersLoadStatus="success"
        syncStale
        onRetrySync={onRetrySync}
      />,
    );
    expect(screen.getByText(/Container state may be stale/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Retry/i }));
    expect(onRetrySync).toHaveBeenCalledTimes(1);
  });

  it('suppresses stale chip when containersLoadStatus is error', () => {
    render(
      <ContainersHealth
        safeContainers={[]}
        containerStats={{}}
        containerStatsError={null}
        isAdmin
        activeNode={LOCAL_NODE}
        openLogViewer={vi.fn()}
        openBashModal={vi.fn()}
        serviceAction={vi.fn()}
        containersLoadStatus="error"
        containersLoadError="Could not load containers."
        onRetryContainersLoad={vi.fn()}
        syncStale
        onRetrySync={vi.fn()}
      />,
    );
    expect(screen.queryByText(/Container state may be stale/i)).toBeNull();
    expect(screen.getByText(/Could not load containers/i)).toBeInTheDocument();
  });
});
