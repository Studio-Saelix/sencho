import { useCallback, useEffect, useState } from 'react';
import {
  LayoutDashboard, Boxes, FileWarning, KeyRound, BookCheck, EyeOff, History as HistoryIcon, Wrench, Info,
} from 'lucide-react';
import { Tabs, TabsContent, TabsList, TabsTrigger, TabsHighlight, TabsHighlightItem } from '@/components/ui/tabs';
import { PageMasthead } from '@/components/ui/PageMasthead';
import { CapabilityGate } from '@/components/CapabilityGate';
import { deriveMasthead } from './security/securityMasthead';
import { springs } from '@/lib/motion';
import { apiFetch } from '@/lib/api';
import { formatTimeAgo } from '@/lib/relativeTime';
import { useLicense } from '@/context/LicenseContext';
import { useAuth } from '@/context/AuthContext';
import { useNodes } from '@/context/NodeContext';
import { useImageScan } from '@/hooks/useImageScan';
import type { SecurityTab } from '@/lib/events';
import type { SecurityOverview, ScanSummary, ScanDetailTab, SecurityRiskTrendPoint, FleetRole } from '@/types/security';
import { VulnerabilityScanSheet } from './VulnerabilityScanSheet';
import { SuppressionsPanel } from './settings/SuppressionsPanel';
import { MisconfigAckPanel } from './settings/MisconfigAckPanel';
import { OverviewTab } from './security/OverviewTab';
import { ImagesTab } from './security/ImagesTab';
import { FindingsTab } from './security/FindingsTab';
import { PolicyPacksTab } from './security/PolicyPacksTab';
import { ScanPolicyManager } from './security/ScanPolicyManager';
import { ScannerSetupTab } from './security/ScannerSetupTab';
import { HistoryTab } from './security/HistoryTab';

interface SecurityViewProps {
  activeTab: SecurityTab;
  onTabChange: (tab: SecurityTab) => void;
}

export function SecurityView({ activeTab, onTabChange }: SecurityViewProps) {
  const { isPaid } = useLicense();
  const { isAdmin } = useAuth();
  const { activeNode } = useNodes();
  const isRemote = activeNode?.type === 'remote';

  const [overview, setOverview] = useState<SecurityOverview | null>(null);
  // 'unsupported' = the node has no overview endpoint (e.g. an older remote, 404);
  // 'failed' = a genuine error (5xx, network, malformed body) that must not read as benign.
  const [overviewLoadError, setOverviewLoadError] = useState<'unsupported' | 'failed' | null>(null);
  const [summaries, setSummaries] = useState<Record<string, ScanSummary>>({});
  const [summariesLoading, setSummariesLoading] = useState(true);
  const [summariesError, setSummariesError] = useState(false);
  const [trend, setTrend] = useState<SecurityRiskTrendPoint[]>([]);
  const [isReplica, setIsReplica] = useState(false);

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
      try {
        const [overviewRes, summariesRes, trendRes] = await Promise.all([
          apiFetch('/security/overview'),
          apiFetch('/security/image-summaries'),
          apiFetch('/security/overview/trend'),
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
          setSummaries(body && typeof body === 'object' ? body : {});
        } else {
          setSummaries({});
          setSummariesError(true);
          console.warn('[Security] image-summaries request failed:', summariesRes.status);
        }
        // The trend chart is non-critical: a failed OR malformed trend response
        // leaves it empty (the chart shows its own "no history" state). Parse it
        // in isolation so a bad trend body can never poison the overview/summaries
        // error state or crash the chart with a non-array value.
        try {
          const t = trendRes.ok ? await trendRes.json() : [];
          if (!cancelled) setTrend(Array.isArray(t) ? t : []);
        } catch {
          if (!cancelled) setTrend([]);
        }
      } catch (err) {
        if (cancelled) return;
        console.warn('[Security] failed to load security data:', err);
        setOverview(null);
        setOverviewLoadError('failed');
        setSummaries({});
        setSummariesError(true);
        setTrend([]);
      } finally {
        if (!cancelled) setSummariesLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [activeNode?.id]);

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

  return (
    <div className="h-full overflow-auto p-6">
      <PageMasthead
        kicker="SECURITY"
        state={state}
        tone={tone}
        pulsing={pulsing}
        className="rounded-lg mb-4"
        metadata={overview ? [
          { label: 'CRITICAL', value: String(overview.critical), tone: overview.critical > 0 ? 'error' : 'value' },
          { label: 'HIGH', value: String(overview.high), tone: overview.high > 0 ? 'warn' : 'value' },
          { label: 'LAST SCAN', value: overview.lastSuccessfulScanAt ? formatTimeAgo(overview.lastSuccessfulScanAt) : 'never', tone: 'subtitle' },
        ] : undefined}
      />

      <Tabs value={activeTab} onValueChange={(v) => onTabChange(v as SecurityTab)}>
        <TabsList className="mb-4 max-md:w-full max-md:overflow-x-auto max-md:[scrollbar-width:none]">
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

        <TabsContent value="overview">
          <OverviewTab
            overview={overview}
            loadError={overviewLoadError}
            summaries={summaries}
            trend={trend}
            onNavigate={onTabChange}
            onInspect={onInspect}
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

        <TabsContent value="policies">
          <div className="space-y-8">
            <ScanPolicyManager />
            <PolicyPacksTab />
          </div>
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
          <CapabilityGate capability="vulnerability-scanning" featureName="Vulnerability scanning">
            <HistoryTab onInspect={onInspect} />
          </CapabilityGate>
        </TabsContent>

        <TabsContent value="scanner">
          <ScannerSetupTab />
        </TabsContent>
      </Tabs>

      <VulnerabilityScanSheet
        scanId={inspectScanId}
        initialTab={inspectInitialTab}
        onClose={() => setInspectScanId(null)}
        canGenerateSbom={isAdmin}
        canExportSarif={isPaid && isAdmin}
        canCompare
        canManageSuppressions={isAdmin}
      />
    </div>
  );
}
