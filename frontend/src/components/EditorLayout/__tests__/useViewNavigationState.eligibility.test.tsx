/**
 * Readiness bridge at the producer level: useViewNavigationState publishes
 * settled quick-link eligibility into the module store with ownership captured
 * from its authorization snapshot. Covers: publish on settle, nothing before
 * settle, a superseded producer's publication masked after an identity bump,
 * and teardown scoped to ownership (a superseded producer's unmount cannot
 * erase a newer account's publication).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import * as AuthContext from '@/context/AuthContext';
import * as LicenseContext from '@/context/LicenseContext';
import * as NodeContext from '@/context/NodeContext';
import { useViewNavigationState } from '../hooks/useViewNavigationState';
import {
  bumpGeneration,
  clearEligibility,
  currentGeneration,
  getSettledEligibility,
} from '@/lib/preferences/preferenceEvents';
import { setCurrentSyncUser } from '@/lib/preferences/syncBus';

vi.mock('@/context/AuthContext');
vi.mock('@/context/LicenseContext');
vi.mock('@/context/NodeContext');

const useExperimentalMock = vi.fn(() => ({ experimental: true, experimentalReady: true }));
vi.mock('@/hooks/useExperimental', () => ({
  useExperimental: () => useExperimentalMock(),
}));

interface AuthMock {
  userId: number;
  isAdmin: boolean;
  can: (p: string) => boolean;
  permissionsStatus: 'ready' | 'loading' | 'error';
}

function mockAuth(m: AuthMock) {
  vi.mocked(AuthContext.useAuth).mockReturnValue({
    isAdmin: m.isAdmin,
    can: m.can,
    permissionsStatus: m.permissionsStatus,
    user: { userId: m.userId },
  } as unknown as ReturnType<typeof AuthContext.useAuth>);
}

function mockActiveNode(type: 'local' | 'remote' | null) {
  vi.mocked(NodeContext.useNodes).mockReturnValue({
    activeNode: type === null ? null : { type, id: 1, name: 'n' },
  } as unknown as ReturnType<typeof NodeContext.useNodes>);
}

function mockLicense(isPaid: boolean, licenseStatus: 'ready' | 'loading' | 'error' = 'ready') {
  vi.mocked(LicenseContext.useLicense).mockReturnValue({
    isPaid,
    licenseStatus,
  } as unknown as ReturnType<typeof LicenseContext.useLicense>);
}

const ADMIN_CAN = (p: string) =>
  p === 'system:audit' || p === 'system:console' || p === 'node:read' || p === 'stack:deploy' || p === 'node:manage';
const VIEWER_CAN = (p: string) => p === 'node:read';

const ADMIN_ELIGIBILITY = ['dashboard', 'fleet', 'resources', 'security', 'auto-updates', 'scheduled-ops'];
const VIEWER_ELIGIBILITY = ['dashboard', 'fleet', 'resources', 'security'];

describe('useViewNavigationState eligibility publication (readiness bridge)', () => {
  beforeEach(() => {
    mockActiveNode('local');
    useExperimentalMock.mockReturnValue({ experimental: true, experimentalReady: true });
  });

  afterEach(() => {
    const pub = getSettledEligibility();
    if (pub) clearEligibility(pub.ownership);
  });

  it('publishes settled eligibility with ownership captured from the producing snapshot', () => {
    const generation = currentGeneration();
    mockAuth({ userId: 5, isAdmin: true, can: ADMIN_CAN, permissionsStatus: 'ready' });
    mockLicense(true);
    setCurrentSyncUser(5);
    const { result } = renderHook(() => useViewNavigationState());

    expect(result.current.defaultQuickLinkEligibility).toEqual(ADMIN_ELIGIBILITY);
    const pub = getSettledEligibility();
    expect(pub?.eligibleIds).toEqual(ADMIN_ELIGIBILITY);
    // Ownership binds the publication to the account and generation whose
    // authorization snapshot produced it, not to whoever reads it later.
    expect(pub?.ownership).toEqual({ userId: 5, generation });
  });

  it('publishes nothing while permissions are still loading', () => {
    mockAuth({ userId: 5, isAdmin: true, can: ADMIN_CAN, permissionsStatus: 'loading' });
    mockLicense(true);
    setCurrentSyncUser(5);
    renderHook(() => useViewNavigationState());
    expect(getSettledEligibility()).toBeNull();
  });

  it('a superseded producer is masked after an identity bump and its teardown cannot erase the new publication', () => {
    // Producer A (account 5) settles first.
    mockAuth({ userId: 5, isAdmin: true, can: ADMIN_CAN, permissionsStatus: 'ready' });
    mockLicense(true);
    setCurrentSyncUser(5);
    const producerA = renderHook(() => useViewNavigationState());
    expect(getSettledEligibility()?.ownership.userId).toBe(5);

    // Account switch: identity generation bumps. A's stored publication reads
    // null immediately, before the new account's producer has published.
    act(() => {
      bumpGeneration();
    });
    expect(getSettledEligibility()).toBeNull();

    // Producer B mounts for the new account (viewer): it captures the new
    // identity and its publication becomes the visible one. A is still
    // mounted, exactly like a stale tab's producer that has not noticed.
    mockAuth({ userId: 6, isAdmin: false, can: VIEWER_CAN, permissionsStatus: 'ready' });
    mockLicense(false);
    setCurrentSyncUser(6);
    const producerB = renderHook(() => useViewNavigationState());
    expect(getSettledEligibility()?.ownership.userId).toBe(6);
    expect(getSettledEligibility()?.eligibleIds).toEqual(VIEWER_ELIGIBILITY);

    // A unmounts late: its teardown carries A's ownership and must not erase
    // B's publication.
    producerA.unmount();
    expect(getSettledEligibility()?.ownership.userId).toBe(6);

    // B's own teardown clears B's publication.
    producerB.unmount();
    expect(getSettledEligibility()).toBeNull();
  });
});
