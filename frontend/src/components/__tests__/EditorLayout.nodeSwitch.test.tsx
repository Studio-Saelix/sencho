/**
 * The block dialog's settings link through the real shell, across a dirty-editor
 * node switch.
 *
 * Mounts the real EditorLayout with its real navigation, editor, overlay and
 * stack-action hooks, so the node-switch effect that parks a queued destination
 * behind the discard prompt is the one under test. Only what sits outside that
 * seam is stubbed: the node, auth and license contexts, the network, and the
 * heavy child views. The stubbed ShellOverlays hands the test the shell's own
 * `onOpenPolicySettings`, overlay state and stack actions, so the link and the
 * discard / cancel handlers are the production functions (the dialog component
 * itself is not rendered). The phone surface is read from the tab bar's
 * `mobileView` prop.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useSyncExternalStore } from 'react';
import { render, act, cleanup } from '@testing-library/react';
import { toast } from '@/components/ui/toast-store';

// Types are erased, so they can sit outside the hoisted block the mock factories read.
type TestNode = { id: number; name: string; type: string; is_default: boolean };
type Snapshot = { nodes: TestNode[]; activeNode: TestNode };
/** What the test reads back from the real shell; filled in as the components render. */
interface Captured {
  nav: { activeView: string; securityTab: string };
  editor: { content: string; originalContent: string; setContent: (v: string) => void };
  tab?: { mobileView: string };
  shell: {
    onOpenPolicySettings: (nodeId: number) => void;
    overlayState: {
      pendingUnsavedLoad: string | null;
      pendingLeaveAction: unknown;
      setPendingLeaveAction: (action: { run: () => void } | null) => void;
    };
    stackActions: { discardAndLoadPending: () => void; cancelPendingUnsavedLoad: () => void };
  };
  [key: string]: unknown;
}

// Shared state is hoisted: vi.mock factories run before top-level consts exist.
const { N, store, listeners, publish, setActiveNode, mobile, cap, stub } = vi.hoisted(() => {
  const N = (id: number, type = id === 1 ? 'local' : 'remote'): TestNode =>
    ({ id, name: `node-${id}`, type, is_default: id === 1 });
  const store: { nodes: TestNode[]; activeNode: TestNode; snap: Snapshot | null } =
    { nodes: [N(1), N(2), N(3)], activeNode: N(2), snap: null };
  const listeners = new Set<() => void>();
  const publish = () => {
    store.snap = { nodes: store.nodes, activeNode: store.activeNode };
    listeners.forEach((l) => l());
  };
  publish();
  // Same semantics as NodeContext.setActiveNode: state plus shared storage.
  const setActiveNode = (n: TestNode) => {
    store.activeNode = n;
    localStorage.setItem('sencho-active-node', String(n.id));
    publish();
  };
  const mobile = { v: false };
  const cap = {} as Captured;
  const stub = () => () => null;
  return { N, store, listeners, publish, setActiveNode, mobile, cap, stub };
});

vi.mock('@/context/NodeContext', () => ({
  useNodes: () => {
    const s = useSyncExternalStore(
      (l) => { listeners.add(l); return () => listeners.delete(l); },
      () => store.snap as Snapshot,
    );
    return {
      nodes: s.nodes, activeNode: s.activeNode, setActiveNode, refreshNodes: vi.fn(),
      isLoading: false, hasCapability: () => false,
      activeNodeMeta: { version: null, capabilities: [], fetchedAt: 0 },
    };
  },
}));
vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({ isAdmin: true, can: () => true, permissions: {}, permissionsStatus: 'ready' }),
}));
vi.mock('@/context/LicenseContext', () => ({
  useLicense: () => ({ isPaid: true, licenseStatus: 'active', license: null, isLoading: false, status: 'ready' }),
}));
vi.mock('@/context/DeployFeedbackContext', () => ({
  useDeployFeedback: () => ({
    runWithLog: async (_o: unknown, fn?: () => unknown) => fn?.(),
    panelState: { status: 'idle' }, logRows: [], healthGate: null,
  }),
}));
vi.mock('@/hooks/useTrivyStatus', () => ({ useTrivyStatus: () => ({ status: { available: false } }) }));
vi.mock('@/hooks/useBuildInfo', () => ({ useBuildInfo: () => ({ buildInfo: null }) }));
vi.mock('@/hooks/useDeveloperMode', () => ({ useDeveloperMode: () => false }));
vi.mock('@/hooks/use-is-mobile', () => ({ useIsMobile: () => mobile.v }));
vi.mock('@/components/ui/toast-store', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn(), loading: vi.fn(() => 'id'), dismiss: vi.fn() },
}));
vi.mock('@/lib/api', () => ({
  apiFetch: vi.fn(async () => new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } })),
  fetchForNode: vi.fn(async () => new Response('[]', { status: 200 })),
  DEPLOY_SESSION_HEADER: 'x-deploy-session-id',
  withDeploySession: (_id: string, o: object = {}) => o,
}));

