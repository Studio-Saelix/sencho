import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ComposeLabelsPanel from '../ComposeLabelsPanel';
import { LABEL_DISAMBIGUATION_COPY } from '@/lib/labelInventory';

vi.mock('@/lib/api', () => ({
  apiFetch: vi.fn(),
}));

vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({ isAdmin: true }),
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
