import { useEffect, useRef, useCallback } from 'react';
import type { Node } from '@/context/NodeContext';
import type { FleetTab, SecurityTab } from '@/lib/events';
import type { SectionId } from '@/components/settings/types';
import type { ActiveView, EditorTab, MobileRouteSurface } from '@/lib/router/routeTypes';
import { buildPath, parsePath } from '@/lib/router/senchoRoute';
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
  editorTab: EditorTab;
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
  selectedEnvFile: string;
  envFiles: string[];
  loadFile: (filename: string) => Promise<void>;
  changeEnvFile: (file: string) => Promise<void>;
  refreshStacks: (background?: boolean) => Promise<string[]>;
  reachCtx: ReachabilityContext;
  isMobile: boolean;
  mobileSurface: MobileRouteSurface | null;
  setMobileSurface: (surface: MobileRouteSurface) => void;
  mobileSettingsSection: SectionId | null;
  setMobileSettingsSection: (section: SectionId | null) => void;
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

export function useUrlSync(options: UseUrlSyncOptions) {
  const optsRef = useRef(options);
  optsRef.current = options;

  const phaseRef = useRef<RoutePhase>('initial');
  const historyIdxRef = useRef(0);
  const suppressNextPopstateRef = useRef(false);
  const pendingRouteRef = useRef<PendingRoute | null>(null);
  const pendingStackRef = useRef<string | null>(null);
  const pendingEnvRef = useRef<string | null>(null);
  const pendingTabRef = useRef<EditorTab | null>(null);
  const initialHydratedRef = useRef(false);
  const routeReplaceRef = useRef(false);

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
      editorTab: o.activeTab,
      envFile: o.selectedEnvFile || null,
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
    } else {
      pendingRouteRef.current = null;
      phaseRef.current = 'settled';
    }
  }, []);

  const resolvePendingStack = useCallback(async () => {
    const o = optsRef.current;
    const stack = pendingStackRef.current;
    if (!stack || !o.activeNode) return;
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
      o.setActiveView('dashboard');
      phaseRef.current = 'settled';
      return;
    }

    await o.loadFile(match);

    const env = pendingEnvRef.current;
    const tab = pendingTabRef.current ?? 'compose';
    if (env && o.envFiles.includes(env) && env !== o.envFiles[0]) {
      await o.changeEnvFile(env);
    }
    o.setActiveTab(tab);

    pendingStackRef.current = null;
    pendingEnvRef.current = null;
    pendingTabRef.current = null;
    pendingRouteRef.current = null;
    phaseRef.current = 'settled';
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
      editorTab: parsed.editorTab ?? 'compose',
      envFile: parsed.envFile,
      securityTab: parsed.securityTab ?? 'overview',
      fleetTab,
      settingsSection,
      filterNodeId: parsed.filterNodeId,
      isStackList: parsed.isStackList,
    };

    phaseRef.current = 'applying';
    if (o.activeNode?.id !== node.id) {
      o.setActiveNode(node);
    } else {
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
    if (pendingRouteRef.current && optsRef.current.activeNode) {
      void applyPendingRoute();
    }
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
  ]);

  useEffect(() => {
    if (phaseRef.current !== 'settled') return;
    if (options.isFileLoading) return;
    if (pendingStackRef.current) return;
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
    options.selectedEnvFile,
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
    phaseRef.current = 'applying';
    void optsRef.current.refreshStacks(false).then(() => {
      void resolvePendingStack();
    });
  }, [resolvePendingStack]);

  return { retryFrozenRoute };
}