// Keep the real hooks and capture what they return.
vi.mock('@/components/EditorLayout/hooks/useViewNavigationState', async (orig) => {
  const m = await orig<typeof import('@/components/EditorLayout/hooks/useViewNavigationState')>();
  return {
    ...m,
    useViewNavigationState: (...args: Parameters<typeof m.useViewNavigationState>) => {
      const s = m.useViewNavigationState(...args);
      cap.nav = s;
      return s;
    },
  };
});
vi.mock('@/components/EditorLayout/hooks/useEditorViewState', async (orig) => {
  const m = await orig<typeof import('@/components/EditorLayout/hooks/useEditorViewState')>();
  return {
    ...m,
    useEditorViewState: (...args: Parameters<typeof m.useEditorViewState>) => {
      const s = m.useEditorViewState(...args);
      cap.editor = s;
      return s;
    },
  };
});

// Heavy children are stubbed; the shell's own logic stays real.
vi.mock('@/components/UserProfileDropdown', () => ({ UserProfileDropdown: stub() }));
vi.mock('@/components/NotificationPanel', () => ({ NotificationPanel: stub() }));
vi.mock('@/components/TopBar', () => ({ TopBar: stub() }));
vi.mock('@/components/WhatsNewTrigger', () => ({ WhatsNewTrigger: stub() }));
vi.mock('@/components/WhatsNewModal', () => ({ WhatsNewModal: stub() }));
vi.mock('@/components/EditorLayout/EditorView', () => ({ EditorView: stub() }));
vi.mock('@/components/EditorLayout/CreateStackDialog', () => ({ CreateStackDialog: stub() }));
vi.mock('@/components/EditorLayout/AdoptExistingDialog', () => ({ AdoptExistingDialog: stub() }));
vi.mock('@/components/sidebar/StackSidebar', () => ({ StackSidebar: stub() }));
vi.mock('@/components/sidebar/SidebarResizePane', () => ({ SidebarResizePane: ({ children }: { children?: React.ReactNode }) => <>{children}</> }));
vi.mock('@/components/NodeSwitcher', () => ({ NodeSwitcher: stub() }));
vi.mock('@/components/MobileMoreMenu', () => ({ MobileMoreMenu: stub() }));
vi.mock('@/components/HydrationTimingPanel', () => ({ HydrationTimingPanel: stub() }));
vi.mock('@/components/mobile/MobileDashboard', () => ({ MobileDashboard: stub() }));
vi.mock('@/components/mobile/MobileFleet', () => ({ MobileFleet: stub() }));
vi.mock('@/components/mobile/MobileGitOps', () => ({ MobileGitOps: stub() }));
vi.mock('@/components/mobile/MobileSchedules', () => ({ MobileSchedules: stub() }));
vi.mock('@/components/mobile/MobileSettings', () => ({ MobileSettings: stub() }));
vi.mock('@/components/MobileTabBar', () => ({ MobileTabBar: (p: { mobileView: string }) => { cap.tab = p; return null; } }));
vi.mock('@/components/EditorLayout/ViewRouter', () => ({
  ViewRouter: (p: { activeView: string }) => { cap.viewProps = p; return <div data-testid="view">{p.activeView}</div>; },
}));
vi.mock('@/components/EditorLayout/ShellOverlays', () => ({
  ShellOverlays: (p: Captured['shell']) => { cap.shell = p; return null; },
}));

