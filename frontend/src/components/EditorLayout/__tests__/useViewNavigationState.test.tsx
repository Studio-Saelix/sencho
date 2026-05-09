import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import * as AuthContext from '@/context/AuthContext';
import * as LicenseContext from '@/context/LicenseContext';
import * as NodeContext from '@/context/NodeContext';
import { SENCHO_NAVIGATE_EVENT } from '@/components/NodeManager';
import { useViewNavigationState } from '../hooks/useViewNavigationState';

vi.mock('@/context/AuthContext');
vi.mock('@/context/LicenseContext');
vi.mock('@/context/NodeContext');

function mockActiveNode(type: 'local' | 'remote' | null) {
  vi.mocked(NodeContext.useNodes).mockReturnValue({
    activeNode: type === null ? null : { type, id: 1, name: 'n' },
  } as unknown as ReturnType<typeof NodeContext.useNodes>);
}

function mockCommunityUser() {
  vi.mocked(AuthContext.useAuth).mockReturnValue({
    isAdmin: false,
    can: () => false,
  } as unknown as ReturnType<typeof AuthContext.useAuth>);
  vi.mocked(LicenseContext.useLicense).mockReturnValue({
    isPaid: false,
    license: null,
  } as unknown as ReturnType<typeof LicenseContext.useLicense>);
}

function mockAdmiralAdmin() {
  vi.mocked(AuthContext.useAuth).mockReturnValue({
    isAdmin: true,
    can: (p: string) => p === 'system:audit',
  } as unknown as ReturnType<typeof AuthContext.useAuth>);
  vi.mocked(LicenseContext.useLicense).mockReturnValue({
    isPaid: true,
    license: { variant: 'admiral' } as ReturnType<typeof LicenseContext.useLicense>['license'],
  } as unknown as ReturnType<typeof LicenseContext.useLicense>);
}

function mockSkipperAdmin() {
  vi.mocked(AuthContext.useAuth).mockReturnValue({
    isAdmin: true,
    can: () => false,
  } as unknown as ReturnType<typeof AuthContext.useAuth>);
  vi.mocked(LicenseContext.useLicense).mockReturnValue({
    isPaid: true,
    license: { variant: 'skipper' } as ReturnType<typeof LicenseContext.useLicense>['license'],
  } as unknown as ReturnType<typeof LicenseContext.useLicense>);
}

