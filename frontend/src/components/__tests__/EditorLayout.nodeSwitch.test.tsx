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
import { apiFetch } from '@/lib/api';
import { SENCHO_OPEN_STACK_EVENT } from '@/lib/events';

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
      setPendingUnsavedLoad: (load: string | null) => void;
      dockerEndpointProtected?: {
        message: string;
        reason: string | null;
        service: string | null;
        nodeId: number | null;
        nodeName: string | null;
        nodeType: 'local' | 'remote' | null;
        stackFile: string | null;
      } | null;
    };
    stackActions: { discardAndLoadPending: () => void; cancelPendingUnsavedLoad: () => void };
  };
  viewProps?: {
    activeView: string;
    onOpenNodeNetworking: (nodeId: number) => void;
    onOpenNodeSecurity: (nodeId: number, tab: string | null) => void;
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
  ViewRouter: (p: NonNullable<Captured['viewProps']>) => { cap.viewProps = p; return <div data-testid="view">{p.activeView}</div>; },
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
  vi.clearAllMocks();
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
    // The second click is the one not followed; the first stays parked.
    expect(toast.info).toHaveBeenCalledTimes(1);
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
    expect(toast.info).toHaveBeenCalledTimes(1);
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

  // The three owners of an open unsaved-changes prompt are a parked node switch,
  // a stack load and a leave-editor navigation. A link clicked behind any of them
  // is not followed, says so, and leaves that prompt's own navigation alone.
  const NOT_FOLLOWED = /unsaved-changes prompt first.*not followed/;

  it('says so and keeps the parked switch when a node-switch prompt is already open', async () => {
    await boot();
    makeDirty();
    // The operator starts a switch to node 3 from the switcher; the dirty guard holds it.
    await act(async () => { setActiveNode(N(3)); });
    await flush();
    expect(store.activeNode.id).toBe(2);
    expect(cap.shell.overlayState.pendingUnsavedLoad).toBe('__node-switch-pending__');

    await clickSettingsLink(1);
    expect(toast.info).toHaveBeenCalledWith(expect.stringMatching(NOT_FOLLOWED));
    expect(store.activeNode.id).toBe(2);
    expect(dialogOpen()).toBe(true);

    await confirmDiscard();
    // Confirming finishes the switch the prompt was opened for, and no Policies view fires later.
    expect(store.activeNode.id).toBe(3);
    expect(view()).toMatch(/^dashboard\|overview\|/);
    await act(async () => { setActiveNode(N(1)); });
    await flush();
    expect(view()).toMatch(/^dashboard\|overview\|/);
  });

  it('says so and keeps the stashed stack load when a stack-load prompt is already open', async () => {
    await boot();
    makeDirty();
    await act(async () => { cap.shell.overlayState.setPendingUnsavedLoad('app.yml'); });
    expect(dialogOpen()).toBe(true);

    await clickSettingsLink(1);
    expect(toast.info).toHaveBeenCalledWith(expect.stringMatching(NOT_FOLLOWED));
    // The link did not take over the prompt: it still holds the stack load, not a node switch.
    expect(cap.shell.overlayState.pendingUnsavedLoad).toBe('app.yml');
    expect(cap.shell.overlayState.pendingLeaveAction).toBeNull();
    expect(store.activeNode.id).toBe(2);

    vi.mocked(apiFetch).mockClear();
    await confirmDiscard();
    // Confirming loads that stack on the node the operator is on; the link goes nowhere.
    expect(vi.mocked(apiFetch).mock.calls.some(([path]) => String(path).startsWith('/stacks/app.yml'))).toBe(true);
    expect(store.activeNode.id).toBe(2);
    expect(view()).not.toMatch(/^security\|policies\|/);
  });

  // The phone shell mounts the view router only on its content surface, so this caller is desktop-only.
  it.skipIf(isMobile)('does the same for the other node-view links, here Networking, behind a stack-load prompt', async () => {
    await boot();
    makeDirty();
    await act(async () => { cap.shell.overlayState.setPendingUnsavedLoad('app.yml'); });

    await act(async () => { cap.viewProps!.onOpenNodeNetworking(1); });
    await flush();
    expect(toast.info).toHaveBeenCalledWith(expect.stringMatching(NOT_FOLLOWED));
    expect(cap.shell.overlayState.pendingUnsavedLoad).toBe('app.yml');
    expect(store.activeNode.id).toBe(2);
  });

  // The refused link's view must not stay queued: a stale one would open Policies
  // on some later, unrelated arrival at the node. One test per prompt owner.
  it.each([
    ['a stack load', async () => { await act(async () => { cap.shell.overlayState.setPendingUnsavedLoad('app.yml'); }); }],
    ['a stashed navigation', async () => { await act(async () => { cap.shell.overlayState.setPendingLeaveAction({ run: vi.fn() }); }); }],
    ['a parked node switch', async () => { await act(async () => { setActiveNode(N(3)); }); await flush(); }],
  ])('leaves no destination queued when the link is refused behind %s', async (_owner, openPrompt) => {
    await boot();
    makeDirty();
    await openPrompt();
    await clickSettingsLink(1);
    expect(toast.info).toHaveBeenCalledWith(expect.stringMatching(NOT_FOLLOWED));
    await cancelDiscard();
    expect(dialogOpen()).toBe(false);
    makeClean();
    await act(async () => { setActiveNode(N(1)); });
    await flush();
    expect(view()).toMatch(/^dashboard\|overview\|/);
  });

  // The Security-finding link shares the queue; desktop-only like the Networking one.
  it.skipIf(isMobile)('does the same for the Security-finding link behind a stashed navigation', async () => {
    await boot();
    makeDirty();
    const otherNavigation = vi.fn();
    await act(async () => { cap.shell.overlayState.setPendingLeaveAction({ run: otherNavigation }); });
    await act(async () => { cap.viewProps!.onOpenNodeSecurity(1, 'policies'); });
    await flush();
    expect(toast.info).toHaveBeenCalledWith(expect.stringMatching(NOT_FOLLOWED));
    await confirmDiscard();
    expect(otherNavigation).toHaveBeenCalledTimes(1);
    expect(store.activeNode.id).toBe(2);
    expect(view()).not.toMatch(/^security\|/);
  });

  it('discards with a warning, as before, when the previous node was removed behind an open prompt', async () => {
    await boot();
    makeDirty();
    await act(async () => { cap.shell.overlayState.setPendingUnsavedLoad('app.yml'); });
    // Node 2 is deregistered and the node context falls back to node 1: nothing to revert to.
    store.nodes = [N(1), N(3)];
    await act(async () => { setActiveNode(N(1)); });
    await flush();
    expect(toast.warning).toHaveBeenCalledWith(expect.stringMatching(/previous node is no longer available/));
    expect(store.activeNode.id).toBe(1);
    expect(cap.editor.content).toBe(cap.editor.originalContent);
  });

  it('does not announce a dropped link when a plain switch is refused behind a prompt', async () => {
    await boot();
    makeDirty();
    await act(async () => { cap.shell.overlayState.setPendingUnsavedLoad('app.yml'); });
    await act(async () => { setActiveNode(N(3)); });
    await flush();
    expect(toast.info).not.toHaveBeenCalled();
    expect(cap.shell.overlayState.pendingUnsavedLoad).toBe('app.yml');
    expect(store.activeNode.id).toBe(2);
  });
});