import EditorLayout from '@/components/EditorLayout';

const flush = async () => { await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const view = () =>
  `${cap.nav.activeView}|${cap.nav.securityTab}|${cap.tab ? 'surface=' + cap.tab.mobileView : 'desktop'}`;
const dialogOpen = () =>
  !!cap.shell.overlayState.pendingUnsavedLoad || !!cap.shell.overlayState.pendingLeaveAction;
const makeDirty = () => act(() => { cap.editor.setContent('changed'); });
const makeClean = () => act(() => { cap.editor.setContent(cap.editor.originalContent); });
const clickSettingsLink = async (nodeId: number) => {
  await act(async () => { cap.shell.onOpenPolicySettings(nodeId); });
  await flush();
};
const confirmDiscard = async () => { await act(async () => { cap.shell.stackActions.discardAndLoadPending(); }); await flush(); };
const cancelDiscard = async () => { await act(async () => { cap.shell.stackActions.cancelPendingUnsavedLoad(); }); await flush(); };

afterEach(() => { cleanup(); });
beforeEach(() => {
  for (const k of Object.keys(cap)) delete cap[k];
  window.history.replaceState({}, '', '/');
  sessionStorage.clear();
  localStorage.clear();
  // The operator is on node 2; the block was recorded on node 1.
  store.nodes = [N(1), N(2), N(3)];
  store.activeNode = N(2);
  publish();
  localStorage.setItem('sencho-active-node', '2');
});

describe.each([[false], [true]])('the settings link through the real shell, isMobile=%s', (isMobile) => {
  async function boot() {
    mobile.v = isMobile;
    render(<EditorLayout />);
    await flush();
  }
  const expectPolicies = (nodeId: number) => {
    expect(store.activeNode.id).toBe(nodeId);
    expect(view()).toMatch(/^security\|policies\|/);
    if (isMobile) expect(view()).toMatch(/surface=content$/);
  };

  it('confirming the discard lands on the blocked node\'s Security > Policies', async () => {
    await boot();
    makeDirty();
    await clickSettingsLink(1);
    // The switch is held, the edits are kept, and the prompt is up.
    expect(store.activeNode.id).toBe(2);
    expect(dialogOpen()).toBe(true);
    await confirmDiscard();
    expectPolicies(1);
    expect(dialogOpen()).toBe(false);
  });

  it('cancelling keeps the edits and leaves no destination to fire on a later visit', async () => {
    await boot();
    makeDirty();
    await clickSettingsLink(1);
    await cancelDiscard();
    expect(store.activeNode.id).toBe(2);
    expect(dialogOpen()).toBe(false);
    expect(cap.editor.content).toBe('changed');
    makeClean();
    await act(async () => { setActiveNode(N(1)); });
    await flush();
    expect(view()).toMatch(/^dashboard\|overview\|/);
  });

  it('keeps the first request when a second link to another node is clicked while the prompt is open', async () => {
    await boot();
    makeDirty();
    await clickSettingsLink(1);
    await clickSettingsLink(3);
    expect(store.activeNode.id).toBe(2);
    expect(dialogOpen()).toBe(true);
    await confirmDiscard();
    expectPolicies(1);
  });

  it('keeps the request when the same link is clicked twice while the prompt is open', async () => {
    await boot();
    makeDirty();
    await clickSettingsLink(1);
    await clickSettingsLink(1);
    await confirmDiscard();
    expectPolicies(1);
  });

  it('says so, and leaves the other prompt to run, when another navigation already owns the prompt', async () => {
    await boot();
    makeDirty();
    const otherNavigation = vi.fn();
    await act(async () => { cap.shell.overlayState.setPendingLeaveAction({ run: otherNavigation }); });
    await clickSettingsLink(1);
    expect(toast.info).toHaveBeenCalledWith(expect.stringMatching(/unsaved-changes prompt first/));
    await confirmDiscard();
    // Only the navigation that owned the prompt ran; the link was not followed.
    expect(otherNavigation).toHaveBeenCalledTimes(1);
    expect(store.activeNode.id).toBe(2);
    expect(view()).toMatch(/^dashboard\|/);
  });
});
