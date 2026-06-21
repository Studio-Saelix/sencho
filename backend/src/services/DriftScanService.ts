import { DatabaseService } from './DatabaseService';
import { DriftLedgerService } from './DriftLedgerService';
import { isDebugEnabled } from '../utils/debug';
import { getErrorMessage } from '../utils/errors';

/**
 * Opt-in background drift scanner. The drift ledger (DriftLedgerService) only
 * advances when something reconciles a stack: a manual re-check or a deploy. With
 * neither, the persisted history and its activity entries never move, so the Drift
 * tab can show live drift the history never recorded. This service closes that gap:
 * when enabled, it periodically reconciles every stack on each local node (one
 * reconcileNode call per node) so drift is recorded and surfaced in the activity
 * feed without an operator opening each Drift tab.
 *
 * Local nodes only: a remote node runs its own Sencho instance and scans itself.
 * Off by default (drift_scan_enabled); the interval is drift_scan_interval_minutes.
 * A fixed base tick re-reads both settings each minute, so enabling, disabling, or
 * changing the interval takes effect on the next tick without a restart or a timer
 * reschedule, which is why the plain global-settings keys suffice (no side-effect
 * endpoint needed). Detection only: it never auto-reconciles the runtime to compose.
 */

const BASE_TICK_MS = 60_000;          // re-read settings and check whether a scan is due, once a minute
const INITIAL_DELAY_MS = 45_000;      // let Docker and the node registry settle before the first scan
const DEFAULT_INTERVAL_MINUTES = 60;
const MIN_INTERVAL_MINUTES = 15;

export class DriftScanService {
    private static instance: DriftScanService;
    private tickTimer: NodeJS.Timeout | null = null;
    private initialTimer: NodeJS.Timeout | null = null;
    private isScanning = false;
    private lastScanAt = 0;

    private constructor() {}

    static getInstance(): DriftScanService {
        if (!DriftScanService.instance) DriftScanService.instance = new DriftScanService();
        return DriftScanService.instance;
    }

    start(): void {
        if (this.initialTimer || this.tickTimer) return;
        this.initialTimer = setTimeout(() => {
            void this.tick();
            this.tickTimer = setInterval(() => void this.tick(), BASE_TICK_MS);
        }, INITIAL_DELAY_MS);
    }

    stop(): void {
        if (this.initialTimer) {
            clearTimeout(this.initialTimer);
            this.initialTimer = null;
        }
        if (this.tickTimer) {
            clearInterval(this.tickTimer);
            this.tickTimer = null;
        }
    }

    /** Fail safe: a settings read error disables scanning rather than scanning unasked. */
    private isEnabled(): boolean {
        try {
            return DatabaseService.getInstance().getGlobalSettings()['drift_scan_enabled'] === '1';
        } catch {
            return false;
        }
    }

    private intervalMs(): number {
        try {
            const raw = Number(DatabaseService.getInstance().getGlobalSettings()['drift_scan_interval_minutes']);
            const minutes = Number.isFinite(raw) && raw >= MIN_INTERVAL_MINUTES ? raw : DEFAULT_INTERVAL_MINUTES;
            return minutes * 60_000;
        } catch {
            return DEFAULT_INTERVAL_MINUTES * 60_000;
        }
    }

    /**
     * Base-tick worker: scan only when enabled and the configured interval has
     * elapsed since the last scan. The isScanning guard drops a tick that fires
     * while a slow scan is still running rather than overlapping it.
     */
    async tick(): Promise<void> {
        if (this.isScanning || !this.isEnabled()) return;
        const now = Date.now();
        if (now - this.lastScanAt < this.intervalMs()) return;

        this.isScanning = true;
        this.lastScanAt = now;
        try {
            const nodes = DatabaseService.getInstance().getNodes().filter(n => n.type === 'local');
            for (const node of nodes) {
                if (node.id === undefined) continue;
                const result = await DriftLedgerService.getInstance().reconcileNode(node.id);
                if (isDebugEnabled() && (result.detected > 0 || result.resolved > 0)) {
                    console.log(`[DriftScan:diag] node ${node.id}: ${result.stacks} stack(s), +${result.detected} detected, -${result.resolved} resolved`);
                }
            }
        } catch (error) {
            console.error('[DriftScan] scan failed:', getErrorMessage(error, 'unknown'));
        } finally {
            this.isScanning = false;
        }
    }
}
