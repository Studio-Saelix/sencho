import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ComposeLabelsPanel from '../ComposeLabelsPanel';
import { LABEL_DISAMBIGUATION_COPY } from '@/lib/labelInventory';

vi.mock('@/lib/api', () => ({
  apiFetch: vi.fn(),
}));

vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({ isAdmin: true }),
}));

let senchoLabelsSupported = true;
// `null` models a node info fetch that failed or has not resolved: no version, no capabilities.
let nodeMeta: { version: string | null } | null = { version: '0.99.0' };
vi.mock('@/context/NodeContext', () => ({
  useNodes: () => ({
    activeNodeMeta: nodeMeta,
    hasCapability: (cap: string) => cap !== 'sencho-labels-v1' || senchoLabelsSupported,
  }),
}));

import { apiFetch } from '@/lib/api';

const mockInventory = {
  stackName: 'demo',
  renderable: true,
  generatedAt: Date.now(),
  services: [
    {
      service: 'web',
      declaredLabels: [{ key: 'traefik.enable', value: 'true', source: 'compose' as const }],
      replicas: [
        {
          id: 'c1',
          name: 'demo-web-1',
          state: 'running',
          runtimeLabels: [
            { key: 'traefik.enable', value: 'true', source: 'runtime' as const },
            { key: 'runtime.only', value: '1', source: 'runtime' as const },
          ],
          onlyInCompose: [],
          onlyOnContainer: ['runtime.only'],
          inBoth: ['traefik.enable'],
        },
      ],
    },
  ],
};

