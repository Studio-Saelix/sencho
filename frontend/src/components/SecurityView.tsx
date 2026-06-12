import { useCallback, useEffect, useRef, useState } from 'react';
import {
  LayoutDashboard, Boxes, FileWarning, KeyRound, BookCheck, EyeOff, History as HistoryIcon, Wrench, Info,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
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
import type { SecurityTab } from '@/lib/events';
import type { SecurityOverview, ScanSummary, ScanDetailTab, FleetRole } from '@/types/security';
import { VulnerabilityScanSheet } from './VulnerabilityScanSheet';
import { SecurityHistoryView } from './SecurityHistoryView';
import { SuppressionsPanel } from './settings/SuppressionsPanel';
import { MisconfigAckPanel } from './settings/MisconfigAckPanel';
import { OverviewTab } from './security/OverviewTab';
import { ImagesTab } from './security/ImagesTab';
import { FindingsTab } from './security/FindingsTab';
import { PolicyPacksTab } from './security/PolicyPacksTab';
import { ScanPolicyManager } from './security/ScanPolicyManager';
import { ScannerSetupTab } from './security/ScannerSetupTab';

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
  const [isReplica, setIsReplica] = useState(false);

  const [inspectScanId, setInspectScanId] = useState<number | null>(null);
  const [inspectInitialTab, setInspectInitialTab] = useState<ScanDetailTab | undefined>(undefined);
  const [historyOpen, setHistoryOpen] = useState(false);

  const onInspect = useCallback((scanId: number, initialTab?: ScanDetailTab) => {
    setInspectInitialTab(initialTab);
    setInspectScanId(scanId);
  }, []);

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
          setSummaries(await summariesRes.json());
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

  // A deep-link to History (e.g. the Resources "Scan history" button, which
  // mounts this view with the History tab active) auto-opens the sheet once on
  // mount. Selecting the History tab manually shows the persistent launcher
  // body instead, so the sheet does not pop on every tab click; closing it
  // always leaves the launcher.
  const deepLinkedToHistory = useRef(activeTab === 'history');
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (deepLinkedToHistory.current) setHistoryOpen(true);
  }, []);

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
          <OverviewTab overview={overview} loadError={overviewLoadError} onNavigate={onTabChange} />
        </TabsContent>

        <TabsContent value="images">
          <CapabilityGate capability="vulnerability-scanning" featureName="Vulnerability scanning">
            <ImagesTab summaries={summaries} loading={summariesLoading} error={summariesError} onInspect={onInspect} />
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
            <PolicyPacksTab />
            <ScanPolicyManager />
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
            <div className="rounded-lg border border-card-border border-t-card-border-top bg-card shadow-card-bevel p-4 flex items-center justify-between gap-4 flex-wrap">
              <div className="min-w-0">
                <h3 className="font-medium text-sm">Scan history</h3>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {overview
                    ? `${overview.scannedImages} image${overview.scannedImages === 1 ? '' : 's'} scanned · last scan ${overview.lastSuccessfulScanAt ? formatTimeAgo(overview.lastSuccessfulScanAt) : 'never'}`
                    : 'Browse completed scans and compare them.'}
                </p>
              </div>
              <Button variant="outline" size="sm" onClick={() => setHistoryOpen(true)}>
                <HistoryIcon className="w-4 h-4 mr-1.5" strokeWidth={1.5} />
                Open scan history
              </Button>
            </div>
          </CapabilityGate>
        </TabsContent>

        <TabsContent value="scanner">
          <ScannerSetupTab />
        </TabsContent>
      </Tabs>

      <SecurityHistoryView open={historyOpen} onClose={() => setHistoryOpen(false)} />

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
