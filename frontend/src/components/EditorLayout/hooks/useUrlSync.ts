import { useEffect, useRef, useCallback, useState, type MutableRefObject } from 'react';
import type { Node } from '@/context/NodeContext';
import type { FleetTab, SecurityTab } from '@/lib/events';
import type { SectionId } from '@/components/settings/types';
import type { ActiveView, EditorTab, MobileRouteSurface, RouteStackLoadResult } from '@/lib/router/routeTypes';
import { buildPath, parsePath } from '@/lib/router/senchoRoute';
import { envFileForRouteUrl, resolveEnvRouteTarget } from '@/lib/router/envRoute';
import { nodeIdToSlug, slugToNodeId } from '@/lib/nodeSlug';
import {
  authzReady,
  isFleetTabHidden,
  isSettingsSectionHidden,
  isViewHidden,
  normalizeHiddenView,
  type ReachabilityContext,
} from '@/lib/routing/reachability';
import type { StacksLoadStatus } from './useStackListState';

type RoutePhase = 'initial' | 'applying' | 'settled' | 'frozen';
type RouteIntent = 'push' | 'replace' | 'none';

interface HistoryState {
  senchoIdx?: number;
}

interface PendingRoute {
  view: ActiveView;
  stackName: string | null;
  /** Null = stack detail (anatomy); set = Monaco tab surface. */
  editorTab: EditorTab | null;
  envFile: string | null;
  securityTab: SecurityTab;
  fleetTab: FleetTab;
  settingsSection: SectionId | null;
  filterNodeId: number | null;
  isStackList: boolean;
}

export interface UseUrlSyncOptions {
  nodes: Node[];
  nodesLoaded: boolean;
  activeNode: Node | null;
  setActiveNode: (node: Node) => void;
  activeView: ActiveView;
  setActiveView: (view: ActiveView) => void;
  settingsSection: SectionId;
  setSettingsSection: (section: SectionId) => void;
  securityTab: SecurityTab;
  setSecurityTab: (tab: SecurityTab) => void;
  fleetActiveTab: FleetTab;
  setFleetActiveTab: (tab: FleetTab) => void;
  filterNodeId: number | null;
  setFilterNodeId: (id: number | null) => void;
  selectedFile: string | null;
  files: string[];
  filesNodeId: number | null;
  stacksLoadStatus: StacksLoadStatus;
  stacksLoadNodeId: number | null;
  isFileLoading: boolean;
  activeTab: EditorTab;
  setActiveTab: (tab: EditorTab) => void;
  editingCompose: boolean;
  setEditingCompose: (editing: boolean) => void;
  selectedEnvFile: string;
  envFiles: string[];
  loadFileForRoute: (filename: string) => Promise<RouteStackLoadResult>;
  changeEnvFile: (file: string) => Promise<void>;
  applyEditorRouteState: (tab: EditorTab) => void;
  refreshStacks: (background?: boolean) => Promise<string[]>;
  reachCtx: ReachabilityContext;
  isMobile: boolean;
  mobileSurface: MobileRouteSurface | null;
  setMobileSurface: (surface: MobileRouteSurface) => void;
  mobileSettingsSection: SectionId | null;
  setMobileSettingsSection: (section: SectionId | null) => void;
  setPendingDetailStack: (stack: string | null) => void;
  attemptPopstateNavigation: (apply: () => void, onCancel: () => void) => void;
}

function currentPath(): string {
  return window.location.pathname + window.location.search;
}

function readIdx(state: unknown): number | null {
  if (state && typeof state === 'object' && 'senchoIdx' in state) {
    const v = (state as HistoryState).senchoIdx;
    return typeof v === 'number' ? v : null;
  }
  return null;
}

function pendingNodeMatchesActive(pendingNodeId: number | null, activeNodeId: number | undefined): boolean {
  return pendingNodeId == null || activeNodeId === pendingNodeId;
}

interface PendingEditorRouteOpts {
  envFiles: string[];
  inventoryReady: boolean;
}

