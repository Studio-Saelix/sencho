import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  LayoutDashboard, Boxes, FileWarning, KeyRound, BookCheck, EyeOff, History as HistoryIcon, Wrench, Info,
} from 'lucide-react';
import { Tabs, TabsContent, TabsList, TabsTrigger, TabsHighlight, TabsHighlightItem } from '@/components/ui/tabs';
import { PageMasthead, type MastheadTone } from '@/components/ui/PageMasthead';
import { CapabilityGate } from '@/components/CapabilityGate';
import { deriveMasthead, SCANNER_DETECTIONS_NOTE } from './security/securityMasthead';
import {
  assertReadOk,
  classifyRemoteReadError,
  classifyRemoteReadFailure,
  isNamedReadFailure,
  remoteReadFailureMessage,
  remoteReadFailureOf,
} from '@/lib/remoteReadFailure';
import { springs } from '@/lib/motion';
import { apiFetch } from '@/lib/api';
import { toast } from '@/components/ui/toast-store';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { formatTimeAgo } from '@/lib/relativeTime';
import { useAuth } from '@/context/AuthContext';
import { useNodes } from '@/context/NodeContext';
import { useImageScan } from '@/hooks/useImageScan';
import { useIsMobile } from '@/hooks/use-is-mobile';
import { useRegionData } from '@/hooks/useRegionData';
import { Masthead, type Tone } from './mobile/mobile-ui';
import { SecurityMobileTabs, type SecurityMobileTab } from './security/SecurityMobile';
import { SENCHO_SETTINGS_CHANGED, type SecurityTab, type SenchoSettingsChangedDetail } from '@/lib/events';
import type { ImageFilterValue } from '@/lib/severityStyles';
import type { SecurityOverview, ScanSummary, ScanDetailTab, SecurityRiskTrendPoint, ExploitIntelFinding, FleetRole } from '@/types/security';
import { VulnerabilityScanSheet } from './VulnerabilityScanSheet';
import { SuppressionsPanel } from './settings/SuppressionsPanel';
import { MisconfigAckPanel } from './settings/MisconfigAckPanel';
import { OverviewTab, type ChartLoadState, type OverviewLoadError } from './security/OverviewTab';
import { useSecurityReasons } from './security/useSecurityReasons';
import {
  type ImagesTargetingInput,
  type ImagesTargetingState,
} from './security/imagesTargeting';
import { ImagesTab } from './security/ImagesTab';
import { FindingsTab } from './security/FindingsTab';
import { ScanPolicyManager } from './security/ScanPolicyManager';
import { ScannerSetupTab } from './security/ScannerSetupTab';
import { HistoryTab } from './security/HistoryTab';

/** A /security/image-summaries 200 body must be a map of scan summaries. An
 *  unexpected shape is treated as an error, never as a benign "no findings". An
 *  empty object is valid (a node with no scans yet). */
function isScanSummaryMap(v: unknown): v is Record<string, ScanSummary> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  return Object.values(v).every(
    (s) =>
      !!s && typeof s === 'object'
      && typeof (s as ScanSummary).image_ref === 'string'
      && typeof (s as ScanSummary).scan_id === 'number',
  );
}

/**
 * What the overview read settled on. A 404 is a benign older node without the
 * endpoint; anything else is a real failure, carrying the cause the gateway
 * established when there is one. Both are outcomes of a completed read, not of
 * a load still in flight, so neither may read as a clean posture.
 */
type OverviewOutcome =
  | { kind: 'overview'; overview: SecurityOverview }
  | { kind: 'unsupported' }
  | { kind: 'failed'; cause: Exclude<OverviewLoadError, 'unsupported'> };

/** The overview's failure kind for a cause: a named cause keeps its own copy,
 *  anything else is the generic failure. */
function overviewFailureCause(failure: ReturnType<typeof classifyRemoteReadError>): Exclude<OverviewLoadError, 'unsupported'> {
  return isNamedReadFailure(failure) && failure !== 'unsupported' ? failure : 'failed';
}

