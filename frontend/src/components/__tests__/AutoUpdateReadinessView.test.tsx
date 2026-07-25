/**
 * MobileReadinessCard is the one-up phone card for the Updates readiness board.
 * Its Apply button is disabled when the update is blocked (major bump),
 * digest verification failed without a confirmed update, or an apply is
 * already in flight; manual apply works regardless of schedule. The Auto: Off
 * pill still reflects the absence of a covering auto-update schedule.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, act, waitFor, fireEvent } from '@testing-library/react';

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn(), fetchForNode: vi.fn() }));
vi.mock('@/lib/serviceUpdate', () => ({
  requestServiceUpdate: vi.fn(),
}));
vi.mock('@/components/ui/toast-store', () => ({
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn(), loading: vi.fn(), dismiss: vi.fn() },
}));
vi.mock('@/hooks/use-is-mobile', () => ({ useIsMobile: () => false }));
vi.mock('@/context/DeployFeedbackContext', () => ({
  useDeployFeedback: () => ({
    runWithLog: async (_params: unknown, fn: (started: Promise<void>, ds: string) => Promise<unknown>) =>
      fn(Promise.resolve(), 'test-session'),
  }),
}));
// nodeMeta/refreshNodeMeta must be stable across renders (matching the real
// NodeContext), or a fresh Map/fn on every useNodes() call churns the
// loadReadiness useCallback identity and re-triggers its effect forever.
const mockNodeMeta = new Map();
const mockRefreshNodeMeta = vi.fn();
const mockNodes: { id: number; name: string; type: 'local' | 'remote'; status: string }[] = [
  { id: 1, name: 'Local', type: 'local', status: 'online' },
];
vi.mock('@/context/NodeContext', () => ({
  useNodes: () => ({
    nodes: mockNodes,
    nodeMeta: mockNodeMeta,
    refreshNodeMeta: mockRefreshNodeMeta,
  }),
}));

import { apiFetch, fetchForNode } from '@/lib/api';
import { requestServiceUpdate } from '@/lib/serviceUpdate';
import AutoUpdateReadinessView, {
  MobileReadinessCard,
  CadenceStrip,
  isVerificationOnlyPreview,
  isActionableUpdatePreview,
  type StackCard,
} from '../AutoUpdateReadinessView';

function card(over: Partial<StackCard> = {}): StackCard {
  return {
    stack: 'nextcloud',
    nodeId: 1,
    previewLoaded: true,
    applying: false,
    applyingService: null,
    autoUpdateEnabled: true,
    scheduledTask: null,
    preview: {
      stack_name: 'nextcloud',
      images: [],
      summary: {
        has_update: true,
        primary_image: 'nextcloud',
        current_tag: '27.1.4',
        next_tag: '27.1.5',
        semver_bump: 'patch',
        update_kind: 'tag',
        blocked: false,
        blocked_reason: null,
      },
      rollback_target: null,
      changelog: 'Fixes. Security patch.',
    },
    ...over,
  };
}

const apply = () => screen.getByRole('button', { name: /Apply now/i });

function previewSummary(over: Record<string, unknown> = {}) {
  return {
    stack_name: 'redis',
    images: [],
    rollback_target: null,
    changelog: null,
    summary: {
      has_update: false,
      primary_image: 'redis',
      current_tag: '8.8.0',
      next_tag: '8.8.0',
      semver_bump: 'none' as const,
      update_kind: 'none' as const,
      blocked: false,
      blocked_reason: null,
      rebuild_available: false,
      verification_failed: false,
      verification_error: null,
      ...over,
    },
  };
}

describe('verification preview helpers', () => {
  it('treats verification failure without update/rebuild as verification-only', () => {
    const preview = previewSummary({ verification_failed: true });
    expect(isVerificationOnlyPreview(preview)).toBe(true);
    expect(isActionableUpdatePreview(preview)).toBe(false);
  });

  it('keeps a verified update actionable even when verification_failed is set', () => {
    const preview = previewSummary({
      verification_failed: true,
      has_update: true,
      update_kind: 'tag',
      semver_bump: 'patch',
      next_tag: '8.8.1',
    });
    expect(isVerificationOnlyPreview(preview)).toBe(false);
    expect(isActionableUpdatePreview(preview)).toBe(true);
  });

  it('keeps a rebuild actionable even when verification_failed is set', () => {
    const preview = previewSummary({
      verification_failed: true,
      rebuild_available: true,
      update_kind: 'digest',
    });
    expect(isVerificationOnlyPreview(preview)).toBe(false);
    expect(isActionableUpdatePreview(preview)).toBe(true);
  });

  it('rejects blocked updates as actionable', () => {
    const preview = previewSummary({
      has_update: true,
      blocked: true,
      blocked_reason: 'Major version bump',
      semver_bump: 'major',
      update_kind: 'tag',
    });
    expect(isVerificationOnlyPreview(preview)).toBe(false);
    expect(isActionableUpdatePreview(preview)).toBe(false);
  });

  it('returns false for null/undefined previews', () => {
    expect(isVerificationOnlyPreview(null)).toBe(false);
    expect(isVerificationOnlyPreview(undefined)).toBe(false);
    expect(isActionableUpdatePreview(null)).toBe(false);
    expect(isActionableUpdatePreview(undefined)).toBe(false);
  });
});

it('enables Apply for a safe, non-blocked update', () => {
  render(<MobileReadinessCard card={card()} onApply={vi.fn()} />);
  expect(apply()).toBeEnabled();
});

it('disables Apply when the update is blocked (major bump)', () => {
  render(
    <MobileReadinessCard
      card={card({
        preview: {
          stack_name: 'gitea', images: [], rollback_target: null, changelog: 'Breaking.',
          summary: {
            has_update: true, primary_image: 'gitea', current_tag: '1.21', next_tag: '1.22',
            semver_bump: 'major', update_kind: 'tag', blocked: true, blocked_reason: 'Major version bump',
          },
        },
      })}
      onApply={vi.fn()}
    />,
  );
  expect(apply()).toBeDisabled();
});

it('disables Apply for verification-only preview (no confirmed update)', () => {
  render(
    <MobileReadinessCard
      card={card({
        preview: {
          stack_name: 'redis', images: [], rollback_target: null, changelog: null,
          summary: {
            has_update: false,
            primary_image: 'redis',
            current_tag: '8.8.0',
            next_tag: '8.8.0',
            semver_bump: 'none',
            update_kind: 'none',
            blocked: false,
            blocked_reason: null,
            rebuild_available: false,
            verification_failed: true,
            verification_error: 'Could not verify digest',
          },
        },
      })}
      onApply={vi.fn()}
    />,
  );
  expect(apply()).toBeDisabled();
  expect(screen.getByTestId('readiness-verification-failed')).toBeInTheDocument();
});

it('disables Apply while an update is in flight', () => {
  render(<MobileReadinessCard card={card({ applying: true })} onApply={vi.fn()} />);
  // While applying the button label switches to "Applying...".
  expect(screen.getByRole('button', { name: /Applying/i })).toBeDisabled();
});

it('enables Apply when no schedule covers the stack', () => {
  render(<MobileReadinessCard card={card({ autoUpdateEnabled: false })} onApply={vi.fn()} />);
  expect(apply()).toBeEnabled();
});

it('offers per-service Apply when build-only companions make the stack multi-service', () => {
  const onApplyService = vi.fn();
  render(
    <MobileReadinessCard
      canServiceUpdate
      onApply={vi.fn()}
      onApplyService={onApplyService}
      card={card({
        preview: {
          stack_name: 'nextcloud',
          images: [{
            service: 'app',
            image: 'nextcloud:27',
            current_tag: '27.1.4',
            next_tag: '27.1.5',
            has_update: true,
            semver_bump: 'patch',
          }],
          build_services: ['cron'],
          summary: {
            has_update: true,
            primary_image: 'nextcloud',
            current_tag: '27.1.4',
            next_tag: '27.1.5',
            semver_bump: 'patch',
            update_kind: 'tag',
            blocked: false,
            blocked_reason: null,
            has_build_services: true,
          },
          rollback_target: null,
          changelog: 'Fixes.',
        },
      })}
    />,
  );
  const serviceApply = screen.getByRole('button', { name: /^Apply$/i });
  expect(serviceApply).toBeEnabled();
  fireEvent.click(serviceApply);
  expect(onApplyService).toHaveBeenCalledWith('nextcloud', 1, 'app');
});

/**
 * The desktop StackReadinessCard is not exported, so its Apply-now gating is
 * covered through a full-view render (useIsMobile is mocked false). A safe
 * update with no covering schedule must still offer an enabled Apply now: the
 * button is manual and schedule-independent, while the Auto: Off pill keeps
 * reflecting the missing schedule.
 */