describe('ComposeLabelsPanel', () => {
  beforeEach(() => {
    senchoLabelsSupported = true;
    vi.mocked(apiFetch).mockResolvedValue({
      ok: true,
      json: async () => mockInventory,
    } as Response);
  });

  it('shows disambiguation copy and service labels', async () => {
    render(<ComposeLabelsPanel stackName="demo" />);
    expect(await screen.findByText(LABEL_DISAMBIGUATION_COPY)).toBeInTheDocument();
    expect(await screen.findByText('web')).toBeInTheDocument();
    expect(screen.getAllByText('traefik.enable')).toHaveLength(2);
    expect(screen.getByTestId('mismatch-only-container')).toBeInTheDocument();
    expect(screen.getByTestId('mismatch-both')).toBeInTheDocument();
  });

  it('renders a value-changed badge when a label value drifted', async () => {
    vi.mocked(apiFetch).mockResolvedValue({
      ok: true,
      json: async () => ({
        stackName: 'demo', renderable: true, partial: false, generatedAt: Date.now(),
        services: [{
          service: 'web',
          declaredLabels: [{ key: 'watchtower.enable', value: 'true', source: 'compose' as const }],
          replicas: [{
            id: 'c1', name: 'demo-web-1', state: 'running',
            runtimeLabels: [{ key: 'watchtower.enable', value: 'false', source: 'runtime' as const }],
            onlyInCompose: [], onlyOnContainer: [], inBoth: [], changed: ['watchtower.enable'],
          }],
        }],
      }),
    } as Response);
    render(<ComposeLabelsPanel stackName="demo" />);
    expect(await screen.findByTestId('mismatch-changed')).toBeInTheDocument();
  });

  it('shows a load error, not an empty inventory, when the body cannot be read', async () => {
    vi.mocked(apiFetch).mockResolvedValue({
      ok: true,
      json: async () => ({ stackName: 'demo', services: 'not-an-array' }),
    } as unknown as Response);
    render(<ComposeLabelsPanel stackName="demo" />);
    expect(await screen.findByText('Could not load Compose labels for this stack.')).toBeInTheDocument();
    expect(screen.queryByText('No Compose or runtime labels found for this stack.')).toBeNull();
    cleanup();
    // A body that has the right lists but none of the required fields is unreadable too.
    vi.mocked(apiFetch).mockResolvedValue({
      ok: true,
      json: async () => ({ services: [] }),
    } as unknown as Response);
    render(<ComposeLabelsPanel stackName="demo" />);
    expect(await screen.findByText('Could not load Compose labels for this stack.')).toBeInTheDocument();
    expect(screen.queryByText('No Compose or runtime labels found for this stack.')).toBeNull();
  });

  it('shows "Runtime labels unavailable" for a replica whose inspect failed', async () => {
    vi.mocked(apiFetch).mockResolvedValue({
      ok: true,
      json: async () => ({
        stackName: 'demo', renderable: true, partial: true, generatedAt: Date.now(),
        services: [{
          service: 'web',
          declaredLabels: [{ key: 'traefik.enable', value: 'true', source: 'compose' as const }],
          replicas: [{
            id: 'c1', name: 'demo-web-1', state: 'running',
            runtimeLabels: [], onlyInCompose: [], onlyOnContainer: [], inBoth: [], changed: [],
            inspectFailed: true,
          }],
        }],
      }),
    } as Response);
    render(<ComposeLabelsPanel stackName="demo" />);
    expect(await screen.findByText('Runtime labels unavailable for this container.')).toBeInTheDocument();
    expect(screen.getByText(/could not be inspected/i)).toBeInTheDocument();
  });

  // A service whose declared/runtime labels have distinctive keys so name-search can be isolated.
  const searchMock = {
    stackName: 'demo', renderable: true, partial: false, generatedAt: Date.now(),
    services: [{
      service: 'web',
      declaredLabels: [{ key: 'aaa.declared', value: '1', source: 'compose' as const }],
      replicas: [{
        id: 'w1', name: 'demo-web-1', state: 'running',
        runtimeLabels: [{ key: 'zzz.runtime', value: 'q', source: 'runtime' as const }],
        onlyInCompose: ['aaa.declared'], onlyOnContainer: ['zzz.runtime'], inBoth: [], changed: [],
      }],
    }],
  };

  it('service-name search exposes that service\'s declared and runtime labels', async () => {
    const user = userEvent.setup();
    vi.mocked(apiFetch).mockResolvedValue({ ok: true, json: async () => searchMock } as Response);
    render(<ComposeLabelsPanel stackName="demo" />);
    await user.type(await screen.findByTestId('compose-label-search'), 'web');
    expect(screen.getByText('aaa.declared')).toBeInTheDocument();
    expect(screen.getByText('zzz.runtime')).toBeInTheDocument();
  });

  it('replica-name search exposes runtime labels only, not service-level declared labels', async () => {
    const user = userEvent.setup();
    vi.mocked(apiFetch).mockResolvedValue({ ok: true, json: async () => searchMock } as Response);
    render(<ComposeLabelsPanel stackName="demo" />);
    await user.type(await screen.findByTestId('compose-label-search'), 'demo-web-1');
    expect(screen.getByText('zzz.runtime')).toBeInTheDocument();
    expect(screen.queryByText('aaa.declared')).toBeNull();
  });

  it('hides inBoth and changed badges when Compose File is filtered out', async () => {
    const user = userEvent.setup();
    vi.mocked(apiFetch).mockResolvedValue({
      ok: true,
      json: async () => ({
        stackName: 'demo', renderable: true, partial: false, generatedAt: Date.now(),
        services: [{
          service: 'web',
          declaredLabels: [{ key: 'watchtower.enable', value: 'true', source: 'compose' as const }],
          replicas: [{
            id: 'c1', name: 'demo-web-1', state: 'running',
            runtimeLabels: [{ key: 'watchtower.enable', value: 'false', source: 'runtime' as const }],
            onlyInCompose: [], onlyOnContainer: [], inBoth: [], changed: ['watchtower.enable'],
          }],
        }],
      }),
    } as Response);
    render(<ComposeLabelsPanel stackName="demo" />);
    expect(await screen.findByTestId('mismatch-changed')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Filters/ }));
    await user.click(screen.getByRole('button', { name: 'Compose File' }));
    expect(screen.queryByTestId('mismatch-changed')).toBeNull();
  });

  it('a source facet hides that source; turning off Compose File hides declared labels', async () => {
    const user = userEvent.setup();
    vi.mocked(apiFetch).mockResolvedValue({ ok: true, json: async () => searchMock } as Response);
    render(<ComposeLabelsPanel stackName="demo" />);
    expect(await screen.findByText('aaa.declared')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Filters/ }));
    await user.click(screen.getByRole('button', { name: 'Compose File' }));
    expect(screen.queryByText('aaa.declared')).toBeNull();
    expect(screen.getByText('zzz.runtime')).toBeInTheDocument();
  });

  it('recomputes badge counts from the visible set', async () => {
    const user = userEvent.setup();
    vi.mocked(apiFetch).mockResolvedValue({ ok: true, json: async () => searchMock } as Response);
    render(<ComposeLabelsPanel stackName="demo" />);
    // Search only the runtime key: onlyOnContainer stays 1, onlyInCompose drops to 0.
    await user.type(await screen.findByTestId('compose-label-search'), 'zzz.runtime');
    expect(screen.getByTestId('mismatch-only-container')).toBeInTheDocument();
    expect(screen.queryByTestId('mismatch-only-compose')).toBeNull();
  });

  it('shows the genuine "No runtime labels" for an empty replica when no filters are active', async () => {
    vi.mocked(apiFetch).mockResolvedValue({
      ok: true, json: async () => ({
        stackName: 'demo', renderable: true, partial: false, generatedAt: Date.now(),
        services: [{
          service: 'web', declaredLabels: [{ key: 'a', value: '1', source: 'compose' as const }],
          replicas: [{ id: 'w1', name: 'demo-web-1', state: 'running', runtimeLabels: [], onlyInCompose: ['a'], onlyOnContainer: [], inBoth: [], changed: [] }],
        }],
      }),
    } as Response);
    render(<ComposeLabelsPanel stackName="demo" />);
    expect(await screen.findByText('No runtime labels on this container.')).toBeInTheDocument();
  });

  it('keeps the inspectFailed warning under an active filter but hides it when the service is unchecked', async () => {
    const user = userEvent.setup();
    vi.mocked(apiFetch).mockResolvedValue({
      ok: true, json: async () => ({
        stackName: 'demo', renderable: true, partial: true, generatedAt: Date.now(),
        services: [
          { service: 'web', declaredLabels: [], replicas: [{ id: 'w1', name: 'demo-web-1', state: 'running', runtimeLabels: [], onlyInCompose: [], onlyOnContainer: [], inBoth: [], changed: [], inspectFailed: true }] },
          { service: 'db', declaredLabels: [{ key: 'x', value: '1', source: 'compose' as const }], replicas: [] },
        ],
      }),
    } as Response);
    render(<ComposeLabelsPanel stackName="demo" />);
    // Active text filter that matches nothing: the inspectFailed warning must still show.
    await user.type(await screen.findByTestId('compose-label-search'), 'nomatchxyz');
    expect(screen.getByText('Runtime labels unavailable for this container.')).toBeInTheDocument();
    // Hiding the web service (via the Filters popover) removes its card and the warning.
    await user.click(screen.getByRole('button', { name: /Filters/ }));
    await user.click(screen.getByRole('button', { name: 'web' }));
    expect(screen.queryByText('Runtime labels unavailable for this container.')).toBeNull();
  });

  it('distinguishes genuine-empty inventory from filtered-empty (no duplicate messages)', async () => {
    const user = userEvent.setup();
    // Genuine empty inventory.
    vi.mocked(apiFetch).mockResolvedValue({
      ok: true, json: async () => ({ stackName: 'demo', renderable: true, partial: false, generatedAt: Date.now(), services: [] }),
    } as Response);
    const { unmount } = render(<ComposeLabelsPanel stackName="demo" />);
    expect(await screen.findByText('No Compose or runtime labels found for this stack.')).toBeInTheDocument();
    unmount();

    // Filtered-empty: one per-card message, no panel-level duplicate.
    vi.mocked(apiFetch).mockResolvedValue({ ok: true, json: async () => searchMock } as Response);
    render(<ComposeLabelsPanel stackName="demo" />);
    await user.type(await screen.findByTestId('compose-label-search'), 'nomatchxyz');
    expect(screen.getByTestId('compose-label-service-no-match')).toBeInTheDocument();
    expect(screen.queryByText('No Compose or runtime labels found for this stack.')).toBeNull();
  });

  it('shows "No services selected" when every service checkbox is unchecked', async () => {
    const user = userEvent.setup();
    vi.mocked(apiFetch).mockResolvedValue({
      ok: true, json: async () => ({
        stackName: 'demo', renderable: true, partial: false, generatedAt: Date.now(),
        services: [
          { service: 'web', declaredLabels: [{ key: 'a', value: '1', source: 'compose' as const }], replicas: [] },
          { service: 'db', declaredLabels: [{ key: 'b', value: '2', source: 'compose' as const }], replicas: [] },
        ],
      }),
    } as Response);
    render(<ComposeLabelsPanel stackName="demo" />);
    await user.click(await screen.findByRole('button', { name: /Filters/ }));
    await user.click(screen.getByRole('button', { name: 'web' }));
    await user.click(screen.getByRole('button', { name: 'db' }));
    expect(screen.getByTestId('compose-labels-no-services')).toBeInTheDocument();
  });

  it('preserves filters across a reveal on the same stack', async () => {
    const user = userEvent.setup();
    const revealMock = {
      stackName: 'demo', renderable: true, partial: false, generatedAt: Date.now(),
      services: [{
        service: 'web', declaredLabels: [],
        replicas: [{
          id: 'w1', name: 'demo-web-1', state: 'running',
          runtimeLabels: [
            { key: 'api.token', value: '[redacted]', source: 'runtime' as const, redacted: true },
            { key: 'plain.label', value: 'v', source: 'runtime' as const },
          ],
          onlyInCompose: [], onlyOnContainer: ['api.token', 'plain.label'], inBoth: [], changed: [],
        }],
      }],
    };
    vi.mocked(apiFetch).mockResolvedValue({ ok: true, json: async () => revealMock } as Response);
    render(<ComposeLabelsPanel stackName="demo" />);
    await user.type(await screen.findByTestId('compose-label-search'), 'api.token');
    expect(screen.getByText('api.token')).toBeInTheDocument();
    expect(screen.queryByText('plain.label')).toBeNull();

    await user.click(screen.getByRole('button', { name: /reveal/i }));
    // The reset effect is keyed on stackName only, so the reveal-driven refetch keeps the filter.
    expect((screen.getByTestId('compose-label-search') as HTMLInputElement).value).toBe('api.token');
    expect(screen.queryByText('plain.label')).toBeNull();
  });

  it('resets search, source, and service filters when the stack changes', async () => {
    const user = userEvent.setup();
    const twoServiceMock = {
      stackName: 'demo', renderable: true, partial: false, generatedAt: Date.now(),
      services: [
        { service: 'web', declaredLabels: [{ key: 'web.owner', value: '1', source: 'compose' as const }], replicas: [] },
        { service: 'db', declaredLabels: [{ key: 'db.owner', value: '2', source: 'compose' as const }], replicas: [] },
      ],
    };
    vi.mocked(apiFetch).mockResolvedValue({ ok: true, json: async () => twoServiceMock } as Response);
    const { rerender } = render(<ComposeLabelsPanel stackName="demo" />);
    const input = await screen.findByTestId('compose-label-search') as HTMLInputElement;
    await user.type(input, 'zzz');
    // Hide the db service and exclude the Compose File source via the Filters popover.
    await user.click(screen.getByRole('button', { name: /Filters/ }));
    await user.click(screen.getByRole('button', { name: 'db' }));
    await user.click(screen.getByRole('button', { name: 'Compose File' }));
    expect(input.value).toBe('zzz');
    expect(screen.queryByText('web.owner')).toBeNull();
    expect(screen.queryByText('db.owner')).toBeNull();

    rerender(<ComposeLabelsPanel stackName="other" />);
    // Filters reset: search cleared, both services and the source shown again.
    expect((await screen.findByTestId('compose-label-search') as HTMLInputElement).value).toBe('');
    expect(await screen.findByText('web.owner')).toBeInTheDocument();
    expect(screen.getByText('db.owner')).toBeInTheDocument();
  });
});