/**
 * What one of the secondary chart reads settled on. A 404 means an older node
 * that does not serve the endpoint: the chart degrades to its empty state, the
 * same as a successful read with no rows, because the gap is permanent rather
 * than a request that might succeed on retry. A 5xx or transport error keeps
 * reading as "unavailable right now".
 */
type ChartOutcome<T> = { kind: 'data'; data: T } | { kind: 'unsupported' };

interface SecurityViewProps {
  activeTab: SecurityTab;
  onTabChange: (tab: SecurityTab) => void;
  /** Notifications + more-menu cluster for the mobile masthead right slot.
   *  Passed only on the bespoke phone surface; absent on desktop. */
  headerActions?: ReactNode;
}

// Maps the masthead tone (shared with the desktop PageMasthead) onto the mobile
// masthead's dot tone, state-word color, and whether the dot pulses. Idle reads
// as an amber caution (the mobile dot has no neutral grey).
type StateWordClass = 'text-destructive' | 'text-warning' | 'text-stat-value' | 'text-stat-title';
const MOBILE_MASTHEAD_TONE: Record<MastheadTone, { dot: Tone; word: StateWordClass; pulse: boolean }> = {
  error: { dot: 'destructive', word: 'text-destructive', pulse: true },
  warn: { dot: 'warning', word: 'text-warning', pulse: true },
  live: { dot: 'brand', word: 'text-stat-value', pulse: false },
  idle: { dot: 'warning', word: 'text-stat-title', pulse: false },
};