describe('the Docker endpoint refusal handoff through the real shell', () => {
  const STACK = 'sencho.yml';
  const refusal = {
    message: 'Deploying "socket-proxy" would cut the Docker connection Sencho is using, so it was refused.',
    reason: 'provider' as const,
    service: 'socket-proxy',
  };

  function json(body: unknown): Response {
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  async function waitUntil(predicate: () => boolean, label: string) {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (predicate()) return;
      await flush();
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error(`timed out waiting for ${label}`);
  }

  async function openRefusal(stackName: string = STACK): Promise<string[]> {
    mobile.v = false;
    const fetched: string[] = [];
    // The same endpoints the editor uses in production: the stack list marks
    // this stack as Sencho's own, and the node reports reapply plus a
    // provider-only replacement.
    vi.mocked(apiFetch).mockImplementation(async (input: string) => {
      const path = String(input);
      fetched.push(path);
      if (path === '/stacks') return json([stackName]);
      if (path === '/stacks/statuses') return json({ [stackName]: { status: 'running', isSelf: true } });
      if (path === '/fleet/update-status') return json({ nodes: [{ nodeId: 2, canReapplyCompose: true }] });
      if (path === '/fleet/nodes/2/endpoint-provider') {
        return json({ state: 'available', service: 'socket-proxy', containerName: 'stack-socket-proxy-1', project: 'stack', providerOnly: true });
      }
      if (path === `/stacks/${stackName}`) return new Response('services:\n  socket-proxy:\n    image: linuxserver/socket-proxy\n', { status: 200 });
      return json([]);
    });
    render(<EditorLayout />);
    await flush();
    await act(async () => {
      window.dispatchEvent(new CustomEvent(SENCHO_OPEN_STACK_EVENT, {
        detail: { nodeId: 2, stackName, destination: 'editor', endpointRefusal: refusal },
      }));
    });
    await waitUntil(() => cap.shell.overlayState.dockerEndpointProtected != null, 'the endpoint refusal overlay');
    return fetched;
  }

  it('opens the preview for the refused node and stack from the shared event', async () => {
    const fetched = await openRefusal();
    expect(fetched).toContain(`/stacks/${STACK}`);
    expect(cap.shell.overlayState.dockerEndpointProtected).toEqual({
      ...refusal,
      nodeId: 2,
      nodeName: 'node-2',
      nodeType: 'remote',
      stackFile: STACK,
    });
  });

  it('loads the refused stack itself, not whatever stack was open', async () => {
    const fetched = await openRefusal('other.yml');
    const detailRequests = fetched.filter(path => path === '/stacks/other.yml');
    expect(detailRequests).toEqual(['/stacks/other.yml']);
    expect(cap.shell.overlayState.dockerEndpointProtected?.stackFile).toBe('other.yml');
  });
});
