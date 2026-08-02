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
vi.mock('@/context/AuthContext', () => ({ useAuth: () => ({ can: () => true }) }));
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
import { toast } from '@/components/ui/toast-store';
import AutoUpdateReadinessView, {
  MobileReadinessCard,
  CadenceStrip,
  type StackCard,
} from '../AutoUpdateReadinessView';
import {
  isActionableUpdatePreview,
  isClearedUpdatePreview,
  isReviewRequiredUpdatePreview,
  isTagOnlyAdvisory,
  isVerificationOnlyPreview,
} from '@/lib/updatePreviewActionability';
import { isAuthoritativeNegativePreview } from '@/types/imageUpdates';

function card(over: Partial<StackCard> = {}): StackCard {
  return {
    stack: 'nextcloud',
    nodeId: 1,
    previewLoaded: true,
    applying: false,
    applyingService: null,
    autoUpdateEnabled: true,
    scheduledTask: null,
    verificationNote: null,
    preview: {
      stack_name: 'nextcloud',
      images: [{
        service: 'app', image: 'nextcloud:27.1.4', current_tag: '27.1.4', next_tag: '27.1.4',
        has_update: true, digest_update: true, tag_update: false, semver_bump: 'patch', check_status: 'ok',
      }],
      summary: {
        has_update: true,
        primary_image: 'nextcloud',
        current_tag: '27.1.4',
        next_tag: '27.1.4',
        semver_bump: 'patch',
        update_kind: 'digest',
        blocked: false,
        blocked_reason: null,
        check_status: 'ok',
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
      check_status: 'ok' as const,
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

  it('holds a verified update for review, not full-stack-actionable, when another image failed verification', () => {
    const preview = previewSummary({
      verification_failed: true,
      has_update: true,
      update_kind: 'tag',
      semver_bump: 'patch',
      next_tag: '8.8.1',
    });
    expect(isVerificationOnlyPreview(preview)).toBe(false);
    expect(isReviewRequiredUpdatePreview(preview)).toBe(true);
    expect(isActionableUpdatePreview(preview)).toBe(false);
  });

  it('holds a rebuild for review, not full-stack-actionable, when another image failed verification', () => {
    const preview = previewSummary({
      verification_failed: true,
      rebuild_available: true,
      update_kind: 'digest',
    });
    expect(isVerificationOnlyPreview(preview)).toBe(false);
    expect(isReviewRequiredUpdatePreview(preview)).toBe(true);
    expect(isActionableUpdatePreview(preview)).toBe(false);
  });

  it('does not treat a review-required mixed state as cleared', () => {
    const preview = previewSummary({
      verification_failed: true,
      has_update: true,
      update_kind: 'tag',
      semver_bump: 'patch',
      next_tag: '8.8.1',
    });
    expect(isClearedUpdatePreview(preview)).toBe(false);
  });

  it('keeps a single image with a confirmed digest update actionable when there is no digest error anywhere in the stack', () => {
    // digest_update and digest_error are mutually exclusive for one image (both
    // derive from the same comparison), so a confirmed digest update is always
    // its own clean case, with nothing to hold it for review.
    const preview = {
      ...previewSummary({ has_update: true, update_kind: 'digest', semver_bump: 'patch' }),
      images: [{ has_update: true, digest_update: true, digest_error: null }],
    };
    expect(isReviewRequiredUpdatePreview(preview)).toBe(false);
    expect(isActionableUpdatePreview(preview)).toBe(true);
  });

  it('holds a confirmed update for review when a genuinely different image failed digest verification', () => {
    const preview = {
      ...previewSummary({ verification_failed: true, has_update: true, update_kind: 'digest', semver_bump: 'patch' }),
      images: [
        { has_update: true, digest_update: true, digest_error: null },
        { has_update: false, digest_update: false, digest_error: 'Registry unreachable' },
      ],
    };
    expect(isReviewRequiredUpdatePreview(preview)).toBe(true);
    expect(isActionableUpdatePreview(preview)).toBe(false);
  });

  it('holds a confirmed update for review even when the other image\'s own tag update masks its digest error into an overall ok check_status', () => {
    // The second image's tag compare confirmed an update, so the backend masks
    // its digest failure into check_status 'ok' + check_error null. Only the
    // unmasked digest_error still reports that its content went unverified.
    const preview = {
      ...previewSummary({ has_update: true, update_kind: 'digest', semver_bump: 'patch', check_status: 'ok' }),
      images: [
        { has_update: true, digest_update: true, check_status: 'ok', check_error: null, digest_error: null },
        {
          has_update: true, digest_update: false, tag_update: true,
          check_status: 'ok', check_error: null, digest_error: 'Registry unreachable',
        },
      ],
    };
    expect(isReviewRequiredUpdatePreview(preview)).toBe(true);
    expect(isActionableUpdatePreview(preview)).toBe(false);
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

  it('keeps a legacy preview that reports its own has_update:true fully actionable (trusts the remote\'s own confirmed update)', () => {
    // isLegacyPreview only guards isClearedUpdatePreview: a legacy remote that
    // itself confirms an update is not additionally gated by a verification
    // signal it never had. This is deliberate, not an oversight -- the
    // sticky/preview agreement (both say "update") is what matters here.
    const legacyPreview = {
      stack_name: 'redis',
      images: [],
      rollback_target: null,
      changelog: null,
      summary: {
        has_update: true,
        primary_image: 'redis',
        current_tag: '8.8.0',
        next_tag: '8.8.1',
        semver_bump: 'patch' as const,
        update_kind: 'digest' as const,
        blocked: false,
        blocked_reason: null,
        // check_status, verification_failed, and rebuild_available intentionally omitted.
      },
    };
    expect(isActionableUpdatePreview(legacyPreview)).toBe(true);
    expect(isClearedUpdatePreview(legacyPreview)).toBe(false);
  });

  it('does not treat a legacy remote preview (verification_failed missing entirely) as cleared', () => {
    // The current backend always sends verification_failed (true or false);
    // its total absence means the response came from an older remote that
    // predates digest verification and cannot vouch for a clean result.
    const legacyPreview = {
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
        // verification_failed and rebuild_available intentionally omitted.
      },
    };
    expect(isClearedUpdatePreview(legacyPreview)).toBe(false);
  });

  it('returns false for null/undefined previews', () => {
    expect(isVerificationOnlyPreview(null)).toBe(false);
    expect(isVerificationOnlyPreview(undefined)).toBe(false);
    expect(isActionableUpdatePreview(null)).toBe(false);
    expect(isActionableUpdatePreview(undefined)).toBe(false);
    expect(isClearedUpdatePreview(null)).toBe(false);
    expect(isClearedUpdatePreview(undefined)).toBe(false);
  });

  it('treats a successful no-update preview as cleared', () => {
    const preview = previewSummary({
      has_update: false,
      rebuild_available: false,
      verification_failed: false,
    });
    expect(isClearedUpdatePreview(preview)).toBe(true);
    expect(isActionableUpdatePreview(preview)).toBe(false);
  });

  it('does not treat blocked updates as cleared', () => {
    const preview = previewSummary({
      has_update: true,
      blocked: true,
      blocked_reason: 'Major version bump',
      semver_bump: 'major',
      update_kind: 'tag',
    });
    expect(isClearedUpdatePreview(preview)).toBe(false);
    expect(isActionableUpdatePreview(preview)).toBe(false);
  });

  it('does not treat a tag-only advisory as cleared (Fleet must keep the card)', () => {
    const preview = {
      ...previewSummary({
        has_update: true,
        update_kind: 'tag',
        semver_bump: 'patch',
        next_tag: '1.31.3',
        current_tag: '1.25.3',
      }),
      images: [{
        service: 'web',
        image: 'nginx:1.25.3',
        has_update: true,
        digest_update: false,
        tag_update: true,
        check_status: 'ok',
      }],
    };
    expect(isTagOnlyAdvisory(preview)).toBe(true);
    expect(isActionableUpdatePreview(preview)).toBe(false);
    expect(isClearedUpdatePreview(preview)).toBe(false);
  });
});

it('enables Apply for a safe, non-blocked update', () => {
  render(<MobileReadinessCard card={card()} onApply={vi.fn()} />);
  expect(apply()).toBeEnabled();
});

it('disables Apply for tag-only advisory updates', () => {
  render(
    <MobileReadinessCard
      card={card({
        preview: {
          stack_name: 'nextcloud',
          images: [{
            service: 'app', image: 'nextcloud:27.1.4', current_tag: '27.1.4', next_tag: '27.1.5',
            has_update: true, digest_update: false, tag_update: true, semver_bump: 'patch', check_status: 'ok',
          }],
          summary: {
            has_update: true,
            primary_image: 'nextcloud',
            current_tag: '27.1.4',
            next_tag: '27.1.5',
            semver_bump: 'patch',
            update_kind: 'tag',
            blocked: false,
            blocked_reason: null,
            check_status: 'ok',
          },
          rollback_target: null,
          changelog: 'Fixes.',
        },
      })}
      onApply={vi.fn()}
    />,
  );
  expect(screen.getByText(/Newer tag/i)).toBeInTheDocument();
  expect(apply()).toBeDisabled();
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

it('holds full-stack Apply for review when one image confirms an update and another fails verification, but keeps per-service Apply enabled', () => {
  const onApplyService = vi.fn();
  render(
    <MobileReadinessCard
      card={card({
        preview: {
          stack_name: 'mixed', rollback_target: null, changelog: null,
          images: [
            { service: 'confirmed', image: 'alpine:latest', current_tag: 'latest', next_tag: 'latest', has_update: true, digest_update: true, semver_bump: 'patch', digest_error: null },
            { service: 'failing', image: 'private.example/db:latest', current_tag: 'latest', next_tag: null, has_update: false, digest_update: false, semver_bump: 'none', digest_error: 'Registry unreachable' },
          ],
          summary: {
            has_update: true,
            primary_image: 'alpine:latest',
            current_tag: 'latest',
            next_tag: 'latest',
            semver_bump: 'patch',
            update_kind: 'digest',
            blocked: false,
            blocked_reason: null,
            rebuild_available: false,
            verification_failed: true,
            verification_error: 'Registry unreachable',
          },
        },
      })}
      canServiceUpdate
      onApply={vi.fn()}
      onApplyService={onApplyService}
    />,
  );
  expect(apply()).toBeDisabled();
  expect(screen.getByTestId('readiness-verification-warning')).toBeInTheDocument();
  expect(screen.queryByText(/Safe · patch/i)).toBeNull();
  expect(screen.getByText(/Review · unverified/i)).toBeInTheDocument();
  const serviceApply = screen.getByRole('button', { name: /^Apply$/i });
  expect(serviceApply).toBeEnabled();
  fireEvent.click(serviceApply);
  expect(onApplyService).toHaveBeenCalledWith('nextcloud', 1, 'confirmed');
});

it('shows the blocked (major) badge, not the review-required badge, when both apply', () => {
  render(
    <MobileReadinessCard
      card={card({
        preview: {
          stack_name: 'gitea', images: [], rollback_target: null, changelog: null,
          summary: {
            has_update: true, primary_image: 'gitea', current_tag: '1.21', next_tag: '2.0',
            semver_bump: 'major', update_kind: 'tag', blocked: true, blocked_reason: 'Major version bump',
            rebuild_available: false, verification_failed: true, verification_error: 'Registry unreachable',
          },
        },
      })}
      onApply={vi.fn()}
    />,
  );
  expect(screen.getByText(/Blocked · major/i)).toBeInTheDocument();
  expect(screen.queryByText(/Review · unverified/i)).toBeNull();
  expect(apply()).toBeDisabled();
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
            next_tag: '27.1.4',
            has_update: true,
            digest_update: true,
            tag_update: false,
            semver_bump: 'patch',
            check_status: 'ok',
          }],
          build_services: ['cron'],
          summary: {
            has_update: true,
            primary_image: 'nextcloud',
            current_tag: '27.1.4',
            next_tag: '27.1.5',
            semver_bump: 'patch',
            update_kind: 'digest',
            blocked: false,
            blocked_reason: null,
            has_build_services: true,
            check_status: 'ok',
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
    vi.mocked(toast.info).mockReset();
    vi.mocked(toast.success).mockReset();
    vi.mocked(toast.error).mockReset();
    vi.mocked(toast.loading).mockReset();
    vi.mocked(toast.dismiss).mockReset();
    mockNodes.splice(0, mockNodes.length, { id: 1, name: 'Local', type: 'local', status: 'online' });
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
          next_tag: '27.1.4',
          has_update: true,
          digest_update: true,
          tag_update: false,
          semver_bump: 'patch' as const,
          check_status: 'ok' as const,
        },
        {
          service: 'redis',
          image: 'redis:7',
          current_tag: '7.2',
          next_tag: '7.2',
          has_update: false,
          digest_update: false,
          tag_update: false,
          semver_bump: 'none' as const,
          check_status: 'ok' as const,
        },
      ],
      summary: {
        has_update: true,
        primary_image: 'nextcloud',
        current_tag: '27.1.4',
        next_tag: '27.1.4',
        semver_bump: 'patch' as const,
        update_kind: 'digest' as const,
        blocked: false,
        blocked_reason: null,
        check_status: 'ok' as const,
      },
      rollback_target: null,
      changelog: 'Fixes.',
    };
    const refreshedPreview = {
      ...multiPreview,
      images: multiPreview.images.map((img) => (
        img.service === 'app' ? { ...img, has_update: false, digest_update: false, current_tag: '27.1.4', next_tag: '27.1.4' } : img
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

  const basePreview = {
    stack_name: 'nextcloud',
    images: [{
      service: 'app',
      image: 'nextcloud:27',
      current_tag: '27.1.4',
      next_tag: '27.1.4',
      has_update: true,
      digest_update: true,
      tag_update: false,
      semver_bump: 'patch' as const,
      check_status: 'ok' as const,
      check_error: null,
      digest_error: null,
    }],
    summary: {
      has_update: true,
      primary_image: 'nextcloud',
      current_tag: '27.1.4',
      next_tag: '27.1.4',
      semver_bump: 'patch' as const,
      update_kind: 'digest' as const,
      blocked: false,
      blocked_reason: null,
      rebuild_available: false,
      check_status: 'ok' as const,
      verification_failed: false,
      verification_error: null,
    },
    rollback_target: null,
    changelog: 'Fixes.',
  };

  function mockFleetLoad(fleetMap: Record<string, Record<string, boolean>>) {
    mockedFetch.mockImplementation((url: string) => {
      if (url === '/image-updates/fleet') {
        return Promise.resolve({ ok: true, json: async () => fleetMap });
      }
      if (url.startsWith('/scheduled-tasks')) {
        return Promise.resolve({ ok: true, json: async () => [] });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });
  }

  it('removes the card only after a cleared preview with no recheckWarning', async () => {
    mockFleetLoad({ '1': { nextcloud: true } });
    const cleared = {
      ...basePreview,
      images: basePreview.images.map((img) => ({ ...img, has_update: false, digest_update: false })),
      summary: { ...basePreview.summary, has_update: false },
    };
    mockedFetchForNode.mockImplementation((url: string, _nodeId?: number, init?: { method?: string }) => {
      if (String(url).includes('/update') && !String(url).includes('update-preview') && init?.method === 'POST') {
        return Promise.resolve({ ok: true, json: async () => ({ status: 'Update completed' }) });
      }
      if (String(url).includes('/update-preview')) {
        const previewCalls = mockedFetchForNode.mock.calls.filter((c) => String(c[0]).includes('/update-preview')).length;
        return Promise.resolve({
          ok: true,
          json: async () => (previewCalls <= 1 ? basePreview : cleared),
        });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });

    render(<AutoUpdateReadinessView />);
    const applyBtn = await screen.findByRole('button', { name: /Apply now/i });
    await act(async () => { fireEvent.click(applyBtn); });

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /Apply now/i })).not.toBeInTheDocument();
    });
    const postIdx = mockedFetchForNode.mock.calls.findIndex(
      (c) => String(c[0]).includes('/stacks/nextcloud/update') && !String(c[0]).includes('update-preview'),
    );
    const previewAfter = mockedFetchForNode.mock.calls.findIndex(
      (c, i) => i > postIdx && String(c[0]).includes('/update-preview'),
    );
    expect(postIdx).toBeGreaterThanOrEqual(0);
    expect(previewAfter).toBeGreaterThan(postIdx);
    expect(mockedFetchForNode.mock.calls[postIdx][1]).toBe(1);
    expect(mockedFetchForNode.mock.calls[previewAfter][1]).toBe(1);
  });

  it('retains the card and warns when the preview still reports an update', async () => {
    mockFleetLoad({ '1': { nextcloud: true } });
    mockedFetchForNode.mockImplementation((url: string, _nodeId?: number, init?: { method?: string }) => {
      if (String(url).includes('/update') && !String(url).includes('update-preview') && init?.method === 'POST') {
        return Promise.resolve({ ok: true, json: async () => ({ status: 'Update completed' }) });
      }
      if (String(url).includes('/update-preview')) {
        return Promise.resolve({ ok: true, json: async () => basePreview });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });

    render(<AutoUpdateReadinessView />);
    const applyBtn = await screen.findByRole('button', { name: /Apply now/i });
    await act(async () => { fireEvent.click(applyBtn); });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Apply now/i })).toBeEnabled();
    });
    expect(toast.info).toHaveBeenCalledWith(
      'The update command completed, but Sencho still detects an available image update.',
    );
  });

  it('retains the card when post-Apply preview is partial (not an authoritative clear)', async () => {
    mockFleetLoad({ '1': { nextcloud: true } });
    const partialNegative = {
      ...basePreview,
      images: basePreview.images.map((img) => ({
        ...img,
        has_update: false,
        digest_update: false,
        tag_update: false,
        check_status: 'partial' as const,
        check_error: 'registry timeout',
      })),
      summary: {
        ...basePreview.summary,
        has_update: false,
        check_status: 'partial' as const,
      },
    };
    mockedFetchForNode.mockImplementation((url: string, _nodeId?: number, init?: { method?: string }) => {
      if (String(url).includes('/update') && !String(url).includes('update-preview') && init?.method === 'POST') {
        return Promise.resolve({ ok: true, json: async () => ({ status: 'Update completed' }) });
      }
      if (String(url).includes('/update-preview')) {
        const previewCalls = mockedFetchForNode.mock.calls.filter((c) => String(c[0]).includes('/update-preview')).length;
        return Promise.resolve({
          ok: true,
          json: async () => (previewCalls <= 1 ? basePreview : partialNegative),
        });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });

    render(<AutoUpdateReadinessView />);
    const applyBtn = await screen.findByRole('button', { name: /Apply now/i });
    await act(async () => { fireEvent.click(applyBtn); });

    await waitFor(() => {
      expect(screen.getAllByText('nextcloud').length).toBeGreaterThan(0);
    });
    expect(screen.queryByText(/Everything is up to date/)).toBeNull();
    expect(screen.getByText(/1 update pending/)).toBeInTheDocument();
    expect(isAuthoritativeNegativePreview(partialNegative)).toBe(false);
    expect(isClearedUpdatePreview(partialNegative)).toBe(false);
  });

  it('retains an unknown card when recheckWarning disagrees with a cleared preview', async () => {
    mockFleetLoad({ '1': { nextcloud: true } });
    const cleared = {
      ...basePreview,
      images: basePreview.images.map((img) => ({ ...img, has_update: false, digest_update: false })),
      summary: { ...basePreview.summary, has_update: false },
    };
    mockedFetchForNode.mockImplementation((url: string, _nodeId?: number, init?: { method?: string }) => {
      if (String(url).includes('/update') && !String(url).includes('update-preview') && init?.method === 'POST') {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            status: 'Update completed',
            recheckWarning: 'The update command completed, but Sencho still detects an available image update.',
          }),
        });
      }
      if (String(url).includes('/update-preview')) {
        const previewCalls = mockedFetchForNode.mock.calls.filter((c) => String(c[0]).includes('/update-preview')).length;
        return Promise.resolve({
          ok: true,
          json: async () => (previewCalls <= 1 ? basePreview : cleared),
        });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });

    render(<AutoUpdateReadinessView />);
    const applyBtn = await screen.findByRole('button', { name: /Apply now/i });
    await act(async () => { fireEvent.click(applyBtn); });

    await waitFor(() => {
      expect(screen.getByText(
        'The update command completed, but Sencho still detects an available image update.',
      )).toBeInTheDocument();
    });
    expect(screen.getByText('nextcloud')).toBeInTheDocument();
    expect(screen.queryByText(/Preview failed/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Apply now/i })).not.toBeInTheDocument();
    expect(toast.info).toHaveBeenCalledWith(
      'The update command completed, but Sencho still detects an available image update.',
    );
  });

  it('retains an unknown card when the post-Apply preview request fails', async () => {
    mockFleetLoad({ '1': { nextcloud: true } });
    mockedFetchForNode.mockImplementation((url: string, _nodeId?: number, init?: { method?: string }) => {
      if (String(url).includes('/update') && !String(url).includes('update-preview') && init?.method === 'POST') {
        return Promise.resolve({ ok: true, json: async () => ({ status: 'Update completed' }) });
      }
      if (String(url).includes('/update-preview')) {
        const previewCalls = mockedFetchForNode.mock.calls.filter((c) => String(c[0]).includes('/update-preview')).length;
        if (previewCalls <= 1) {
          return Promise.resolve({ ok: true, json: async () => basePreview });
        }
        return Promise.resolve({ ok: false, status: 500, json: async () => ({ error: 'boom' }) });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });

    render(<AutoUpdateReadinessView />);
    const applyBtn = await screen.findByRole('button', { name: /Apply now/i });
    await act(async () => { fireEvent.click(applyBtn); });

    await waitFor(() => {
      expect(screen.getByText(/Preview failed/i)).toBeInTheDocument();
    });
    expect(screen.getByText('nextcloud')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Apply now/i })).not.toBeInTheDocument();
  });

  it('pins full-stack Apply POST and preview to a remote card nodeId', async () => {
    mockNodes.splice(0, mockNodes.length,
      { id: 1, name: 'Local', type: 'local', status: 'online' },
      { id: 2, name: 'Remote', type: 'remote', status: 'online' },
    );
    mockFleetLoad({ '2': { nextcloud: true } });
    const cleared = {
      ...basePreview,
      images: basePreview.images.map((img) => ({ ...img, has_update: false, digest_update: false })),
      summary: { ...basePreview.summary, has_update: false },
    };
    mockedFetchForNode.mockImplementation((url: string, _nodeId?: number, init?: { method?: string }) => {
      if (String(url).includes('/update') && !String(url).includes('update-preview') && init?.method === 'POST') {
        return Promise.resolve({ ok: true, json: async () => ({ status: 'Update completed' }) });
      }
      if (String(url).includes('/update-preview')) {
        const previewCalls = mockedFetchForNode.mock.calls.filter((c) => String(c[0]).includes('/update-preview')).length;
        return Promise.resolve({
          ok: true,
          json: async () => (previewCalls <= 1 ? basePreview : cleared),
        });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });

    render(<AutoUpdateReadinessView />);
    const applyBtn = await screen.findByRole('button', { name: /Apply now/i });
    await act(async () => { fireEvent.click(applyBtn); });

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /Apply now/i })).not.toBeInTheDocument();
    });
    const postCall = mockedFetchForNode.mock.calls.find(
      (c) => String(c[0]).includes('/stacks/nextcloud/update') && !String(c[0]).includes('update-preview'),
    );
    const postApplyPreview = mockedFetchForNode.mock.calls.filter(
      (c) => String(c[0]).includes('/update-preview') && c[1] === 2,
    );
    expect(postCall?.[1]).toBe(2);
    expect(postApplyPreview.length).toBeGreaterThanOrEqual(2);
    mockNodes.splice(0, mockNodes.length, { id: 1, name: 'Local', type: 'local', status: 'online' });
  });

  it('holds the desktop full-stack Apply for review, but keeps per-service Apply enabled, when a confirmed update sits alongside another image failing verification', async () => {
    mockNodeMeta.set(1, {
      version: '1.0.0',
      capabilities: ['service-scoped-update'],
      fetchedAt: Date.now(),
    });
    mockedFetch.mockImplementation((url: string) => {
      if (url === '/image-updates/fleet') {
        return Promise.resolve({ ok: true, json: async () => ({ '1': { mixed: true } }) });
      }
      if (url.startsWith('/scheduled-tasks')) {
        return Promise.resolve({ ok: true, json: async () => [] });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });
    mockedFetchForNode.mockResolvedValue({
      ok: true,
      json: async () => ({
        stack_name: 'mixed',
        images: [
          { service: 'confirmed', image: 'alpine:latest', current_tag: 'latest', next_tag: 'latest', has_update: true, digest_update: true, semver_bump: 'patch', digest_error: null },
          { service: 'failing', image: 'private.example/db:latest', current_tag: 'latest', next_tag: null, has_update: false, digest_update: false, semver_bump: 'none', digest_error: 'Registry unreachable' },
        ],
        summary: {
          has_update: true,
          primary_image: 'alpine:latest',
          current_tag: 'latest',
          next_tag: 'latest',
          semver_bump: 'patch',
          update_kind: 'digest',
          blocked: false,
          blocked_reason: null,
          rebuild_available: false,
          verification_failed: true,
          verification_error: 'Registry unreachable',
        },
        rollback_target: null,
        changelog: null,
      }),
    });
    vi.mocked(requestServiceUpdate).mockResolvedValue({
      ok: true,
      mode: 'update',
      serviceName: 'confirmed',
      healthGateId: null,
      observing: false,
      recoveryId: null,
      recoveryAvailable: false,
    });

    render(<AutoUpdateReadinessView />);

    const applyBtn = await screen.findByRole('button', { name: /Apply now/i });
    expect(applyBtn).toBeDisabled();
    expect(screen.queryByText(/Safe · patch/i)).toBeNull();
    expect(screen.getByText(/Review · unverified/i)).toBeInTheDocument();
    expect(screen.getByTestId('readiness-verification-warning')).toBeInTheDocument();

    const serviceApply = screen.getByRole('button', { name: /^Apply$/i });
    expect(serviceApply).toBeEnabled();
    await act(async () => { fireEvent.click(serviceApply); });
    await waitFor(() => {
      expect(requestServiceUpdate).toHaveBeenCalledWith(expect.objectContaining({
        stackName: 'mixed',
        serviceName: 'confirmed',
      }));
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
    mockedFetchForNode.mockImplementation((url: string) => {
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
    expect(screen.getByText('No verified updates')).toBeInTheDocument();
    expect(screen.queryByText(/Everything is up to date/)).toBeNull();
    expect(screen.getByText('No verified updates pending')).toBeInTheDocument();
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
            images: [{
              service: 'web', image: 'nginx:1', current_tag: '1', next_tag: '2',
              has_update: true, digest_update: true, semver_bump: 'patch', check_status: 'ok', check_error: null,
            }],
            summary: {
              has_update: true, primary_image: 'nginx:1', current_tag: '1', next_tag: '2',
              semver_bump: 'patch', update_kind: 'digest', blocked: false, blocked_reason: null,
              check_status: 'ok', verification_failed: false, verification_error: null,
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

  it('drops a sticky cleared preview from the card grid without an advisory', async () => {
    // Sticky fleet still lists the stack, but a successful fresh preview proves
    // no update/rebuild. The false pending card must disappear.
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
              has_update: false, semver_bump: 'none', check_status: 'ok', check_error: null,
            }],
            summary: {
              has_update: false, primary_image: 'redis:8.8.0', current_tag: '8.8.0', next_tag: '8.8.0',
              semver_bump: 'none', update_kind: 'none', blocked: false, blocked_reason: null,
              rebuild_available: false, check_status: 'ok', verification_failed: false, verification_error: null,
            },
            rollback_target: null, changelog: null,
          }),
        });
      }
      return Promise.resolve({ ok: true, json: async () => null });
    });

    render(<AutoUpdateReadinessView />);

    expect(await screen.findByText(/Everything is up to date/)).toBeInTheDocument();
    expect(screen.getByText(/All stacks on current builds/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Apply now/i })).toBeNull();
    expect(screen.queryByText(/could not be checked/i)).toBeNull();
    expect(screen.queryByText(/ready to apply automatically/)).toBeNull();
  });

  it('keeps a tag-only advisory card on load instead of treating it as cleared', async () => {
    mockedFetch.mockImplementation((url: string) => {
      if (url === '/image-updates/fleet') {
        return Promise.resolve({ ok: true, json: async () => ({ '1': { nginx: true } }) });
      }
      if (url.startsWith('/scheduled-tasks')) {
        return Promise.resolve({ ok: true, json: async () => [] });
      }
      if (url === '/image-updates/detail') {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            nginx: { hasUpdate: true, checkStatus: 'ok', lastError: null, checkedAt: 1 },
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
            stack_name: 'nginx',
            images: [{
              service: 'web',
              image: 'nginx:1.25.3',
              current_tag: '1.25.3',
              next_tag: '1.31.3',
              has_update: true,
              digest_update: false,
              tag_update: true,
              semver_bump: 'minor',
              check_status: 'ok',
              check_error: null,
              digest_error: null,
            }],
            summary: {
              has_update: true,
              primary_image: 'nginx',
              current_tag: '1.25.3',
              next_tag: '1.31.3',
              semver_bump: 'minor',
              update_kind: 'tag',
              blocked: false,
              blocked_reason: null,
              rebuild_available: false,
              check_status: 'ok',
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

    expect(await screen.findByText(/1 update pending/)).toBeInTheDocument();
    expect(screen.getAllByText('nginx').length).toBeGreaterThan(0);
    expect(screen.queryByText(/Everything is up to date/)).toBeNull();
    expect(screen.getByRole('button', { name: /Apply now/i })).toBeDisabled();
  });

  it('keeps a sticky card instead of silently clearing it when a remote sends a legacy preview missing verification_failed entirely', async () => {
    // Same sticky-fleet shape as the cleared-preview test above, but the
    // fresh preview response is missing verification_failed/rebuild_available
    // entirely (an older remote node's shape), so it must not be trusted as
    // proof the stack is clean.
    mockedFetch.mockImplementation((url: string) => {
      if (url === '/image-updates/fleet') {
        return Promise.resolve({ ok: true, json: async () => ({ '1': { redis: true } }) });
      }
      if (url.startsWith('/scheduled-tasks')) {
        return Promise.resolve({ ok: true, json: async () => [] });
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
            images: [],
            summary: {
              has_update: false, primary_image: 'redis:8.8.0', current_tag: '8.8.0', next_tag: '8.8.0',
              semver_bump: 'none', update_kind: 'none', blocked: false, blocked_reason: null,
              // verification_failed and rebuild_available intentionally omitted (legacy remote shape).
            },
            rollback_target: null, changelog: null,
          }),
        });
      }
      return Promise.resolve({ ok: true, json: async () => null });
    });

    render(<AutoUpdateReadinessView />);

    // Both the retained card and the advisory line name the stack.
    expect(await screen.findAllByText('redis')).toHaveLength(2);
    expect(screen.queryByText(/Everything is up to date/)).toBeNull();
    // The retained card alone doesn't explain itself; the advisory must.
    expect(screen.getByText(/predates digest verification/i)).toBeInTheDocument();
  });

  it('does not pair a legacy preview\'s own confirmed update with a contradictory "could not be checked" advisory', async () => {
    // The remote DID check and confirmed an update via its own (older) logic;
    // flagging it as unchecked right next to an enabled Apply button would
    // contradict the card sitting beside it.
    mockedFetch.mockImplementation((url: string) => {
      if (url === '/image-updates/fleet') {
        return Promise.resolve({ ok: true, json: async () => ({ '1': { redis: true } }) });
      }
      if (url.startsWith('/scheduled-tasks')) {
        return Promise.resolve({ ok: true, json: async () => [] });
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
            images: [],
            summary: {
              has_update: true, primary_image: 'redis:8.8.0', current_tag: '8.8.0', next_tag: '8.8.1',
              semver_bump: 'patch', update_kind: 'digest', blocked: false, blocked_reason: null,
              // check_status, verification_failed, and rebuild_available intentionally omitted (legacy remote shape).
            },
            rollback_target: null, changelog: null,
          }),
        });
      }
      return Promise.resolve({ ok: true, json: async () => null });
    });

    render(<AutoUpdateReadinessView />);

    expect(await screen.findByRole('button', { name: /Apply now/i })).toBeEnabled();
    expect(screen.queryByText(/predates digest verification/i)).toBeNull();
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

describe('isAuthoritativeNegativePreview (Fleet card drop parity)', () => {
  it('drops when a checkable image has ok + no update', () => {
    expect(isAuthoritativeNegativePreview({
      images: [{ check_status: 'ok' }],
      summary: { has_update: false, check_status: 'ok' },
    })).toBe(true);
  });

  it('retains not_checkable-only negative previews', () => {
    expect(isAuthoritativeNegativePreview({
      images: [{ check_status: 'not_checkable' }],
      summary: { has_update: false, check_status: 'ok' },
    })).toBe(false);
  });

  it('clears when every image is ok even if summary check_status is omitted', () => {
    expect(isAuthoritativeNegativePreview({
      images: [{ check_status: 'ok' }],
      summary: { has_update: false },
    })).toBe(true);
  });

  it('retains when image check_status is missing', () => {
    expect(isAuthoritativeNegativePreview({
      images: [{}],
      summary: { has_update: false, check_status: 'ok' },
    })).toBe(false);
  });

  it('retains empty image lists even with ok summary', () => {
    expect(isAuthoritativeNegativePreview({
      images: [],
      summary: { has_update: false, check_status: 'ok' },
    })).toBe(false);
  });
});