export function SecurityView({ activeTab, onTabChange, headerActions }: SecurityViewProps) {
  const { can } = useAuth();
  const { activeNode } = useNodes();
  const isMobile = useIsMobile();
  const isRemote = activeNode?.type === 'remote';

  const [isReplica, setIsReplica] = useState(false);
  // Bumped after a node-wide scan completes, or when image-update checks are
  // toggled, to refetch the active node's posture.
  const [reloadToken, setReloadToken] = useState(0);

  // Active-node scoped data. The overview rollup, image summaries, risk trend,
  // and exploit intel each hydrate from their own request, so a slow or failed
  // image-summary inventory never holds the overview, and a degraded read stays
  // confined to the region it feeds. Every region is bound to the active node,
  // so a response for a node the operator has left is dropped.
  const nodeScope = activeNode?.id;

  // One warning covers a failed background refresh of the regions that report
  // here: image summaries, the risk trend, and exploit intel. A region that
  // already had data keeps showing it, so the refresh failure is reported once
  // instead of blanking the surface or stacking a toast per region. A first read
  // that fails is reported by the region's own surface (the Images tab or a
  // chart placeholder) and does not also toast, and an overview failure has its
  // own masthead state.
  const refreshWarnedRef = useRef(false);
  const notifyRefreshFailed = (_error: unknown, hadData: boolean) => {
    if (!hadData || refreshWarnedRef.current) return;
    refreshWarnedRef.current = true;
    toast.error('Could not refresh security data');
  };

  const overviewRegion = useRegionData<OverviewOutcome>(nodeScope, async (signal) => {
    try {
      const res = await apiFetch('/security/overview', { cache: 'no-store', signal });
      if (res.ok) {
        const body = await res.json() as SecurityOverview;
        return { kind: 'overview', overview: body };
      }
      if (res.status === 404) return { kind: 'unsupported' };
      console.warn('[Security] overview request failed:', res.status);
      // A node the hub could not read, or that rejected the hub's access, is
      // not a server error: the operator gets copy they can act on.
      return { kind: 'failed', cause: overviewFailureCause(classifyRemoteReadFailure(res) ?? 'http') };
    } catch (error) {
      console.warn('[Security] failed to load the overview:', error);
      return { kind: 'failed', cause: overviewFailureCause(classifyRemoteReadError(error)) };
    }
  }, reloadToken);

  const summariesRegion = useRegionData(nodeScope, async (signal) => {
    const res = await apiFetch('/security/image-summaries', { cache: 'no-store', signal });
    assertReadOk(res, '/security/image-summaries');
    const body: unknown = await res.json();
    // A 200 with an unexpected shape must not read as "no findings".
    if (!isScanSummaryMap(body)) throw new Error('/security/image-summaries returned an unexpected shape');
    return body;
  }, reloadToken, { onError: notifyRefreshFailed });

  const trendRegion = useRegionData<ChartOutcome<SecurityRiskTrendPoint[]>>(nodeScope, async (signal) => {
    const res = await apiFetch('/security/overview/trend', { signal });
    // An older node without the endpoint degrades to an empty chart, not a
    // permanent "unavailable right now".
    if (res.status === 404) return { kind: 'unsupported' };
    if (!res.ok) throw new Error(`/security/overview/trend responded ${res.status}`);
    const body: unknown = await res.json();
    if (!Array.isArray(body)) throw new Error('/security/overview/trend returned a malformed body');
    return { kind: 'data', data: body as SecurityRiskTrendPoint[] };
  }, reloadToken, { onError: notifyRefreshFailed });

  const intelRegion = useRegionData<ChartOutcome<{ items: ExploitIntelFinding[]; truncated: boolean }>>(nodeScope, async (signal) => {
    const res = await apiFetch('/security/overview/exploit-intel', { signal });
    // Both exploit charts share this read; an older node without the endpoint
    // shows their empty states instead of an error placeholder.
    if (res.status === 404) return { kind: 'unsupported' };
    if (!res.ok) throw new Error(`/security/overview/exploit-intel responded ${res.status}`);
    const body = await res.json() as { items?: unknown; truncated?: unknown } | null;
    // A body without an items array is a malformed read, not an empty finding set.
    if (!body || !Array.isArray(body.items)) {
      throw new Error('/security/overview/exploit-intel returned a malformed body');
    }
    return {
      kind: 'data',
      data: {
        items: body.items as ExploitIntelFinding[],
        // True when the query hit its row cap: the list shows the highest-risk
        // findings but not every one, so the UI discloses it.
        truncated: body.truncated === true,
      },
    };
  }, reloadToken, { onError: notifyRefreshFailed });

  // A new refresh cycle gets its own warning, so a later failed refresh is
  // reported too instead of staying silent because an earlier one warned.
  useEffect(() => {
    refreshWarnedRef.current = false;
  }, [reloadToken]);

  const overviewOutcome = overviewRegion.data;
  const overview = overviewOutcome?.kind === 'overview' ? overviewOutcome.overview : null;
  const overviewLoadError: OverviewLoadError | null = overviewOutcome?.kind === 'unsupported'
    ? 'unsupported'
    : overviewOutcome?.kind === 'failed' ? overviewOutcome.cause : null;
  const summaries = summariesRegion.data ?? {};
  // A region with data keeps rendering it through a refresh; only a scope with
  // no successful read yet is loading, and only a failed first read is an error.
  const summariesLoading = summariesRegion.data === null && summariesRegion.status === 'loading';
  const summariesError = summariesRegion.data === null && summariesRegion.status === 'failed';
  // The summaries read's own cause, so the scan-result tabs name a disconnected
  // Pilot instead of saying the scan results "failed to load". A plain status
  // or an unclassified error keeps the tabs' own copy.
  const summariesFailure = summariesError ? remoteReadFailureOf(summariesRegion.error) : null;
  const summariesErrorReason = isNamedReadFailure(summariesFailure)
    ? remoteReadFailureMessage(summariesFailure, { nodeName: activeNode?.name })
    : null;
  const trendOutcome = trendRegion.data;
  const trend = trendOutcome?.kind === 'data' ? trendOutcome.data : [];
  // An unsupported (404) outcome is a settled read: the chart shows its own
  // empty state. Only a failed read is "unavailable right now".
  const trendState: ChartLoadState = trendOutcome !== null
    ? 'ready'
    : trendRegion.status === 'failed' ? 'unavailable' : 'loading';
  const intelOutcome = intelRegion.data;
  const exploitIntel = intelOutcome?.kind === 'data' ? intelOutcome.data.items : [];
  const exploitTruncated = intelOutcome?.kind === 'data' ? intelOutcome.data.truncated : false;
  const intelState: ChartLoadState = intelOutcome !== null
    ? 'ready'
    : intelRegion.status === 'failed' ? 'unavailable' : 'loading';

  const [inspectScanId, setInspectScanId] = useState<number | null>(null);
  const [inspectInitialTab, setInspectInitialTab] = useState<ScanDetailTab | undefined>(undefined);
  const [inspectDriverVulnerabilityIds, setInspectDriverVulnerabilityIds] = useState<string[] | undefined>(undefined);
  // Filter / targeting for the Images tab when arriving from an overview link.
  // SecurityView owns both; ImagesTab never clears targeting locally (R1).
  const [imagesFilter, setImagesFilter] = useState<ImageFilterValue | null>(null);
  const [imagesFilterToken, setImagesFilterToken] = useState(0);
  const [imagesTargeting, setImagesTargeting] = useState<ImagesTargetingState | null>(null);

  // Navigate between security tabs, optionally preselecting an Images filter
  // and/or posture targeting so an overview action lands on the affected images.
  const handleNavigate = useCallback((
    tab: SecurityTab,
    filter?: ImageFilterValue,
    targeting?: ImagesTargetingInput,
  ) => {
    if (tab === 'images') {
      if (targeting && targeting.imageRefs.length > 0) {
        setImagesTargeting((prev) => ({
          kind: targeting.kind,
          label: targeting.label,
          imageRefs: targeting.imageRefs,
          targets: targeting.targets,
          ...(targeting.drivers ? { drivers: targeting.drivers } : {}),
          ...(targeting.driverCount !== undefined ? { driverCount: targeting.driverCount } : {}),
          ...(targeting.driversTruncated !== undefined
            ? { driversTruncated: targeting.driversTruncated }
            : {}),
          token: (prev?.token ?? 0) + 1,
        }));
        // R2: targeting navigation resets severity unless an explicit filter is supplied.
        setImagesFilter(filter ?? null);
        setImagesFilterToken((t) => t + 1);
      } else {
        setImagesTargeting(null);
        if (filter) {
          setImagesFilter(filter);
          setImagesFilterToken((t) => t + 1);
        }
      }
    }
    onTabChange(tab);
  }, [onTabChange]);

  const clearImagesTargeting = useCallback(() => {
    setImagesTargeting(null);
  }, []);

  // Drop Images drill-down state when the active node changes so refs from
  // node A never filter node B's summaries.
  useEffect(() => {
    setImagesTargeting(null);
    setImagesFilter(null);
    setImagesFilterToken(0);
  }, [activeNode?.id]);

  const onInspect = useCallback((
    scanId: number,
    initialTab?: ScanDetailTab,
    driverVulnerabilityIds?: string[],
  ) => {
    setInspectInitialTab(initialTab);
    setInspectDriverVulnerabilityIds(driverVulnerabilityIds);
    setInspectScanId(scanId);
  }, []);

  const nodeOverview = overview;
  const reloadOverview = useCallback(() => setReloadToken((t) => t + 1), []);
  const reasons = useSecurityReasons({
    overview: nodeOverview,
    isReplica,
    onNavigate: handleNavigate,
    reload: reloadOverview,
  });

  // Scanner readiness gates the Images Actions column; an admin on a node whose
  // scanner is available can trigger scans inline.
  const canScanImages = can('stack:deploy') && !!overview?.scanner.available;
  const canScanNode = can('node:manage') && !!overview?.scanner.available;
  const canReadSecurityExports = can('stack:read');
  const canEditSecurityPolicy = can('stack:edit');
  const { scanningRef, scanImage } = useImageScan({
    onComplete: (scanId) => onInspect(scanId, 'vulns'),
    onSummaries: summariesRegion.apply,
  });


  // Toggling image-update checks flips overview.updateChecksDisabled, which
  // gates Check again and the uncertain-row description. Refetch so Overview
  // does not stay stale until a page reload.
  useEffect(() => {
    const handler = (e: Event) => {
      const keys = (e as CustomEvent<SenchoSettingsChangedDetail>).detail?.changedKeys ?? [];
      if (keys.includes('image_update_checks_enabled')) {
        setReloadToken((t) => t + 1);
      }
    };
    window.addEventListener(SENCHO_SETTINGS_CHANGED, handler);
    return () => window.removeEventListener(SENCHO_SETTINGS_CHANGED, handler);
  }, []);

  // Governance panels (suppressions/acks) are control-governed; probe the local
  // fleet role so a replica renders them read-only, mirroring Settings.
  useEffect(() => {
    if (isRemote) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch('/fleet/role', { localOnly: true });
        if (!res.ok || cancelled) return;
        const data = await res.json();
        if (!cancelled && (data?.role === 'control' || data?.role === 'replica')) {
          setIsReplica((data.role as FleetRole) === 'replica');
        }
      } catch {
        // Treat as control on probe failure (read-only gate is best-effort).
      }
    })();
    return () => { cancelled = true; };
  }, [isRemote, activeNode?.id]);

  const { state, tone } = deriveMasthead(overview, overviewLoadError !== null);
  const pulsing = tone === 'live' && !!overview?.scanner.available;

  // The mobile tab strip mirrors the desktop tab IA, so every section stays
  // reachable by scroll.
  const mobileTabs: SecurityMobileTab[] = [
    { value: 'overview', label: 'Overview' },
    { value: 'images', label: 'Images' },
    { value: 'compose', label: 'Compose risks' },
    { value: 'secrets', label: 'Secrets' },
    { value: 'policies', label: 'Policies' },
    { value: 'suppressions', label: 'Suppressions' },
    { value: 'history', label: 'History' },
    { value: 'scanner', label: 'Scanner setup' },
  ];

  // The scanner-detections disclaimer rides as an info affordance next to the
  // scanned-images count rather than a standing caption below the masthead.
  // When posture is Action needed or Monitoring, the subtitle leads with the
  // residual Crit/High count and top reason labels so the operator sees why
  // without opening the review queue.
  const blockers = overview?.postureReasons?.filter((r) => r.severity === 'blocker') ?? [];
  const reviewReasons = overview?.postureReasons?.filter((r) => r.severity === 'review') ?? [];
  const residualCritHigh = (overview?.rawCritical ?? overview?.critical ?? 0)
    + (overview?.rawHigh ?? overview?.high ?? 0);
  let actionSummary: string | null = null;
  if (overview?.posture === 'Action needed' && blockers.length > 0) {
    actionSummary = `${blockers.length} action${blockers.length === 1 ? '' : 's'}: ${blockers.slice(0, 2).map((r) => r.label.toLowerCase()).join(', ')} · `;
  } else if (overview?.posture === 'Monitoring' && residualCritHigh > 0) {
    const labels = (reviewReasons.length > 0 ? reviewReasons : overview.postureReasons ?? [])
      .slice(0, 2)
      .map((r) => r.label.toLowerCase());
    const labelPart = labels.length > 0 ? `: ${labels.join(', ')}` : '';
    actionSummary = `${residualCritHigh} residual Crit/High${labelPart} · `;
  }
  const subtitle = overview ? (
    <span className="inline-flex items-center gap-1.5">
      {actionSummary ? <span>{actionSummary}</span> : null}
      <span>
        {overview.scannedImages} {overview.scannedImages === 1 ? 'image' : 'images'} scanned · scanner {overview.scanner.available ? 'ready' : 'not installed'}
      </span>
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex shrink-0 cursor-help text-stat-subtitle/70 hover:text-stat-subtitle">
              <Info className="h-3 w-3" strokeWidth={1.5} aria-hidden="true" />
            </span>
          </TooltipTrigger>
          <TooltipContent className="max-w-[260px]">{SCANNER_DETECTIONS_NOTE}</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </span>
  ) : undefined;

  // The tab panels are identical on desktop and mobile; only the masthead and
  // the tab strip differ, so the panels are shared between both layouts.
  const tabPanels = (
    <>
        <TabsContent value="overview">
          <OverviewTab
            overview={nodeOverview}
            loadError={overviewLoadError}
            onReload={reloadOverview}
            trend={trend}
            trendState={trendState}
            exploitIntel={exploitIntel}
            exploitIntelState={intelState}
            exploitTruncated={exploitTruncated}
            onNavigate={handleNavigate}
            onInspect={onInspect}
            canScan={canScanNode}
            reasons={reasons}
            onScanComplete={reloadOverview}
          />
        </TabsContent>

        <TabsContent value="images">
          <CapabilityGate capability="vulnerability-scanning" featureName="Vulnerability scanning" resolution="Install a scanner from the Scanner setup tab.">
            <ImagesTab
              summaries={summaries}
              loading={summariesLoading}
              error={summariesError}
              errorReason={summariesErrorReason}
              onRetry={reloadOverview}
              onInspect={onInspect}
              canScan={canScanImages}
              scanningRef={scanningRef}
              onScan={scanImage}
              initialFilter={imagesFilter ?? undefined}
              filterToken={imagesFilterToken}
              targeting={imagesTargeting}
              onClearTargeting={clearImagesTargeting}
              posturePartial={overview?.posturePartial === true}
              nodeId={activeNode?.id}
            />
          </CapabilityGate>
        </TabsContent>

        <TabsContent value="compose">
          <CapabilityGate capability="vulnerability-scanning" featureName="Vulnerability scanning" resolution="Install a scanner from the Scanner setup tab.">
            <FindingsTab kind="misconfig" summaries={summaries} loading={summariesLoading} error={summariesError} errorReason={summariesErrorReason} onRetry={reloadOverview} onInspect={onInspect} />
          </CapabilityGate>
        </TabsContent>

        <TabsContent value="secrets">
          <CapabilityGate capability="vulnerability-scanning" featureName="Vulnerability scanning" resolution="Install a scanner from the Scanner setup tab.">
            <FindingsTab kind="secret" summaries={summaries} loading={summariesLoading} error={summariesError} errorReason={summariesErrorReason} onRetry={reloadOverview} onInspect={onInspect} />
          </CapabilityGate>
        </TabsContent>

        <TabsContent value="policies">
          <ScanPolicyManager />
        </TabsContent>

        <TabsContent value="suppressions">
          {isRemote ? (
            <div className="flex items-start gap-2 rounded-lg border border-card-border bg-muted/30 px-4 py-3">
              <Info className="w-4 h-4 text-muted-foreground shrink-0 mt-0.5" strokeWidth={1.5} aria-hidden="true" />
              <div className="text-sm">
                <div className="font-medium">Managed on the local instance</div>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Suppressions and acknowledgements are managed on the local Sencho instance. Switch to the local node to view them.
                </p>
              </div>
            </div>
          ) : (
            <div className="space-y-6">
              <SuppressionsPanel isReplica={isReplica} />
              <MisconfigAckPanel isReplica={isReplica} />
            </div>
          )}
        </TabsContent>

        <TabsContent value="history">
          <CapabilityGate capability="vulnerability-scanning" featureName="Vulnerability scanning" resolution="Install a scanner from the Scanner setup tab.">
            <HistoryTab onInspect={onInspect} />
          </CapabilityGate>
        </TabsContent>

        <TabsContent value="scanner">
          <ScannerSetupTab />
        </TabsContent>
    </>
  );

  const scanSheet = (
    <VulnerabilityScanSheet
      scanId={inspectScanId}
      initialTab={inspectInitialTab}
      driverVulnerabilityIds={inspectDriverVulnerabilityIds}
      driverFilterMode={
        imagesTargeting?.kind === 'waiting_upstream' || imagesTargeting?.kind === 'update_check_uncertain'
          ? 'monitoring'
          : 'action'
      }
      driverCount={imagesTargeting?.driverCount}
      driversTruncated={imagesTargeting?.driversTruncated}
      onClose={() => {
        setInspectScanId(null);
        setInspectDriverVulnerabilityIds(undefined);
      }}
      canGenerateSbom={canReadSecurityExports}
      canExportSarif={canReadSecurityExports}
      canCompare
      canManageSuppressions={canEditSecurityPolicy}
    />
  );

  // Mobile: a bespoke masthead-led screen (no TopBar). The masthead leads with
  // the notifications + more-menu cluster in its right slot, the tab strip is a
  // horizontal scroller, and the active panel scrolls below.
  if (isMobile) {
    const mobileTone = MOBILE_MASTHEAD_TONE[tone];
    return (
      <div className="flex h-full min-h-0 flex-col">
        <Masthead
          kicker="security"
          state={state}
          stateTone={mobileTone.dot}
          stateClassName={mobileTone.word}
          live={mobileTone.pulse}
          meta={subtitle}
          right={headerActions}
        />
        <SecurityMobileTabs tabs={mobileTabs} active={activeTab} onSelect={onTabChange} />
        <div className="flex-1 min-h-0 overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden p-4">
          <Tabs value={activeTab} onValueChange={(v) => onTabChange(v as SecurityTab)}>
            {tabPanels}
          </Tabs>
        </div>
        {scanSheet}
      </div>
    );
  }

  return (
    <div className="h-full overflow-auto p-6">
      <PageMasthead
        state={state}
        tone={tone}
        pulsing={pulsing}
        size="hero"
        className="rounded-lg mb-4"
        subtitle={subtitle}
        metadata={overview ? [
          { label: 'CRITICAL', value: String(overview.critical), tone: overview.critical > 0 ? 'error' : 'value' },
          { label: 'HIGH', value: String(overview.high), tone: overview.high > 0 ? 'warn' : 'value' },
          { label: 'LAST SCAN', value: overview.lastSuccessfulScanAt ? formatTimeAgo(overview.lastSuccessfulScanAt) : 'never', tone: 'subtitle' },
        ] : undefined}
      />

      <Tabs value={activeTab} onValueChange={(v) => onTabChange(v as SecurityTab)}>
        {/* Standard full-width tab band (matches Fleet): the list's own pill band
            is flattened so the tabs sit directly in this single band. */}
        <div className="flex items-center gap-3 mb-4 flex-wrap rounded-lg border border-card-border bg-card/40 px-2.5 py-1.5">
          <TabsList className="border-transparent bg-transparent max-md:w-full max-md:overflow-x-auto max-md:[scrollbar-width:none]">
            <TabsHighlight className="rounded-md bg-brand/20" transition={springs.snappy}>
            <TabsHighlightItem value="overview">
              <TabsTrigger value="overview"><LayoutDashboard className="w-4 h-4 mr-1.5" />Overview</TabsTrigger>
            </TabsHighlightItem>
            <TabsHighlightItem value="images">
              <TabsTrigger value="images"><Boxes className="w-4 h-4 mr-1.5" />Images</TabsTrigger>
            </TabsHighlightItem>
            <TabsHighlightItem value="compose">
              <TabsTrigger value="compose"><FileWarning className="w-4 h-4 mr-1.5" />Compose risks</TabsTrigger>
            </TabsHighlightItem>
            <TabsHighlightItem value="secrets">
              <TabsTrigger value="secrets"><KeyRound className="w-4 h-4 mr-1.5" />Secrets</TabsTrigger>
            </TabsHighlightItem>
            <span aria-hidden className="self-center mx-1 h-4 w-px bg-border" />
            <TabsHighlightItem value="policies">
              <TabsTrigger value="policies"><BookCheck className="w-4 h-4 mr-1.5" />Policies</TabsTrigger>
            </TabsHighlightItem>
            <TabsHighlightItem value="suppressions">
              <TabsTrigger value="suppressions"><EyeOff className="w-4 h-4 mr-1.5" />Suppressions</TabsTrigger>
            </TabsHighlightItem>
            <TabsHighlightItem value="history">
              <TabsTrigger value="history"><HistoryIcon className="w-4 h-4 mr-1.5" />History</TabsTrigger>
            </TabsHighlightItem>
            <TabsHighlightItem value="scanner">
              <TabsTrigger value="scanner"><Wrench className="w-4 h-4 mr-1.5" />Scanner setup</TabsTrigger>
            </TabsHighlightItem>
          </TabsHighlight>
          </TabsList>
        </div>
        {tabPanels}
      </Tabs>

      {scanSheet}
    </div>
  );
}