describe('AutoUpdateReadinessView desktop Apply now', () => {
  const mockedFetch = apiFetch as unknown as ReturnType<typeof vi.fn>;
  const mockedFetchForNode = fetchForNode as unknown as ReturnType<typeof vi.fn>;

  afterEach(() => {
    mockedFetch.mockReset();
    mockedFetchForNode.mockReset();
    mockNodeMeta.clear();
    vi.mocked(requestServiceUpdate).mockReset();
  });

  it('enables Apply for a safe update with no covering schedule', async () => {
    mockedFetch.mockImplementation((url: string) => {
      if (url === '/image-updates/fleet') {
        return Promise.resolve({ ok: true, json: async () => ({ '1': { nextcloud: true } }) });
      }
      if (url.startsWith('/scheduled-tasks')) {
        return Promise.resolve({ ok: true, json: async () => [] });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });
    mockedFetchForNode.mockResolvedValue({ ok: true, json: async () => card().preview });

    render(<AutoUpdateReadinessView />);

    const applyBtn = await screen.findByRole('button', { name: /Apply now/i });
    expect(applyBtn).toBeEnabled();
    // A non-blocked card carries no title at all; the old schedule tooltip is gone.
    expect(applyBtn).not.toHaveAttribute('title');
    expect(screen.getByText(/Auto: Off/)).toBeInTheDocument();
    // The stack is enabled to apply manually but must NOT count as "ready to
    // apply automatically": that still requires a covering schedule.
    expect(screen.getByText(/0 of 1 ready to apply automatically/)).toBeInTheDocument();
  });

  it('applies a single service and refreshes the authoritative update preview', async () => {
    mockNodeMeta.set(1, {
      version: '1.0.0',
      capabilities: ['service-scoped-update'],
      fetchedAt: Date.now(),
    });
    const multiPreview = {
      stack_name: 'nextcloud',
      images: [
        {
          service: 'app',
          image: 'nextcloud:27',
          current_tag: '27.1.4',
          next_tag: '27.1.5',
          has_update: true,
          semver_bump: 'patch' as const,
        },
        {
          service: 'redis',
          image: 'redis:7',
          current_tag: '7.2',
          next_tag: '7.2',
          has_update: false,
          semver_bump: 'none' as const,
        },
      ],
      summary: {
        has_update: true,
        primary_image: 'nextcloud',
        current_tag: '27.1.4',
        next_tag: '27.1.5',
        semver_bump: 'patch' as const,
        update_kind: 'tag' as const,
        blocked: false,
        blocked_reason: null,
      },
      rollback_target: null,
      changelog: 'Fixes.',
    };
    const refreshedPreview = {
      ...multiPreview,
      images: multiPreview.images.map((img) => (
        img.service === 'app' ? { ...img, has_update: false, current_tag: '27.1.5', next_tag: '27.1.5' } : img
      )),
      summary: { ...multiPreview.summary, has_update: false, current_tag: '27.1.5' },
    };
    mockedFetch.mockImplementation((url: string) => {
      if (url === '/image-updates/fleet') {
        return Promise.resolve({ ok: true, json: async () => ({ '1': { nextcloud: true } }) });
      }
      if (url.startsWith('/scheduled-tasks')) {
        return Promise.resolve({ ok: true, json: async () => [] });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });
    mockedFetchForNode.mockImplementation((url: string) => {
      if (String(url).includes('/update-preview')) {
        const call = mockedFetchForNode.mock.calls.filter((c) => String(c[0]).includes('/update-preview')).length;
        return Promise.resolve({
          ok: true,
          json: async () => (call <= 1 ? multiPreview : refreshedPreview),
        });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });
    vi.mocked(requestServiceUpdate).mockResolvedValue({
      ok: true,
      mode: 'update',
      serviceName: 'app',
      healthGateId: null,
      observing: false,
      recoveryId: null,
      recoveryAvailable: false,
    });

    render(<AutoUpdateReadinessView />);
    const serviceApply = await screen.findByRole('button', { name: /^Apply$/i });
    await act(async () => { fireEvent.click(serviceApply); });

    await waitFor(() => {
      expect(requestServiceUpdate).toHaveBeenCalledWith(expect.objectContaining({
        stackName: 'nextcloud',
        serviceName: 'app',
        mode: 'update',
      }));
    });
    await waitFor(() => {
      expect(mockedFetchForNode.mock.calls.filter((c) => String(c[0]).includes('/update-preview')).length).toBeGreaterThanOrEqual(2);
    });
  });
});

/**
 * Local-node stacks whose latest check could not determine status never appear
 * in the card grid (which lists confirmed updates only), so the readiness view
 * surfaces them in a "could not be checked" advisory fed by a parallel local
 * /image-updates/detail fetch.
 */
describe('AutoUpdateReadinessView check-failed advisory', () => {
  const mockedFetch = apiFetch as unknown as ReturnType<typeof vi.fn>;
  const mockedFetchForNode = fetchForNode as unknown as ReturnType<typeof vi.fn>;

  afterEach(() => {
    mockedFetch.mockReset();
    mockedFetchForNode.mockReset();
    mockNodes.splice(0, mockNodes.length, { id: 1, name: 'Local', type: 'local', status: 'online' });
  });

  it('lists local stacks whose check failed, with the reason', async () => {
    mockedFetch.mockImplementation((url: string) => {
      if (url === '/image-updates/fleet') return Promise.resolve({ ok: true, json: async () => ({}) });
      if (url.startsWith('/scheduled-tasks')) return Promise.resolve({ ok: true, json: async () => [] });
      if (url === '/image-updates/detail') {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            grafana: { hasUpdate: false, checkStatus: 'failed', lastError: 'Registry unreachable for ghcr.io/acme/grafana:latest', checkedAt: 1 },
            web: { hasUpdate: false, checkStatus: 'ok', lastError: null, checkedAt: 1 },
          }),
        });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });
    mockedFetchForNode.mockResolvedValue({ ok: true, json: async () => null });

    render(<AutoUpdateReadinessView />);

    expect(await screen.findByText(/could not be checked/i)).toBeInTheDocument();
    expect(screen.getByText('grafana')).toBeInTheDocument();
    expect(screen.getByText(/Registry unreachable for ghcr.io\/acme\/grafana:latest/)).toBeInTheDocument();
    // An ok stack with no update must not appear in the advisory.
    expect(screen.queryByText('web')).toBeNull();
  });

  it('keeps sticky has_update+failed stacks in the advisory, not the update card grid', async () => {
    mockedFetch.mockImplementation((url: string) => {
      if (url === '/image-updates/fleet') {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            '1': { grafana: true, web: true },
          }),
        });
      }
      if (url.startsWith('/scheduled-tasks')) return Promise.resolve({ ok: true, json: async () => [] });
      if (url === '/image-updates/detail') {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            grafana: { hasUpdate: true, checkStatus: 'failed', lastError: 'Registry unreachable', checkedAt: 1 },
            web: { hasUpdate: true, checkStatus: 'ok', lastError: null, checkedAt: 1 },
          }),
        });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });
    mockedFetchForNode.mockImplementation((url: string, _nodeId: number) => {
      if (String(url).includes('/update-preview')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            stack_name: 'web',
            images: [{ service: 'web', image: 'nginx:1', current_tag: '1', next_tag: '2', has_update: true, semver_bump: 'patch', check_error: null }],
            summary: {
              has_update: true,
              primary_image: 'nginx:1',
              current_tag: '1',
              next_tag: '2',
              semver_bump: 'patch',
              update_kind: 'tag',
              blocked: false,
              blocked_reason: null,
              verification_failed: false,
              verification_error: null,
            },
            rollback_target: null,
            changelog: null,
          }),
        });
      }
      return Promise.resolve({ ok: true, json: async () => null });
    });

    render(<AutoUpdateReadinessView />);

    expect(await screen.findByText(/could not be checked/i)).toBeInTheDocument();
    expect(screen.getByText('grafana')).toBeInTheDocument();
    expect(screen.getByText(/Registry unreachable/)).toBeInTheDocument();
    // web remains a confirmed update card; grafana must not also render as a stack card heading.
    await waitFor(() => {
      const headings = screen.getAllByText('web');
      expect(headings.length).toBeGreaterThan(0);
    });
  });

  it('drops verification-only sticky stacks from the card grid into the advisory', async () => {
    mockedFetch.mockImplementation((url: string) => {
      if (url === '/image-updates/fleet') {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            '1': { redis: true },
          }),
        });
      }
      if (url.startsWith('/scheduled-tasks')) {
        return Promise.resolve({
          ok: true,
          json: async () => ([{
            id: 1,
            enabled: true,
            action: 'update',
            target_type: 'stack',
            target_id: 'redis',
            node_id: 1,
            next_run_at: Date.now() + 60_000,
          }]),
        });
      }
      if (url === '/image-updates/detail') {
        // Sticky hasUpdate with a successful check still enters the fleet grid;
        // only the fresh preview can prove verification-only.
        return Promise.resolve({
          ok: true,
          json: async () => ({
            redis: { hasUpdate: true, checkStatus: 'ok', lastError: null, checkedAt: 1 },
          }),
        });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });
    mockedFetchForNode.mockImplementation((url: string) => {
      if (String(url).includes('/update-preview')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            stack_name: 'redis',
            images: [{
              service: 'redis',
              image: 'redis:8.8.0',
              current_tag: '8.8.0',
              next_tag: '8.8.0',
              has_update: false,
              semver_bump: 'none',
              check_error: 'Could not verify digest',
            }],
            summary: {
              has_update: false,
              primary_image: 'redis:8.8.0',
              current_tag: '8.8.0',
              next_tag: '8.8.0',
              semver_bump: 'none',
              update_kind: 'none',
              blocked: false,
              blocked_reason: null,
              rebuild_available: false,
              verification_failed: true,
              verification_error: 'Could not verify digest',
            },
            rollback_target: null,
            changelog: null,
          }),
        });
      }
      return Promise.resolve({ ok: true, json: async () => null });
    });

    render(<AutoUpdateReadinessView />);

    expect(await screen.findByText(/could not be checked/i)).toBeInTheDocument();
    expect(screen.getByText('redis')).toBeInTheDocument();
    expect(screen.getByText(/Could not verify digest/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Apply now/i })).toBeNull();
    expect(screen.getByText(/Everything is up to date/)).toBeInTheDocument();
    expect(screen.queryByText(/ready to apply automatically/)).toBeNull();
  });

  it('keeps actionable cards while dropping verification-only stacks to the advisory', async () => {
    mockedFetch.mockImplementation((url: string) => {
      if (url === '/image-updates/fleet') {
        return Promise.resolve({
          ok: true,
          json: async () => ({ '1': { web: true, redis: true } }),
        });
      }
      if (url.startsWith('/scheduled-tasks')) {
        return Promise.resolve({
          ok: true,
          json: async () => ([
            {
              id: 1, enabled: true, action: 'update', target_type: 'stack',
              target_id: 'web', node_id: 1, next_run_at: Date.now() + 60_000,
            },
            {
              id: 2, enabled: true, action: 'update', target_type: 'stack',
              target_id: 'redis', node_id: 1, next_run_at: Date.now() + 60_000,
            },
          ]),
        });
      }
      if (url === '/image-updates/detail') {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            web: { hasUpdate: true, checkStatus: 'ok', lastError: null, checkedAt: 1 },
            redis: { hasUpdate: true, checkStatus: 'ok', lastError: null, checkedAt: 1 },
          }),
        });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });
    mockedFetchForNode.mockImplementation((url: string) => {
      if (String(url).includes('/stacks/web/update-preview')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            stack_name: 'web',
            images: [{ service: 'web', image: 'nginx:1', current_tag: '1', next_tag: '2', has_update: true, semver_bump: 'patch', check_error: null }],
            summary: {
              has_update: true, primary_image: 'nginx:1', current_tag: '1', next_tag: '2',
              semver_bump: 'patch', update_kind: 'tag', blocked: false, blocked_reason: null,
              verification_failed: false, verification_error: null,
            },
            rollback_target: null, changelog: null,
          }),
        });
      }
      if (String(url).includes('/stacks/redis/update-preview')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            stack_name: 'redis',
            images: [{ service: 'redis', image: 'redis:8.8.0', current_tag: '8.8.0', next_tag: '8.8.0', has_update: false, semver_bump: 'none', check_error: 'verify failed' }],
            summary: {
              has_update: false, primary_image: 'redis:8.8.0', current_tag: '8.8.0', next_tag: '8.8.0',
              semver_bump: 'none', update_kind: 'none', blocked: false, blocked_reason: null,
              rebuild_available: false, verification_failed: true, verification_error: 'verify failed',
            },
            rollback_target: null, changelog: null,
          }),
        });
      }
      return Promise.resolve({ ok: true, json: async () => null });
    });

    render(<AutoUpdateReadinessView />);

    expect(await screen.findByRole('button', { name: /Apply now/i })).toBeEnabled();
    expect(screen.getByText(/1 of 1 ready to apply automatically/)).toBeInTheDocument();
    expect(screen.getByText(/could not be checked/i)).toBeInTheDocument();
    expect(screen.getByText(/verify failed/)).toBeInTheDocument();
  });

  it('counts a sticky cleared preview as not ready while keeping the card', async () => {
    // Sticky fleet still lists the stack, but fresh preview has no update and
    // no verification failure. Card stays; ready filter must not count it.
    mockedFetch.mockImplementation((url: string) => {
      if (url === '/image-updates/fleet') {
        return Promise.resolve({ ok: true, json: async () => ({ '1': { redis: true } }) });
      }
      if (url.startsWith('/scheduled-tasks')) {
        return Promise.resolve({
          ok: true,
          json: async () => ([{
            id: 1, enabled: true, action: 'update', target_type: 'stack',
            target_id: 'redis', node_id: 1, next_run_at: Date.now() + 60_000,
          }]),
        });
      }
      if (url === '/image-updates/detail') {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            redis: { hasUpdate: true, checkStatus: 'ok', lastError: null, checkedAt: 1 },
          }),
        });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });
    mockedFetchForNode.mockImplementation((url: string) => {
      if (String(url).includes('/update-preview')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            stack_name: 'redis',
            images: [{
              service: 'redis', image: 'redis:8.8.0', current_tag: '8.8.0', next_tag: '8.8.0',
              has_update: false, semver_bump: 'none', check_error: null,
            }],
            summary: {
              has_update: false, primary_image: 'redis:8.8.0', current_tag: '8.8.0', next_tag: '8.8.0',
              semver_bump: 'none', update_kind: 'none', blocked: false, blocked_reason: null,
              rebuild_available: false, verification_failed: false, verification_error: null,
            },
            rollback_target: null, changelog: null,
          }),
        });
      }
      return Promise.resolve({ ok: true, json: async () => null });
    });

    render(<AutoUpdateReadinessView />);

    expect(await screen.findByRole('button', { name: /Apply now/i })).toBeEnabled();
    expect(screen.getByText(/0 of 1 ready to apply automatically/)).toBeInTheDocument();
    expect(screen.queryByText(/could not be checked/i)).toBeNull();
  });

  it('labels remote verification-only stacks with the node name in the advisory', async () => {
    mockNodes.splice(0, mockNodes.length,
      { id: 1, name: 'Local', type: 'local', status: 'online' },
      { id: 2, name: 'Edge', type: 'remote', status: 'online' },
    );
    mockedFetch.mockImplementation((url: string) => {
      if (url === '/image-updates/fleet') {
        return Promise.resolve({
          ok: true,
          json: async () => ({ '2': { redis: true } }),
        });
      }
      if (url.startsWith('/scheduled-tasks')) {
        return Promise.resolve({ ok: true, json: async () => [] });
      }
      // Local-only detail cannot see remote sticky failures; preview must move them.
      if (url === '/image-updates/detail') {
        return Promise.resolve({ ok: true, json: async () => ({}) });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });
    mockedFetchForNode.mockImplementation((url: string, nodeId: number) => {
      if (nodeId === 2 && String(url).includes('/update-preview')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            stack_name: 'redis',
            images: [{
              service: 'redis', image: 'redis:8.8.0', current_tag: '8.8.0', next_tag: '8.8.0',
              has_update: false, semver_bump: 'none', check_error: 'Could not verify digest',
            }],
            summary: {
              has_update: false, primary_image: 'redis:8.8.0', current_tag: '8.8.0', next_tag: '8.8.0',
              semver_bump: 'none', update_kind: 'none', blocked: false, blocked_reason: null,
              rebuild_available: false, verification_failed: true, verification_error: 'Could not verify digest',
            },
            rollback_target: null, changelog: null,
          }),
        });
      }
      return Promise.resolve({ ok: true, json: async () => null });
    });

    render(<AutoUpdateReadinessView />);

    expect(await screen.findByText(/could not be checked/i)).toBeInTheDocument();
    expect(screen.getByText('redis (Edge)')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Apply now/i })).toBeNull();
  });
});