describe('useViewNavigationState', () => {
  beforeEach(() => {
    mockCommunityUser();
    mockActiveNode('local');
  });

  // ── initial state ──────────────────────────────────────────────────────────

  it('returns default state on mount', () => {
    const { result } = renderHook(() => useViewNavigationState());
    expect(result.current.activeView).toBe('dashboard');
    expect(result.current.settingsSection).toBe('appearance');
    expect(result.current.securityHistoryOpen).toBe(false);
    expect(result.current.filterNodeId).toBeNull();
    expect(result.current.schedulePrefill).toBeNull();
    expect(result.current.mobileNavOpen).toBe(false);
  });

  // ── handleNavigate ─────────────────────────────────────────────────────────

  it('handleNavigate is a no-op when navigating to the current view', () => {
    const onNavigateToDashboard = vi.fn();
    const { result } = renderHook(() =>
      useViewNavigationState({ onNavigateToDashboard }),
    );
    act(() => result.current.handleNavigate('dashboard'));
    expect(onNavigateToDashboard).not.toHaveBeenCalled();
    expect(result.current.activeView).toBe('dashboard');
  });

  it('handleNavigate to dashboard calls onNavigateToDashboard and sets activeView', () => {
    const onNavigateToDashboard = vi.fn();
    const { result } = renderHook(() =>
      useViewNavigationState({ onNavigateToDashboard }),
    );
    // Navigate away first so dashboard→dashboard no-op guard does not fire
    act(() => result.current.handleNavigate('fleet'));
    expect(result.current.activeView).toBe('fleet');

    act(() => result.current.handleNavigate('dashboard'));
    expect(onNavigateToDashboard).toHaveBeenCalledOnce();
    expect(result.current.activeView).toBe('dashboard');
  });

  it('handleNavigate to a non-dashboard view sets activeView and clears filterNodeId', () => {
    const { result } = renderHook(() => useViewNavigationState());
    act(() => {
      window.dispatchEvent(
        new CustomEvent(SENCHO_NAVIGATE_EVENT, { detail: { view: 'fleet', nodeId: 42 } }),
      );
    });
    expect(result.current.filterNodeId).toBe(42);

    act(() => result.current.handleNavigate('resources'));
    expect(result.current.activeView).toBe('resources');
    expect(result.current.filterNodeId).toBeNull();
  });

  // ── handleOpenSettings ─────────────────────────────────────────────────────

  it('handleOpenSettings navigates to settings and clears filterNodeId', () => {
    const { result } = renderHook(() => useViewNavigationState());
    act(() => {
      window.dispatchEvent(
        new CustomEvent(SENCHO_NAVIGATE_EVENT, { detail: { view: 'fleet', nodeId: 7 } }),
      );
    });
    act(() => result.current.handleOpenSettings());
    expect(result.current.activeView).toBe('settings');
    expect(result.current.filterNodeId).toBeNull();
  });

  it('handleOpenSettings with a section updates settingsSection', () => {
    const { result } = renderHook(() => useViewNavigationState());
    act(() => result.current.handleOpenSettings('nodes'));
    expect(result.current.settingsSection).toBe('nodes');
    expect(result.current.activeView).toBe('settings');
  });

  it('handleOpenSettings without a section does not change settingsSection', () => {
    const { result } = renderHook(() => useViewNavigationState());
    act(() => result.current.handleOpenSettings('labels'));
    act(() => result.current.handleOpenSettings());
    expect(result.current.settingsSection).toBe('labels');
    expect(result.current.activeView).toBe('settings');
  });

  // ── handlePrefillConsumed ──────────────────────────────────────────────────

  it('handlePrefillConsumed clears schedulePrefill', () => {
    const { result } = renderHook(() => useViewNavigationState());
    act(() => result.current.setSchedulePrefill({ stackName: 'web.yml', nodeId: 1 }));
    expect(result.current.schedulePrefill).toEqual({ stackName: 'web.yml', nodeId: 1 });
    act(() => result.current.handlePrefillConsumed());
    expect(result.current.schedulePrefill).toBeNull();
  });

  // ── SENCHO_NAVIGATE_EVENT ──────────────────────────────────────────────────

  it('SENCHO_NAVIGATE_EVENT sets activeView and filterNodeId', () => {
    const { result } = renderHook(() => useViewNavigationState());
    act(() => {
      window.dispatchEvent(
        new CustomEvent(SENCHO_NAVIGATE_EVENT, { detail: { view: 'fleet', nodeId: 5 } }),
      );
    });
    expect(result.current.activeView).toBe('fleet');
    expect(result.current.filterNodeId).toBe(5);
  });

  it('SENCHO_NAVIGATE_EVENT with security-history opens the sheet without changing activeView', () => {
    const { result } = renderHook(() => useViewNavigationState());
    act(() => {
      window.dispatchEvent(
        new CustomEvent(SENCHO_NAVIGATE_EVENT, { detail: { view: 'security-history', nodeId: 3 } }),
      );
    });
    expect(result.current.securityHistoryOpen).toBe(true);
    expect(result.current.filterNodeId).toBe(3);
    expect(result.current.activeView).toBe('dashboard');
  });

  it('SENCHO_NAVIGATE_EVENT with no nodeId sets filterNodeId to null', () => {
    const { result } = renderHook(() => useViewNavigationState());
    act(() => {
      window.dispatchEvent(
        new CustomEvent(SENCHO_NAVIGATE_EVENT, { detail: { view: 'fleet', nodeId: 9 } }),
      );
    });
    act(() => {
      window.dispatchEvent(
        new CustomEvent(SENCHO_NAVIGATE_EVENT, { detail: { view: 'resources' } }),
      );
    });
    expect(result.current.filterNodeId).toBeNull();
  });

  it('cleans up SENCHO_NAVIGATE_EVENT listener on unmount', () => {
    const { result, unmount } = renderHook(() => useViewNavigationState());
    unmount();
    act(() => {
      window.dispatchEvent(
        new CustomEvent(SENCHO_NAVIGATE_EVENT, { detail: { view: 'fleet' } }),
      );
    });
    expect(result.current.activeView).toBe('dashboard');
  });

  // ── navItems: community user ───────────────────────────────────────────────

  it('navItems for community non-paid user contains base items only', () => {
    const { result } = renderHook(() => useViewNavigationState());
    const values = result.current.navItems.map(i => i.value);
    expect(values).toContain('dashboard');
    expect(values).toContain('fleet');
    expect(values).toContain('resources');
    expect(values).toContain('templates');
    expect(values).toContain('global-observability');
    expect(values).not.toContain('auto-updates');
    expect(values).not.toContain('host-console');
    expect(values).not.toContain('audit-log');
    expect(values).not.toContain('scheduled-ops');
  });

  // ── navItems: admiral admin ────────────────────────────────────────────────

  it('navItems for admiral paid admin contains all items', () => {
    mockAdmiralAdmin();
    const { result } = renderHook(() => useViewNavigationState());
    const values = result.current.navItems.map(i => i.value);
    expect(values).toContain('auto-updates');
    expect(values).toContain('host-console');
    expect(values).toContain('audit-log');
    expect(values).toContain('scheduled-ops');
  });

  // ── navItems: skipper admin ────────────────────────────────────────────────

  it('navItems for skipper paid admin contains auto-updates but not admiral items', () => {
    mockSkipperAdmin();
    const { result } = renderHook(() => useViewNavigationState());
    const values = result.current.navItems.map(i => i.value);
    expect(values).toContain('auto-updates');
    expect(values).not.toContain('host-console');
    expect(values).not.toContain('audit-log');
    expect(values).not.toContain('scheduled-ops');
  });

  // ── navItems: hub-only gating on remote node ───────────────────────────────

  it('hides hub-only views from the nav strip when active node is remote', () => {
    mockAdmiralAdmin();
    mockActiveNode('remote');
    const { result } = renderHook(() => useViewNavigationState());
    const values = result.current.navItems.map(i => i.value);
    expect(values).not.toContain('fleet');
    expect(values).not.toContain('scheduled-ops');
    expect(values).not.toContain('audit-log');
    expect(values).not.toContain('global-observability');
    expect(values).not.toContain('auto-updates');
    // Node-level views remain visible.
    expect(values).toContain('dashboard');
    expect(values).toContain('resources');
    expect(values).toContain('templates');
    expect(values).toContain('host-console');
  });

  it('shows hub-only views again when active node switches back to local', () => {
    mockAdmiralAdmin();
    mockActiveNode('remote');
    const { result, rerender } = renderHook(() => useViewNavigationState());
    expect(result.current.navItems.map(i => i.value)).not.toContain('fleet');

    mockActiveNode('local');
    rerender();
    const values = result.current.navItems.map(i => i.value);
    expect(values).toContain('fleet');
    expect(values).toContain('scheduled-ops');
    expect(values).toContain('audit-log');
  });

  // ── auto-redirect when on a hub-only view and node switches to remote ──────

  it('auto-redirects to dashboard when active view is hub-only and node becomes remote', () => {
    const onNavigateToDashboard = vi.fn();
    mockAdmiralAdmin();
    mockActiveNode('local');
    const { result, rerender } = renderHook(() =>
      useViewNavigationState({ onNavigateToDashboard }),
    );

    act(() => {
      window.dispatchEvent(
        new CustomEvent(SENCHO_NAVIGATE_EVENT, { detail: { view: 'fleet', nodeId: 7 } }),
      );
    });
    expect(result.current.activeView).toBe('fleet');
    expect(result.current.filterNodeId).toBe(7);

    mockActiveNode('remote');
    rerender();

    expect(result.current.activeView).toBe('dashboard');
    expect(result.current.filterNodeId).toBeNull();
    expect(onNavigateToDashboard).toHaveBeenCalledOnce();
  });

  it('does not redirect when a non-hub-only view is active and node becomes remote', () => {
    const onNavigateToDashboard = vi.fn();
    mockAdmiralAdmin();
    mockActiveNode('local');
    const { result, rerender } = renderHook(() =>
      useViewNavigationState({ onNavigateToDashboard }),
    );

    act(() => {
      window.dispatchEvent(
        new CustomEvent(SENCHO_NAVIGATE_EVENT, { detail: { view: 'resources' } }),
      );
    });
    expect(result.current.activeView).toBe('resources');

    mockActiveNode('remote');
    rerender();

    expect(result.current.activeView).toBe('resources');
    expect(onNavigateToDashboard).not.toHaveBeenCalled();
  });
});