async function applyPendingEditorRoute(
  optsRef: MutableRefObject<UseUrlSyncOptions>,
  pendingEnvRef: MutableRefObject<string | null>,
  tab: EditorTab | null,
  routeOpts?: PendingEditorRouteOpts,
): Promise<boolean> {
  const live = optsRef.current;
  // Tabless stack URL → detail (anatomy). Do not open Monaco.
  if (tab == null) {
    pendingEnvRef.current = null;
    live.setEditingCompose(false);
    live.setActiveTab('compose');
    return true;
  }
  if (tab !== 'env') {
    pendingEnvRef.current = null;
    live.setActiveTab(tab);
    live.applyEditorRouteState(tab);
    return true;
  }
  const envFiles = routeOpts?.envFiles ?? live.envFiles;
  const inventoryReady = routeOpts?.inventoryReady
    ?? (!live.isFileLoading && live.selectedFile != null);
  const stackLoading = live.isFileLoading && routeOpts?.envFiles == null;
  const outcome = resolveEnvRouteTarget(
    pendingEnvRef.current,
    envFiles,
    stackLoading,
    inventoryReady,
  );
  if (!outcome.ready) return false;
  pendingEnvRef.current = null;
  let effectiveTab: EditorTab = tab;
  if (outcome.target == null && envFiles.length === 0) {
    // Empty env inventory: stay on Monaco compose tab rather than detail.
    effectiveTab = 'compose';
  } else if (outcome.target && outcome.target !== live.selectedEnvFile) {
    await live.changeEnvFile(outcome.target);
  }
  live.setActiveTab(effectiveTab);
  live.applyEditorRouteState(effectiveTab);
  return true;
}