/**
 * CadenceStrip surfaces the control instance's detection cadence by the
 * readiness card: a past last-check must read as an "ago" value (not the
 * future-oriented "due now"), null timestamps read as never/not-scheduled, and
 * the manual-recheck cooldown ticks down to "Recheck ready".
 */
describe('CadenceStrip', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders a past last-check as an "ago" value, not "due now"', () => {
    const cadence = {
      checking: false,
      intervalMinutes: 120,
      lastCheckedAt: Date.now() - 10 * 60 * 1000,
      nextCheckAt: Date.now() + 110 * 60 * 1000,
      manualCooldownMinutes: 2,
      manualCooldownRemainingMs: 0,
      mode: 'interval' as const,
      cronExpression: null,
    };
    render(<CadenceStrip cadence={cadence} />);
    expect(screen.getByText(/Last checked 10m ago/)).toBeInTheDocument();
    expect(screen.queryByText(/due now/)).not.toBeInTheDocument();
    expect(screen.getByText(/Recheck ready/)).toBeInTheDocument();
  });

  it('renders null timestamps as never / not scheduled', () => {
    const cadence = {
      checking: false,
      intervalMinutes: 120,
      lastCheckedAt: null,
      nextCheckAt: null,
      manualCooldownMinutes: 2,
      manualCooldownRemainingMs: 0,
      mode: 'interval' as const,
      cronExpression: null,
    };
    render(<CadenceStrip cadence={cadence} />);
    expect(screen.getByText(/Last checked never/)).toBeInTheDocument();
    expect(screen.getByText(/Next check not scheduled/)).toBeInTheDocument();
  });

  it('counts the manual-recheck cooldown down to "Recheck ready"', () => {
    vi.useFakeTimers();
    const cadence = {
      checking: false,
      intervalMinutes: 120,
      lastCheckedAt: Date.now(),
      nextCheckAt: Date.now() + 7_200_000,
      manualCooldownMinutes: 2,
      manualCooldownRemainingMs: 3000,
      mode: 'interval' as const,
      cronExpression: null,
    };
    render(<CadenceStrip cadence={cadence} />);
    expect(screen.getByText(/Recheck available in 3s/)).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(3000); });
    expect(screen.getByText(/Recheck ready/)).toBeInTheDocument();
  });
});

