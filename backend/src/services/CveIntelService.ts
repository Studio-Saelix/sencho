import { DatabaseService } from './DatabaseService';
import { isDebugEnabled } from '../utils/debug';

/**
 * Background exploit-intelligence cache: CISA KEV (known-exploited) membership
 * and FIRST EPSS (exploitation probability), refreshed daily and joined to
 * findings at read time by CVE id.
 *
 * Design constraints:
 *  - Time-varying: never frozen onto scan rows, so a CVE that enters KEV next
 *    week lights up on a scan stored today.
 *  - Optional and air-gap tolerant: every fetch is isolated and best-effort. A
 *    failure keeps the last cache and never blocks scans or the Security page.
 *  - Bounded: EPSS is fetched only for the CVE ids actually present in stored
 *    findings, batched, so we never download the full ~250k-row EPSS dataset.
 *
 * Hosts contacted (documented for firewalled operators):
 *  - https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json
 *  - https://api.first.org/data/v1/epss  (public, no API key)
 */
const KEV_URL = 'https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json';
const EPSS_API = 'https://api.first.org/data/v1/epss';
const FETCH_TIMEOUT_MS = 15_000;
const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000; // daily
const INITIAL_DELAY_MS = 30_000;
const EPSS_BATCH = 100; // FIRST API accepts a comma-separated batch per request
const EPSS_BATCH_DELAY_MS = 250; // be polite to the public API between batches

interface KevFeed {
    vulnerabilities?: Array<{ cveID?: string; dateAdded?: string }>;
}
interface EpssResponse {
    data?: Array<{ cve?: string; epss?: string; percentile?: string }>;
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
        setTimeout(resolve, ms).unref();
    });
}

export class CveIntelService {
    private static instance: CveIntelService;
    private intervalId: NodeJS.Timeout | null = null;
    private firstTickId: NodeJS.Timeout | null = null;
    private refreshing = false;

    public static getInstance(): CveIntelService {
        if (!CveIntelService.instance) CveIntelService.instance = new CveIntelService();
        return CveIntelService.instance;
    }

    public start(): void {
        if (this.intervalId) return;
        this.firstTickId = setTimeout(() => void this.refresh(), INITIAL_DELAY_MS);
        this.firstTickId.unref();
        this.intervalId = setInterval(() => void this.refresh(), REFRESH_INTERVAL_MS);
        this.intervalId.unref();
    }

    public stop(): void {
        if (this.firstTickId) {
            clearTimeout(this.firstTickId);
            this.firstTickId = null;
        }
        if (this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = null;
        }
    }

    /**
     * Refresh both feeds. Public for the scheduled tick and tests. Never throws;
     * each source is isolated so one failing does not skip the other. Honors the
     * `cve_intel_enabled` setting (read locally on this instance), so the daily
     * timer keeps firing but the fetch body is skipped when disabled.
     */
    public async refresh(): Promise<void> {
        if (this.refreshing) return;
        const db = DatabaseService.getInstance();
        if (db.getGlobalSettings().cve_intel_enabled === '0') {
            if (isDebugEnabled()) console.log('[CveIntel] disabled by setting; skipping refresh');
            return;
        }
        this.refreshing = true;
        try {
            await this.refreshKev();
            await this.refreshEpss();
        } finally {
            this.refreshing = false;
        }
    }

    private async refreshKev(): Promise<void> {
        try {
            const res = await fetch(KEV_URL, {
                headers: { 'User-Agent': 'Sencho' },
                signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
            });
            if (!res.ok) throw new Error(`KEV feed returned ${res.status}`);
            const body = (await res.json()) as KevFeed;
            const entries = (body.vulnerabilities ?? [])
                .map((v) => ({
                    cve_id: typeof v.cveID === 'string' ? v.cveID : '',
                    date_added: typeof v.dateAdded === 'string' ? v.dateAdded : null,
                }))
                .filter((e) => e.cve_id.startsWith('CVE-'));
            DatabaseService.getInstance().replaceKev(entries, Date.now());
            if (isDebugEnabled()) console.log(`[CveIntel] KEV refreshed: ${entries.length} entries`);
        } catch (err) {
            console.warn('[CveIntel] KEV refresh failed (keeping cache):', (err as Error).message);
        }
    }

    private async refreshEpss(): Promise<void> {
        const db = DatabaseService.getInstance();
        const cveIds = db.getDistinctVulnerabilityCveIds();
        if (cveIds.length === 0) {
            if (isDebugEnabled()) console.log('[CveIntel] no CVEs in stored scans; skipping EPSS fetch');
            return;
        }
        try {
            for (let i = 0; i < cveIds.length; i += EPSS_BATCH) {
                const chunk = cveIds.slice(i, i + EPSS_BATCH);
                const res = await fetch(`${EPSS_API}?cve=${chunk.join(',')}`, {
                    headers: { 'User-Agent': 'Sencho' },
                    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
                });
                if (!res.ok) throw new Error(`EPSS API returned ${res.status}`);
                const body = (await res.json()) as EpssResponse;
                const entries = (body.data ?? [])
                    .map((d) => ({
                        cve_id: typeof d.cve === 'string' ? d.cve : '',
                        epss_score: d.epss != null ? Number(d.epss) : NaN,
                        epss_percentile: d.percentile != null ? Number(d.percentile) : NaN,
                    }))
                    .filter((e) => e.cve_id.startsWith('CVE-') && Number.isFinite(e.epss_score) && Number.isFinite(e.epss_percentile));
                db.upsertEpss(entries, Date.now());
                if (i + EPSS_BATCH < cveIds.length) await delay(EPSS_BATCH_DELAY_MS);
            }
            if (isDebugEnabled()) console.log(`[CveIntel] EPSS refreshed for ${cveIds.length} CVEs`);
        } catch (err) {
            console.warn('[CveIntel] EPSS refresh failed (keeping cache):', (err as Error).message);
        }
    }
}

export default CveIntelService;
