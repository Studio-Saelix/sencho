import { useCallback, useEffect, useState, type ReactNode } from 'react';
import {
  LayoutDashboard, Boxes, FileWarning, KeyRound, BookCheck, EyeOff, History as HistoryIcon, Wrench, Info,
} from 'lucide-react';
import { Tabs, TabsContent, TabsList, TabsTrigger, TabsHighlight, TabsHighlightItem } from '@/components/ui/tabs';
import { PageMasthead, type MastheadTone } from '@/components/ui/PageMasthead';
import { CapabilityGate } from '@/components/CapabilityGate';
import { deriveMasthead, SCANNER_DETECTIONS_NOTE } from './security/securityMasthead';
import { springs } from '@/lib/motion';
import { apiFetch } from '@/lib/api';
import { formatTimeAgo } from '@/lib/relativeTime';
import { useLicense } from '@/context/LicenseContext';
import { useAuth } from '@/context/AuthContext';
import { useNodes } from '@/context/NodeContext';
import { useImageScan } from '@/hooks/useImageScan';
import { useIsMobile } from '@/hooks/use-is-mobile';
import { Masthead, type Tone } from './mobile/mobile-ui';
import { SecurityMobileTabs, type SecurityMobileTab } from './security/SecurityMobile';
import type { SecurityTab } from '@/lib/events';
import type { SecurityOverview, ScanSummary, ScanDetailTab, SecurityRiskTrendPoint, ExploitIntelFinding, FleetRole } from '@/types/security';
import { VulnerabilityScanSheet } from './VulnerabilityScanSheet';
import { SuppressionsPanel } from './settings/SuppressionsPanel';
import { MisconfigAckPanel } from './settings/MisconfigAckPanel';
import { OverviewTab } from './security/OverviewTab';
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
  const { isPaid } = useLicense();
  const { isAdmin } = useAuth();
  const { activeNode } = useNodes();
  const isMobile = useIsMobile();
  const isRemote = activeNode?.type === 'remote';

  const [overview, setOverview] = useState<SecurityOverview | null>(null);
  // 'unsupported' = the node has no overview endpoint (e.g. an older remote, 404);
  // 'failed' = a genuine error (5xx, network, malformed body) that must not read as benign.
  const [overviewLoadError, setOverviewLoadError] = useState<'unsupported' | 'failed' | null>(null);
  const [summaries, setSummaries] = useState<Record<string, ScanSummary>>({});
  const [summariesLoading, setSummariesLoading] = useState(true);
  const [summariesError, setSummariesError] = useState(false);
  const [trend, setTrend] = useState<SecurityRiskTrendPoint[]>([]);
  const [exploitIntel, setExploitIntel] = useState<ExploitIntelFinding[]>([]);
  const [isReplica, setIsReplica] = useState(false);
  // Bumped after a node-wide scan completes to refetch the active node's posture.
  const [reloadToken, setReloadToken] = useState(0);

  const [inspectScanId, setInspectScanId] = useState<number | null>(null);
  const [inspectInitialTab, setInspectInitialTab] = useState<ScanDetailTab | undefined>(undefined);

  const onInspect = useCallback((scanId: number, initialTab?: ScanDetailTab) => {
    setInspectInitialTab(initialTab);
    setInspectScanId(scanId);
  }, []);

  // Scanner readiness gates the Images Actions column; an admin on a node whose
  // scanner is available can trigger scans inline.
  const canScan = isAdmin && !!overview?.scanner.available;
  const { scanningRef, scanImage } = useImageScan({
    onComplete: (scanId) => onInspect(scanId, 'vulns'),
    onSummaries: setSummaries,
  });

  // Active-node scoped data: overview rollup + image summaries follow x-node-id.
  // A failed fetch (5xx, network, malformed body) must surface as an error, never
  // as a benign "clean / no findings" view, which for a security surface is the
  // most dangerous misread. A 404 on /overview is the one benign case (an older
  // remote node that lacks the endpoint).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setSummariesLoading(true);
      setOverviewLoadError(null);
      setSummariesError(false);
      // The trend chart is non-critical: isolate its fetch entirely (transport
      // failure included, not just a non-OK/malformed body) so it can never
      // poison the overview/summaries error state. It degrades to an empty chart
      // with its own "no history" message.
      const trendPromise: Promise<SecurityRiskTrendPoint[]> = apiFetch('/security/overview/trend')
        .then((r) => (r.ok ? r.json() : []))
        .then((t) => (Array.isArray(t) ? t : []))
        .catch(() => []);
      // Exploit-intel powers two overview charts; isolate it like the trend so a
      // failure (or an older node without the endpoint) degrades to empty panels.
      const exploitIntelPromise: Promise<ExploitIntelFinding[]> = apiFetch('/security/overview/exploit-intel')
        .then((r) => (r.ok ? r.json() : { items: [] }))
        .then((b) => (b && Array.isArray(b.items) ? b.items : []))
        .catch(() => []);
      try {
        const [overviewRes, summariesRes] = await Promise.all([
          apiFetch('/security/overview'),
          apiFetch('/security/image-summaries'),
        ]);
        if (cancelled) return;
        if (overviewRes.ok) {
          setOverview(await overviewRes.json());
        } else {
          setOverview(null);
          setOverviewLoadError(overviewRes.status === 404 ? 'unsupported' : 'failed');
          if (overviewRes.status !== 404) {
            console.warn('[Security] overview request failed:', overviewRes.status);
          }
        }
        if (summariesRes.ok) {
          const body = await summariesRes.json();
          if (isScanSummaryMap(body)) {
            setSummaries(body);
          } else {
            // A 200 with an unexpected shape must not read as "no findings".
            setSummaries({});
            setSummariesError(true);
            console.warn('[Security] image-summaries returned an unexpected shape');
          }
        } else {
          setSummaries({});
          setSummariesError(true);
          console.warn('[Security] image-summaries request failed:', summariesRes.status);
        }
      } catch (err) {
        if (cancelled) return;
        console.warn('[Security] failed to load security data:', err);
        setOverview(null);
        setOverviewLoadError('failed');
        setSummaries({});
        setSummariesError(true);
      } finally {
        if (!cancelled) setSummariesLoading(false);
      }
      const [trendData, intelData] = await Promise.all([trendPromise, exploitIntelPromise]);
      if (!cancelled) {
        setTrend(trendData);
        setExploitIntel(intelData);
      }
    })();
    return () => { cancelled = true; };
  }, [activeNode?.id, reloadToken]);

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

  // The Policies tab hosts only the paid enforcement manager, so it is hidden for
  // Community; redirect off it if a deep-link lands a Community user there.
  useEffect(() => {
    if (!isPaid && activeTab === 'policies') onTabChange('overview');
  }, [isPaid, activeTab, onTabChange]);

  const { state, tone } = deriveMasthead(overview, overviewLoadError !== null);
  const pulsing = tone === 'live' && !!overview?.scanner.available;

  // The mobile tab strip mirrors the desktop tab IA, including the paid-only
  // Policies tab when licensed, so every section stays reachable by scroll.
  const mobileTabs: SecurityMobileTab[] = [
    { value: 'overview', label: 'Overview' },
    { value: 'images', label: 'Images' },
    { value: 'compose', label: 'Compose risks' },
    { value: 'secrets', label: 'Secrets' },
    ...(isPaid ? [{ value: 'policies', label: 'Policies' } as const] : []),
    { value: 'suppressions', label: 'Suppressions' },
    { value: 'history', label: 'History' },
    { value: 'scanner', label: 'Scanner setup' },
  ];

  // The scanner-detections disclaimer rides as an info affordance next to the
  // scanned-images count rather than a standing caption below the masthead.
  const subtitle = overview ? (
    <span className="inline-flex items-center gap-1.5">
      <span>
        {overview.scannedImages} {overview.scannedImages === 1 ? 'image' : 'images'} scanned · scanner {overview.scanner.available ? 'ready' : 'not installed'}
      </span>
      <span
        className="inline-flex shrink-0 cursor-help text-stat-subtitle/70 hover:text-stat-subtitle"
        title={SCANNER_DETECTIONS_NOTE}
        aria-label={SCANNER_DETECTIONS_NOTE}
      >
        <Info className="h-3 w-3" strokeWidth={1.5} aria-hidden="true" />
      </span>
    </span>
  ) : undefined;

  // The tab panels are identical on desktop and mobile; only the masthead and
  // the tab strip differ, so the panels are shared between both layouts.
  const tabPanels = (
    <>
        <TabsContent value="overview">
          <OverviewTab
            overview={overview}
            loadError={overviewLoadError}
            trend={trend}
            exploitIntel={exploitIntel}
            onNavigate={onTabChange}
            onInspect={onInspect}
            canScan={canScan}
            onScanComplete={() => setReloadToken((t) => t + 1)}
            isPaid={isPaid}
          />
        </TabsContent>

        <TabsContent value="images">
          <CapabilityGate capability="vulnerability-scanning" featureName="Vulnerability scanning">
            <ImagesTab
              summaries={summaries}
              loading={summariesLoading}
              error={summariesError}
              onInspect={onInspect}
              canScan={canScan}
              scanningRef={scanningRef}
              onScan={scanImage}
            />
          </CapabilityGate>
        </TabsContent>

        <TabsContent value="compose">
          <CapabilityGate capability="vulnerability-scanning" featureName="Vulnerability scanning">
            <FindingsTab kind="misconfig" summaries={summaries} loading={summariesLoading} error={summariesError} onInspect={onInspect} />
          </CapabilityGate>
        </TabsContent>

        <TabsContent value="secrets">
          <CapabilityGate capability="vulnerability-scanning" featureName="Vulnerability scanning">
            <FindingsTab kind="secret" summaries={summaries} loading={summariesLoading} error={summariesError} onInspect={onInspect} />
          </CapabilityGate>
        </TabsContent>

        {isPaid && (
          <TabsContent value="policies">
            <ScanPolicyManager />
          </TabsContent>
        )}

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
          <CapabilityGate capability="vulnerability-scanning" featureName="Vulnerability scanning">
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
      onClose={() => setInspectScanId(null)}
      canGenerateSbom={isAdmin}
      canExportSarif={isPaid && isAdmin}
      canCompare
      canManageSuppressions={isAdmin}
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
        <TabsList className="mb-4">
          <TabsHighlight className="rounded-md bg-glass-highlight" transition={springs.snappy}>
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
            {isPaid && (
              <TabsHighlightItem value="policies">
                <TabsTrigger value="policies"><BookCheck className="w-4 h-4 mr-1.5" />Policies</TabsTrigger>
              </TabsHighlightItem>
            )}
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
        {tabPanels}
      </Tabs>

      {scanSheet}
    </div>
  );
}