/**
 * The cadence fetch runs on mount AND after a Recheck. A slow initial /status
 * response that resolves after the recheck-triggered one must not overwrite the
 * fresh cooldown the recheck just loaded.
 */
describe('AutoUpdateReadinessView cadence fetch race', () => {
  const mockedFetch = apiFetch as unknown as ReturnType<typeof vi.fn>;

  afterEach(() => {
    vi.clearAllMocks();
  });

  function statusDeferred() {
    let resolveWith!: (manualCooldownRemainingMs: number) => void;
    const promise = new Promise<{ ok: true; json: () => Promise<unknown> }>((resolve) => {
      resolveWith = (manualCooldownRemainingMs: number) =>
        resolve({
          ok: true,
          json: async () => ({
            checking: false,
            intervalMinutes: 120,
            lastCheckedAt: Date.now() - 60_000,
            nextCheckAt: Date.now() + 3_600_000,
            manualCooldownMinutes: 2,
            manualCooldownRemainingMs,
          }),
        });
    });
    return { promise, resolveWith };
  }

  it('drops a stale /status response so a recheck cooldown is not overwritten', async () => {
    const statusCalls: ReturnType<typeof statusDeferred>[] = [];
    mockedFetch.mockImplementation((url: string) => {
      if (url === '/image-updates/fleet') return Promise.resolve({ ok: true, json: async () => ({}) });
      if (url.startsWith('/scheduled-tasks')) return Promise.resolve({ ok: true, json: async () => [] });
      if (url === '/image-updates/fleet/refresh') {
        return Promise.resolve({ ok: true, json: async () => ({ triggered: [1], rateLimited: [], failed: [] }) });
      }
      if (url === '/image-updates/status') {
        const d = statusDeferred();
        statusCalls.push(d);
        return d.promise;
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });

    render(<AutoUpdateReadinessView />);

    // Mount fired the first /status (A); it stays pending. The hero renders once
    // the readiness load settles.
    const recheck = await screen.findByRole('button', { name: /recheck registries/i });
    expect(statusCalls).toHaveLength(1);

    // Recheck fires a second /status (B); resolve it with an active cooldown.
    await act(async () => { fireEvent.click(recheck); });
    await waitFor(() => expect(statusCalls).toHaveLength(2));
    await act(async () => { statusCalls[1].resolveWith(120_000); });
    await screen.findByText(/Recheck available in/);

    // The slow initial load (A) resolves last with no cooldown. The token guard
    // must drop it so the strip keeps showing the recheck cooldown.
    await act(async () => {
      statusCalls[0].resolveWith(0);
      await Promise.resolve();
    });

    expect(screen.queryByText(/Recheck ready/)).toBeNull();
    expect(screen.getByText(/Recheck available in/)).toBeInTheDocument();
  });
});