describe('ComposeLabelsPanel io.sencho.* status', () => {
  const senchoInventory = {
    stackName: 'demo',
    renderable: true,
    generatedAt: Date.now(),
    services: [
      {
        service: 'web',
        declaredLabels: [
          { key: 'io.sencho.url', value: 'https://app.example.com', source: 'compose' as const, behavior: { state: 'active' as const, summary: 'Application link for the service.' } },
          { key: 'io.sencho.order', value: 'soon', source: 'compose' as const, behavior: { state: 'invalid' as const, reason: 'Use a whole number such as 10.' } },
          { key: 'io.sencho.future', value: '1', source: 'compose' as const, behavior: { state: 'unsupported' as const, reason: 'Sencho does not recognize this label.' } },
        ],
        replicas: [
          {
            id: 'c1',
            name: 'demo-web-1',
            state: 'running',
            runtimeLabels: [
              { key: 'io.sencho.hidden', value: 'true', source: 'runtime' as const, behavior: { state: 'inert' as const, reason: 'Present only on the running container, so Sencho does not act on it. Declare it in the Compose file instead.' } },
            ],
            onlyInCompose: ['io.sencho.order', 'io.sencho.future'],
            onlyOnContainer: ['io.sencho.hidden'],
            inBoth: ['io.sencho.url'],
          },
        ],
      },
    ],
  };

  beforeEach(() => {
    senchoLabelsSupported = true;
    nodeMeta = { version: '0.99.0' };
    vi.mocked(apiFetch).mockResolvedValue({ ok: true, json: async () => senchoInventory } as Response);
  });

  it('distinguishes active, ignored, unsupported, and inert Sencho labels', async () => {
    const user = userEvent.setup();
    render(<ComposeLabelsPanel stackName="demo" />);
    await screen.findByText('io.sencho.url');
    const states = screen.getAllByTestId('label-behavior').map(el => [el.getAttribute('data-state'), el.textContent]);
    expect(states).toEqual([
      ['active', 'Active'],
      ['invalid', 'Ignored'],
      ['unsupported', 'Unsupported'],
      ['inert', 'Inert'],
    ]);
    expect(screen.getByText('Use a whole number such as 10.')).toBeInTheDocument();
    expect(screen.getByText('Sencho does not recognize this label.')).toBeInTheDocument();
    // An inert label stays quiet inline and explains itself on click, which also works from the keyboard and a touch screen.
    expect(screen.queryByTestId('label-behavior-reason')).toBeNull();
    await user.click(screen.getByRole('button', { name: /Inert: why/ }));
    expect(await screen.findByTestId('label-behavior-reason')).toHaveTextContent('Declare it in the Compose file');
    expect(screen.queryByTestId('sencho-labels-unsupported')).toBeNull();
  });

  it('never shows an unreadable or unearned status from a node as Active', async () => {
    vi.mocked(apiFetch).mockResolvedValue({
      ok: true,
      json: async () => ({
        ...senchoInventory,
        services: [{
          ...senchoInventory.services[0],
          declaredLabels: [
            { key: 'io.sencho.url', value: 'v', source: 'compose', behavior: { state: 'trusted' } },
            { key: 'io.sencho.order', value: 'v', source: 'compose', behavior: { state: 'invalid', reason: { nested: true } } },
          ],
          replicas: [{
            ...senchoInventory.services[0].replicas[0],
            runtimeLabels: [{ key: 'io.sencho.hidden', value: 'true', source: 'runtime', behavior: { state: 'active' } }],
          }],
        }],
      }),
    } as Response);
    render(<ComposeLabelsPanel stackName="demo" />);
    await screen.findByText('io.sencho.url');
    expect(screen.getAllByTestId('label-behavior').map(el => el.getAttribute('data-state'))).toEqual(['unsupported', 'unsupported', 'inert']);
    expect(screen.getAllByText(/cannot read/).length).toBeGreaterThan(0);
  });

  it('marks an io.sencho.* label from a node that reports no status, and leaves other labels alone', async () => {
    vi.mocked(apiFetch).mockResolvedValue({
      ok: true,
      json: async () => ({
        ...senchoInventory,
        services: [{
          ...senchoInventory.services[0],
          declaredLabels: [
            { key: 'io.sencho.url', value: 'https://app.example.com', source: 'compose' },
            { key: 'traefik.enable', value: 'true', source: 'compose' },
          ],
          replicas: [],
        }],
      }),
    } as Response);
    render(<ComposeLabelsPanel stackName="demo" />);
    await screen.findByText('io.sencho.url');
    expect(screen.getAllByTestId('label-behavior-not-reported')).toHaveLength(1);
    expect(screen.queryByTestId('label-behavior')).toBeNull();
  });

  it('says so when the node does not apply io.sencho.* labels', async () => {
    senchoLabelsSupported = false;
    vi.mocked(apiFetch).mockResolvedValue({
      ok: true,
      json: async () => ({
        ...senchoInventory,
        services: [{
          ...senchoInventory.services[0],
          declaredLabels: [{ key: 'io.sencho.url', value: 'https://app.example.com', source: 'compose' as const }],
          replicas: [],
        }],
      }),
    } as Response);
    render(<ComposeLabelsPanel stackName="demo" />);
    expect(await screen.findByTestId('sencho-labels-unsupported')).toHaveTextContent('does not apply io.sencho.* labels');
    expect(screen.queryByTestId('label-behavior')).toBeNull();
  });

  it('does not tell the operator to update a current node whose info fetch failed', async () => {
    senchoLabelsSupported = false;
    nodeMeta = { version: null };
    vi.mocked(apiFetch).mockResolvedValue({
      ok: true,
      json: async () => ({
        ...senchoInventory,
        services: [{ ...senchoInventory.services[0], declaredLabels: [{ key: 'io.sencho.url', value: 'v', source: 'compose' as const }], replicas: [] }],
      }),
    } as Response);
    render(<ComposeLabelsPanel stackName="demo" />);
    await screen.findByText('io.sencho.url');
    expect(screen.queryByTestId('sencho-labels-unsupported')).toBeNull();
  });

  it('does not warn about an old node when the stack declares no Sencho labels', async () => {
    senchoLabelsSupported = false;
    vi.mocked(apiFetch).mockResolvedValue({ ok: true, json: async () => mockInventory } as Response);
    render(<ComposeLabelsPanel stackName="demo" />);
    await screen.findByText('web');
    expect(screen.queryByTestId('sencho-labels-unsupported')).toBeNull();
  });
});