export function useUrlSync(options: UseUrlSyncOptions) {
  const optsRef = useRef(options);
  optsRef.current = options;

  const [routeDetailError, setRouteDetailError] = useState<string | null>(null);
  const [urlHydratingStack, setUrlHydratingStack] = useState<string | null>(null);

  const phaseRef = useRef<RoutePhase>('initial');
  const historyIdxRef = useRef(0);
  const suppressNextPopstateRef = useRef(false);
  const pendingRouteRef = useRef<PendingRoute | null>(null);
  const pendingStackRef = useRef<string | null>(null);
  const pendingEnvRef = useRef<string | null>(null);
  const pendingTabRef = useRef<EditorTab | null>(null);
  const initialHydratedRef = useRef(false);
  const routeReplaceRef = useRef(false);
  const appliedViewRef = useRef<ActiveView | null>(null);
  const pendingNodeIdRef = useRef<number | null>(null);
  const resolvingRef = useRef(false);

  const writeHistory = useCallback((path: string, intent: RouteIntent) => {
    const prev = window.history.state as HistoryState | null;
    const base: HistoryState = prev && typeof prev === 'object' ? { ...prev } : {};
    if (intent === 'push') {
      historyIdxRef.current += 1;
      base.senchoIdx = historyIdxRef.current;
      window.history.pushState(base, '', path);
    } else {
      base.senchoIdx = historyIdxRef.current;
      window.history.replaceState(base, '', path);
    }
  }, []);

  const buildCurrentPath = useCallback(() => {
    const o = optsRef.current;
    const slug = o.activeNode ? nodeIdToSlug(o.activeNode.id, o.nodes) : null;
    if (!slug) return null;
    const view = authzReady(o.reachCtx) ? normalizeHiddenView(o.activeView, o.reachCtx) : o.activeView;
    let mobileSurface: MobileRouteSurface | null = o.mobileSurface;
    if (!o.isMobile) mobileSurface = null;
    return buildPath({
      nodeSlug: slug,
      activeView: view,
      stackName: o.selectedFile,
      editorTab: o.editingCompose ? o.activeTab : null,
      envFile: envFileForRouteUrl(o.selectedEnvFile, o.envFiles, o.activeTab),
      securityTab: o.securityTab,
      fleetActiveTab: o.fleetActiveTab,
      settingsSection: o.isMobile ? o.mobileSettingsSection : o.settingsSection,
      filterNodeId: o.filterNodeId,
      mobileSurface,
      isMobile: o.isMobile,
    });
  }, []);

  const applyPendingRoute = useCallback(async () => {
    const o = optsRef.current;
    const pending = pendingRouteRef.current;
    if (!pending) return;
    if (!pendingNodeMatchesActive(pendingNodeIdRef.current, o.activeNode?.id)) return;

    let view = pending.view;
    if (authzReady(o.reachCtx)) {
      view = normalizeHiddenView(view, o.reachCtx);
    }

    if (pending.isStackList && o.isMobile) {
      o.setMobileSurface('list');
      o.setActiveView('dashboard');
    } else {
      o.setActiveView(view);
      if (o.isMobile && view !== 'editor') {
        o.setMobileSurface('content');
      }
    }

    if (pending.securityTab) o.setSecurityTab(pending.securityTab);
    if (pending.fleetTab) o.setFleetActiveTab(pending.fleetTab);
    if (pending.settingsSection) {
      if (o.isMobile) o.setMobileSettingsSection(pending.settingsSection);
      else o.setSettingsSection(pending.settingsSection);
    }
    if (pending.filterNodeId != null) o.setFilterNodeId(pending.filterNodeId);

    if (pending.stackName) {
      pendingStackRef.current = pending.stackName;
      pendingEnvRef.current = pending.envFile;
      pendingTabRef.current = pending.editorTab;
      setUrlHydratingStack(pending.stackName);
      if (o.isMobile) {
        o.setPendingDetailStack(pending.stackName);
      }
    } else {
      setUrlHydratingStack(null);
      setRouteDetailError(null);
      pendingRouteRef.current = null;
      const nodeReady = pendingNodeIdRef.current == null || o.activeNode?.id === pendingNodeIdRef.current;
      if (o.activeView === view && nodeReady) {
        pendingNodeIdRef.current = null;
        appliedViewRef.current = null;
        phaseRef.current = 'settled';
      } else {
        appliedViewRef.current = view;
        phaseRef.current = 'applying';
      }
    }
  }, []);

  const resolvePendingStack = useCallback(async () => {
    if (resolvingRef.current) return;
    const o = optsRef.current;
    const stack = pendingStackRef.current;
    if (!stack || !o.activeNode) return;
    if (!pendingNodeMatchesActive(pendingNodeIdRef.current, o.activeNode.id)) return;
    if (o.filesNodeId !== o.activeNode.id) return;

    if (o.stacksLoadStatus === 'loading' || o.stacksLoadStatus === 'idle') return;

    if (o.stacksLoadStatus === 'error' && o.stacksLoadNodeId === o.activeNode.id) {
      phaseRef.current = 'frozen';
      pendingRouteRef.current = null;
      return;
    }

    const match = o.files.find(f => f === stack)
      ?? o.files.find(f => f.toLowerCase() === stack.toLowerCase());
    if (!match) {
      routeReplaceRef.current = true;
      pendingStackRef.current = null;
      pendingRouteRef.current = null;
      setUrlHydratingStack(null);
      setRouteDetailError(null);
      if (o.isMobile) o.setPendingDetailStack(null);
      o.setActiveView('dashboard');
      phaseRef.current = 'settled';
      return;
    }

    // If the file is already loaded, apply route state without reloading
    // to avoid unmounting the editor (loadFileCore clears selectedFile on
    // failure, which would hide the recovery chip during a deploy).
    if (o.selectedFile === match) {
      const tab = pendingTabRef.current;
      const applied = await applyPendingEditorRoute(optsRef, pendingEnvRef, tab, {
        envFiles: o.envFiles,
        inventoryReady: !o.isFileLoading,
      });
      if (!applied) return;
      pendingStackRef.current = null;
      pendingTabRef.current = null;
      pendingRouteRef.current = null;
      setUrlHydratingStack(null);
      setRouteDetailError(null);
      pendingNodeIdRef.current = null;
      phaseRef.current = 'settled';
      return;
    }

    resolvingRef.current = true;
    const attempted = match;
    const loadResult = await o.loadFileForRoute(match);
    if (pendingStackRef.current !== attempted) { resolvingRef.current = false; return; }

    if (!loadResult.ok) {
      phaseRef.current = 'frozen';
      pendingRouteRef.current = null;
      setRouteDetailError(`Could not open "${attempted.replace(/\.(ya?ml)$/, '')}". Check your connection and try again.`);
      resolvingRef.current = false;
      return;
    }

    const tab = pendingTabRef.current;
    const applied = await applyPendingEditorRoute(optsRef, pendingEnvRef, tab, {
      envFiles: loadResult.envFiles,
      inventoryReady: true,
    });
    if (!applied) {
      resolvingRef.current = false;
      return;
    }

    pendingStackRef.current = null;
    pendingTabRef.current = null;
    pendingRouteRef.current = null;
    setUrlHydratingStack(null);
    setRouteDetailError(null);
    pendingNodeIdRef.current = null;
    phaseRef.current = 'settled';
    resolvingRef.current = false;
  }, []);

  const hydrateFromUrl = useCallback((pathname: string, search: string) => {
    const o = optsRef.current;
    if (!o.nodesLoaded || o.nodes.length === 0) return;

    const parsed = parsePath(pathname, search);
    if (!parsed.nodeSlug) {
      const slug = o.activeNode ? nodeIdToSlug(o.activeNode.id, o.nodes) : null;
      if (slug) {
        routeReplaceRef.current = true;
        writeHistory(`/nodes/${slug}/dashboard`, 'replace');
      }
      phaseRef.current = 'settled';
      return;
    }

    const nodeId = slugToNodeId(parsed.nodeSlug, o.nodes);
    if (nodeId == null) {
      const fallback = o.activeNode ?? o.nodes[0];
      if (fallback) {
        routeReplaceRef.current = true;
        const slug = nodeIdToSlug(fallback.id, o.nodes);
        if (slug) writeHistory(`/nodes/${slug}/dashboard`, 'replace');
      }
      phaseRef.current = 'settled';
      return;
    }

    const node = o.nodes.find(n => n.id === nodeId);
    if (!node) return;

    if (parsed.nodeSlug && parsed.view == null && !parsed.isStackList) {
      routeReplaceRef.current = true;
      const slug = nodeIdToSlug(node.id, o.nodes);
      if (slug) writeHistory(`/nodes/${slug}/dashboard`, 'replace');
      phaseRef.current = 'settled';
      if (o.activeView !== 'dashboard') o.setActiveView('dashboard');
      return;
    }

    let view = parsed.view ?? 'dashboard';
    let fleetTab = parsed.fleetTab ?? 'overview';
    if (parsed.fleetTab && isFleetTabHidden(parsed.fleetTab, o.reachCtx)) {
      fleetTab = 'overview';
      routeReplaceRef.current = true;
    }
    let settingsSection = parsed.settingsSection as SectionId | null;
    if (settingsSection && isSettingsSectionHidden(settingsSection, o.reachCtx)) {
      settingsSection = null;
      routeReplaceRef.current = true;
    }
    if (view && isViewHidden(view, o.reachCtx)) {
      view = 'dashboard';
      routeReplaceRef.current = true;
    }
    if (o.isMobile && view === 'fleet' && parsed.fleetTab && parsed.fleetTab !== 'overview') {
      fleetTab = 'overview';
      routeReplaceRef.current = true;
    }

    pendingRouteRef.current = {
      view,
      stackName: parsed.stackName,
      editorTab: parsed.editorTab,
      envFile: parsed.envFile,
      securityTab: parsed.securityTab ?? 'overview',
      fleetTab,
      settingsSection,
      filterNodeId: parsed.filterNodeId,
      isStackList: parsed.isStackList,
    };

    phaseRef.current = 'applying';
    if (o.activeNode?.id !== node.id) {
      pendingNodeIdRef.current = node.id;
      routeReplaceRef.current = true;
      o.setActiveNode(node);
    } else {
      pendingNodeIdRef.current = null;
      void applyPendingRoute();
    }
  }, [applyPendingRoute, writeHistory]);

  useEffect(() => {
    const base: HistoryState = readIdx(window.history.state) != null
      ? (window.history.state as HistoryState)
      : { senchoIdx: 0 };
    if (readIdx(base) == null) {
      base.senchoIdx = 0;
      window.history.replaceState(base, '', window.location.pathname + window.location.search);
    }
    historyIdxRef.current = base.senchoIdx ?? 0;
  }, []);

  useEffect(() => {
    if (!options.nodesLoaded || options.nodes.length === 0) return;
    if (initialHydratedRef.current) return;
    initialHydratedRef.current = true;
    hydrateFromUrl(window.location.pathname, window.location.search);
  }, [hydrateFromUrl, options.nodesLoaded, options.nodes.length]);

  useEffect(() => {
    if (!pendingRouteRef.current || !optsRef.current.activeNode) return;
    if (!pendingNodeMatchesActive(pendingNodeIdRef.current, optsRef.current.activeNode.id)) return;
    void applyPendingRoute();
  }, [applyPendingRoute, options.activeNode?.id]);

  useEffect(() => {
    void resolvePendingStack();
  }, [
    resolvePendingStack,
    options.files,
    options.filesNodeId,
    options.stacksLoadStatus,
    options.stacksLoadNodeId,
    options.selectedFile,
    options.isFileLoading,
    options.envFiles,
    urlHydratingStack,
  ]);

  useEffect(() => {
    if (phaseRef.current !== 'applying') return;
    if (pendingStackRef.current) return;
    if (pendingNodeIdRef.current != null && options.activeNode?.id !== pendingNodeIdRef.current) return;
    const applied = appliedViewRef.current;
    if (applied == null) return;
    if (options.activeView !== applied) return;
    appliedViewRef.current = null;
    pendingNodeIdRef.current = null;
    phaseRef.current = 'settled';
  }, [options.activeView, options.activeNode?.id]);

  useEffect(() => {
    if (phaseRef.current !== 'settled') return;
    if (options.isFileLoading) return;
    if (pendingStackRef.current) return;
    if (pendingNodeIdRef.current != null && options.activeNode?.id !== pendingNodeIdRef.current) return;
    if (options.activeView === 'editor' && !options.selectedFile) return;

    const target = buildCurrentPath();
    if (!target || target === currentPath()) return;

    const intent: RouteIntent = routeReplaceRef.current ? 'replace' : 'push';
    routeReplaceRef.current = false;
    writeHistory(target, intent);
  }, [
    buildCurrentPath,
    writeHistory,
    options.activeView,
    options.selectedFile,
    options.activeTab,
    options.editingCompose,
    options.selectedEnvFile,
    options.envFiles,
    options.securityTab,
    options.fleetActiveTab,
    options.settingsSection,
    options.filterNodeId,
    options.activeNode?.id,
    options.isMobile,
    options.mobileSurface,
    options.mobileSettingsSection,
    options.isFileLoading,
    options.reachCtx,
  ]);

  useEffect(() => {
    const onPopstate = (event: PopStateEvent) => {
      if (suppressNextPopstateRef.current) {
        suppressNextPopstateRef.current = false;
        return;
      }

      const newIdx = readIdx(event.state) ?? readIdx(window.history.state);
      const oldIdx = historyIdxRef.current;
      const delta = newIdx != null ? newIdx - oldIdx : -1;
      if (newIdx != null) historyIdxRef.current = newIdx;

      const apply = () => {
        phaseRef.current = 'applying';
        hydrateFromUrl(window.location.pathname, window.location.search);
      };

      const cancel = () => {
        if (delta === 0) return;
        suppressNextPopstateRef.current = true;
        window.history.go(-delta);
      };

      optsRef.current.attemptPopstateNavigation(apply, cancel);
    };

    window.addEventListener('popstate', onPopstate);
    return () => window.removeEventListener('popstate', onPopstate);
  }, [hydrateFromUrl]);

  const prevIsMobileRef = useRef(options.isMobile);
  useEffect(() => {
    if (prevIsMobileRef.current !== options.isMobile) {
      prevIsMobileRef.current = options.isMobile;
      routeReplaceRef.current = true;
    }
  }, [options.isMobile]);

  const retryFrozenRoute = useCallback(() => {
    setRouteDetailError(null);
    phaseRef.current = 'applying';
    void optsRef.current.refreshStacks(false).then(() => {
      void resolvePendingStack();
    });
  }, [resolvePendingStack]);

  return { retryFrozenRoute, urlHydratingStack, routeDetailError };
}
