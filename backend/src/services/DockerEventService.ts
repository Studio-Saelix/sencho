import Docker from 'dockerode';
import { NodeRegistry } from './NodeRegistry';
import { NotificationCategory, NotificationService } from './NotificationService';
import { DatabaseService } from './DatabaseService';
import SelfIdentityService from './SelfIdentityService';
import { CacheService } from './CacheService';
import {
    classifyDie,
    classifyGapExit,
    Classification,
    ContainerLifecycleState,
} from './ContainerLifecycleClassifier';
import { isDebugEnabled } from '../utils/debug';
import { getErrorMessage } from '../utils/errors';

/**
 * DockerEventService
 *
 * Subscribes to Docker's container event stream for a single local node and
 * translates causal events (kill / die / oom / health_status) into alerts.
 *
 * One instance is spawned per local node by DockerEventManager. Each instance
 * owns a dedicated Docker client, stream, reconnect timer, and state map - no
 * shared mutable state between per-node services.
 *
 * See docs/features/alerts-notifications.mdx for user-facing behaviour.
 */

/** Snapshot of a single container's health tracking state, exposed to AutoHealService. */
export interface ContainerHealthSnapshot {
    id: string;
    name?: string;
    stackName?: string;
    healthStatus?: 'healthy' | 'unhealthy' | 'starting';
    unhealthySince?: number;
    lastKillAt?: number;
    /**
     * Timestamp (ms) of the last exit classified as a crash or OOM kill, cleared
     * when the container next starts. Set independently of the crash-alert toggle
     * so Auto-Heal can distinguish a crash (heal-worthy) from an operator stop or
     * clean exit (which are never stamped here).
     */
    crashedAt?: number;
}

/** Grace window after a `die` before classifying, to absorb out-of-order kill events. */
const DIE_GRACE_WINDOW_MS = 500;

/** Max crash/health alerts emitted per node within RATE_WINDOW_MS. Overflow is batched. */
const RATE_LIMIT_MAX = 20;
const RATE_WINDOW_MS = 60_000;

/** Dedup window for repeat crash alerts of the same container. */
const CRASH_DEDUP_MS = 60 * 60_000;

/**
 * Uptime a container must reach after a restart before its next crash counts as
 * a new incident rather than another lap of the same loop. Docker's restart
 * backoff caps at one minute, so a container crashing in a loop never gets here
 * and stays deduped for the full window; one that ran five minutes and then died
 * genuinely recovered first.
 */
const CRASH_RECOVERY_UPTIME_MS = 5 * 60_000;

/**
 * Dedup window for repeat health alerts of the same container. Same duration as
 * crash dedup, but stored outside containerState so the 10-minute prune cannot
 * shrink the advertised 60-minute window. Unlike crash dedup, recovery (start /
 * healthy) does not clear this stamp.
 */
const HEALTH_DEDUP_MS = CRASH_DEDUP_MS;

/** Interval for pruning stale container state from memory. */
const PRUNE_INTERVAL_MS = 60_000;
const STATE_STALE_AFTER_MS = 10 * 60_000;

/** Parse-error threshold: >N errors per window triggers a single warning alert. */
const PARSE_ERROR_THRESHOLD = 10;
const PARSE_ERROR_WINDOW_MS = 60_000;

/** Fraction of exited containers on reconnect that triggers mass-event handling. */
const MASS_EVENT_THRESHOLD = 0.2;

/** Reconnect backoff bounds. */
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 60_000;
const RECONNECT_JITTER_MS = 500;

/** Compose project label key used by docker compose on every container it creates. */
const COMPOSE_PROJECT_LABEL = 'com.docker.compose.project';
const COMPOSE_SERVICE_LABEL = 'com.docker.compose.service';
/** Set by Sencho on every container it starts for a bounded recovery job. */
const RECOVERY_HELPER_LABEL = 'dev.sencho.recovery.helper';

/**
 * Container-event actions that change observable stack/container state. The
 * UI receives a lightweight `state-invalidate` signal for any of these so it
 * can refetch immediately rather than wait for the next polling tick.
 */
const STATE_INVALIDATE_ACTIONS = new Set([
    'start', 'die', 'kill', 'destroy', 'create', 'restart', 'pause', 'unpause',
    'health_status', 'rename', 'update',
]);

/** TTL for the cached global_crash settings flag (sub-second so toggle takes effect quickly). */
const SETTINGS_CACHE_MS = 500;

interface InternalContainerState extends ContainerLifecycleState {
    name?: string;
    stackName?: string;
    /** Compose service this container belongs to, for alert routing keys. */
    serviceName?: string;
    isSelf?: boolean;
    /** A recovery helper: its exit is the operation's result, not a crash. */
    helperContainer?: boolean;
    lastCrashAlertAt?: number;
    /**
     * Newest start timestamp whose dispatched crash alert consumed its run's
     * recovery evidence. Monotonic: an older classification that finishes late
     * must never rewind it.
     */
    lastCrashAlertStartAt?: number;
    /**
     * Incident keys already alerted inside the crash dedup window. An incident
     * is one crash loop: a stable run starts a new key and the short laps that
     * follow it inherit that key, so completion order cannot reopen or merge
     * incidents.
     */
    alertedIncidentKeys?: Map<number, number>;
    lastActivityAt: number;
    healthStatus?: 'healthy' | 'unhealthy' | 'starting';
    unhealthySince?: number;
    crashedAt?: number;
    lastStartAt?: number;
}

/**
 * One observed run of a container, from `start` until the `die` attributed to
 * it. Stability is decided from event timestamps when the die arrives, so
 * incident identity does not depend on when the deferred classifier finishes.
 */
interface ContainerRun {
    seq: number;
    startAt: number;
    /** Wall-clock arrival, used for pruning (event times may be historical). */
    observedAt: number;
    dieAt?: number;
    stable?: boolean;
    incidentKey?: number;
}

interface CrashAlertInfo {
    id: string;
    name: string;
    exitCode: number;
    stackName?: string;
    isSelf?: boolean;
    startAt?: number;
    incidentKey?: number;
}

interface PendingCrashAlert {
    classification: Classification;
    state: InternalContainerState;
    info: CrashAlertInfo;
}

interface DockerEventPayload {
    Type?: string;
    Action?: string;
    Actor?: {
        ID?: string;
        Attributes?: Record<string, string>;
    };
    time?: number;
    timeNano?: number;
}

type LifecycleStatus = 'disconnected' | 'connecting' | 'connected' | 'stopped';

/** Rate-limit token bound to the fixed window that issued it. */
interface RateToken {
    readonly windowStart: number;
}

/** Parse a Docker inspect timestamp (RFC 3339) to epoch ms, rejecting zero dates. */
function parseInspectTimestamp(value: string | undefined): number | undefined {
    if (!value) return undefined;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

export class DockerEventService {
    private readonly nodeId: number;
    private readonly nodeName: string;
    private readonly docker: Docker;
    private readonly notifier: NotificationService;

    private status: LifecycleStatus = 'disconnected';
    private stream: NodeJS.ReadableStream | null = null;
    private reconnectAttempts = 0;
    private reconnectTimer: NodeJS.Timeout | null = null;
    private pruneTimer: NodeJS.Timeout | null = null;

    /** Per-container lifecycle state, keyed by Docker container ID. */
    private containerState: Map<string, InternalContainerState> = new Map();

    /** Pending die timers keyed by container ID (for the 500ms grace window). */
    private pendingDieTimers: Map<string, NodeJS.Timeout> = new Map();

    /**
     * Die events currently being classified, keyed by container id and die
     * timestamp. A duplicate delivery that overlaps an in-flight classification
     * (the OOM inspect awaits before dispatch) would otherwise pass the dedup
     * gate before the first one stamps, and dispatch a second alert for the
     * same incident.
     */
    private inFlightDies = new Set<string>();

    /**
     * Last observed `start` event time per container id, kept outside
     * containerState. classifyDie creates the state only after the grace window,
     * so a start that lands inside it finds nothing to update; the crash-loop
     * dedup still needs an uptime measurement to tell a recovered container from
     * another lap. Bounded by pruneStaleState, cleared on destroy.
     */
    private lastStartEventAt = new Map<string, number>();

    /**
     * Observed runs per container, oldest first. Incident identity comes from
     * this log rather than from the order classifications finish, so an older
     * die that resolves after a newer one cannot reopen a closed incident.
     * Bounded by pruneStaleState, cleared on destroy.
     */
    private containerRuns = new Map<string, ContainerRun[]>();
    private nextRunSeq = 1;

    /**
     * In-flight crash dispatches keyed by container id. A die that arrives while
     * its predecessor's history write is pending is deferred, not dispatched,
     * so an overlapping delivery cannot double-alert or burn two tokens.
     */
    private crashAlertInFlight = new Set<string>();
    private pendingCrashAlerts = new Map<string, PendingCrashAlert>();

    /**
     * Shared fixed-window rate limiter for crash and health alerts (per local
     * node / this service instance). Dedup and transition checks run before
     * consuming a token so suppressed duplicates do not count toward the cap.
     * Tokens carry the issuing window start so a late refund cannot inflate a
     * newer window's budget.
     */
    private containerAlertRateWindowStart = 0;
    private containerAlertRateCount = 0;
    private suppressedCrashAlertCount = 0;
    private suppressedHealthAlertCount = 0;
    private summaryTimer: NodeJS.Timeout | null = null;

    /**
     * Process-local health-alert dedup keyed by container id. Kept outside
     * containerState so pruneStaleState cannot drop an active 60m window.
     * Entries expire after HEALTH_DEDUP_MS via pruneStaleState; the map clears
     * on process restart. Not cleared on healthy/start recovery.
     */
    private healthAlertDedupAt = new Map<string, number>();
    /** In-flight health dispatches; prevents concurrent duplicate flaps. */
    private healthAlertInFlight = new Set<string>();
    /**
     * Container ids that entered unhealthy again while a health dispatch was
     * in flight. Retried once after the in-flight call finishes if history
     * did not persist (so a failed write cannot permanently silence the alert).
     */
    private healthAlertPendingRetry = new Set<string>();

    /** Parse-error tracking for flooded bad payloads. */
    private parseErrorWindowStart = 0;
    private parseErrorCount = 0;
    private parseWarningEmitted = false;

    /** True once we've completed the initial boot reconciliation. */
    private bootReconciled = false;

    /** IDs of containers that were exited at the last known-good moment. */
    private exitedBaseline: Set<string> = new Set();

    /** Whether we've already emitted the one-time "lost connection" warning. */
    private disconnectedNoticeEmitted = false;

    /** Cache for the global_crash toggle to avoid a DB read per event. */
    private crashAlertsCache: { value: boolean; at: number } | null = null;

    constructor(nodeId: number, nodeName: string) {
        this.nodeId = nodeId;
        this.nodeName = nodeName;
        this.docker = NodeRegistry.getInstance().getDocker(nodeId);
        this.notifier = NotificationService.getInstance();
    }

    /** Open the event stream and begin consuming events. Safe to call once. */
    public async start(): Promise<void> {
        if (this.status !== 'disconnected') return;
        this.pruneTimer = setInterval(() => this.pruneStaleState(), PRUNE_INTERVAL_MS);
        await this.connect();
    }

    /** Close the stream, cancel timers, and clear state. */
    public shutdown(): void {
        // Flush overflow roll-up while still live so pending summaries are not dropped.
        this.flushRateLimitSummaryNow();
        this.status = 'stopped';
        this.clearReconnectTimer();
        if (this.pruneTimer) {
            clearInterval(this.pruneTimer);
            this.pruneTimer = null;
        }
        if (this.summaryTimer) {
            clearTimeout(this.summaryTimer);
            this.summaryTimer = null;
        }
        for (const timer of this.pendingDieTimers.values()) clearTimeout(timer);
        this.pendingDieTimers.clear();
        this.detachStream();
        this.containerState.clear();
        this.containerRuns.clear();
        this.crashAlertInFlight.clear();
        this.pendingCrashAlerts.clear();
        this.healthAlertDedupAt.clear();
        this.healthAlertInFlight.clear();
        this.healthAlertPendingRetry.clear();
        this.suppressedCrashAlertCount = 0;
        this.suppressedHealthAlertCount = 0;
        this.containerAlertRateCount = 0;
    }

    /** Status helper so await-crossing stopped checks are not narrowed away. */
    private isStopped(): boolean {
        return this.status === 'stopped';
    }

    // ========================================================================
    // Connection lifecycle
    // ========================================================================

    private async connect(): Promise<void> {
        if (this.status === 'stopped') return;
        this.status = 'connecting';
        try {
            const stream = await this.docker.getEvents({
                filters: { type: ['container'] },
            }) as unknown as NodeJS.ReadableStream;

            this.stream = stream;
            this.status = 'connected';

            if (this.disconnectedNoticeEmitted) {
                await this.emitInfo('system', `Reconnected to Docker daemon.`);
                this.disconnectedNoticeEmitted = false;
            }

            this.reconnectAttempts = 0;
            this.attachStreamHandlers(stream);

            await this.reconcile();
        } catch (error) {
            this.handleDisconnect(error);
        }
    }

    private attachStreamHandlers(stream: NodeJS.ReadableStream): void {
        let buffer = '';
        stream.on('data', (chunk: Buffer) => {
            buffer += chunk.toString('utf8');
            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';
            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed) continue;
                this.handleRawEvent(trimmed);
            }
        });
        stream.on('error', (err) => this.handleDisconnect(err));
        stream.on('end', () => this.handleDisconnect(new Error('Event stream ended')));
        stream.on('close', () => this.handleDisconnect(new Error('Event stream closed')));
    }

    private detachStream(): void {
        const s = this.stream;
        this.stream = null;
        if (!s) return;
        try {
            s.removeAllListeners();
            const destroyable = s as unknown as { destroy?: () => void };
            destroyable.destroy?.();
        } catch {
            /* noop */
        }
    }

    private handleDisconnect(error: unknown): void {
        if (this.status === 'stopped') return;
        this.detachStream();
        this.status = 'disconnected';

        if (!this.disconnectedNoticeEmitted) {
            this.disconnectedNoticeEmitted = true;
            void this.emitWarning('system', `Lost connection to Docker daemon; monitoring paused.`);
        }

        if (isDebugEnabled()) {
            console.log(`[DockerEvents:${this.nodeName}:diag] disconnected:`,
                error instanceof Error ? error.message : error);
        }
        this.scheduleReconnect();
    }

    private scheduleReconnect(): void {
        if (this.status === 'stopped') return;
        this.clearReconnectTimer();
        const attempt = this.reconnectAttempts;
        const base = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * Math.pow(2, attempt));
        const jitter = Math.floor(Math.random() * RECONNECT_JITTER_MS);
        const delay = base + jitter;
        this.reconnectAttempts += 1;
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            void this.connect();
        }, delay);
    }

    private clearReconnectTimer(): void {
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
    }

    // ========================================================================
    // Reconciliation
    // ========================================================================

    /**
     * Snapshot all containers on connect. On first boot, record the baseline
     * silently. On subsequent reconnects, treat newly-exited containers as
     * gap exits and classify them (or batch as a mass event).
     */
    private async reconcile(): Promise<void> {
        let containers;
        try {
            containers = await this.docker.listContainers({ all: true });
        } catch (err) {
            if (isDebugEnabled()) {
                console.log(`[DockerEvents:${this.nodeName}:diag] reconcile list failed:`,
                    err instanceof Error ? err.message : err);
            }
            return;
        }

        const exitedNow = new Set(
            containers.filter(c => c.State === 'exited').map(c => c.Id)
        );

        if (!this.bootReconciled) {
            this.exitedBaseline = exitedNow;
            this.bootReconciled = true;
            return;
        }

        const newlyExited = [...exitedNow].filter(id => !this.exitedBaseline.has(id));
        const totalKnown = Math.max(1, containers.length);
        const exitRatio = newlyExited.length / totalKnown;

        if (newlyExited.length === 0) {
            this.exitedBaseline = exitedNow;
            return;
        }

        if (exitRatio >= MASS_EVENT_THRESHOLD) {
            await this.emitInfo(
                'system',
                `Docker daemon interruption detected: ${newlyExited.length} containers exited during connection gap.`
            );
        } else {
            // Inspect + classify in parallel. Below the mass-event threshold
            // newlyExited is small by definition, so unbounded concurrency is fine.
            // Each gap is isolated with .catch() so a single failed inspect
            // (e.g. container removed between list and inspect) does not abort
            // the rest of the batch.
            await Promise.all(newlyExited.map(id =>
                this.classifyGap(id).catch(err => {
                    if (isDebugEnabled()) {
                        console.log(`[DockerEvents:${this.nodeName}:diag] gap classify failed for ${id}:`,
                            err instanceof Error ? err.message : err);
                    }
                })
            ));
        }

        this.exitedBaseline = exitedNow;
    }

    private async classifyGap(containerId: string): Promise<void> {
        try {
            const inspect = await this.docker.getContainer(containerId).inspect();
            const classification = classifyGapExit({ State: inspect.State });
            const state = this.containerState.get(containerId) ?? this.getOrCreateState(containerId);
            const name = inspect.Name?.replace(/^\//, '') ?? state.name ?? containerId.slice(0, 12);
            if (!state.name) state.name = name;
            const stackName = inspect.Config?.Labels?.[COMPOSE_PROJECT_LABEL];
            if (stackName && !state.stackName) state.stackName = stackName;
            const service = inspect.Config?.Labels?.[COMPOSE_SERVICE_LABEL];
            if (service && !state.serviceName) state.serviceName = service;
            const exitCode = inspect.State?.ExitCode ?? 0;
            if (this.isSelfContainer(containerId, name)) state.isSelf = true;

            // A clean stop during a connection gap also ends any crash the last
            // observed events left behind; the event path clears it on such an exit.
            if (classification === 'clean' || classification === 'intentional') {
                state.crashedAt = undefined;
                return;
            }

            const dieAt = parseInspectTimestamp(inspect.State?.FinishedAt) ?? Date.now();
            const startedAt = parseInspectTimestamp(inspect.State?.StartedAt);
            const run = this.attributeGapRun(containerId, startedAt, dieAt);
            const startAt = run?.startAt;
            const incidentKey = run?.incidentKey;
            const now = Date.now();

            // Same shared crash gate as the live event path: a stream gap must
            // not repeat an alert already sent for this loop, and an inspected
            // start that ran long enough still earns a new incident.
            state.crashedAt = now;
            if (this.isCrashIncidentSuppressed(state, incidentKey, startAt, dieAt, now)) return;

            await this.emitClassification(classification, state, {
                id: containerId,
                name,
                exitCode,
                stackName: state.stackName,
                isSelf: state.isSelf === true,
                startAt,
                incidentKey,
            });
        } catch (err) {
            if (isDebugEnabled()) {
                console.log(`[DockerEvents:${this.nodeName}:diag] gap inspect failed:`,
                    err instanceof Error ? err.message : err);
            }
        }
    }

    /** Attribute a reconnect-discovered exit to the run Docker reports it ran. */
    private attributeGapRun(
        id: string,
        startedAt: number | undefined,
        dieAt: number,
    ): ContainerRun | undefined {
        let runs = this.containerRuns.get(id);
        if (!runs) {
            runs = [];
            this.containerRuns.set(id, runs);
        }
        // Inspect reports the run Docker actually restarted into during the gap.
        // Reuse an observed run when it matches; only a clearly later start is a
        // new run (a second of slack absorbs second-vs-millisecond event times).
        const last = runs.length > 0 ? runs[runs.length - 1] : undefined;
        if (startedAt !== undefined && (!last || startedAt > last.startAt + 1_000)) {
            runs.push({ seq: this.nextRunSeq++, startAt: startedAt, observedAt: Date.now() });
        }
        if (runs.length === 0) return undefined;
        let index = -1;
        for (let i = runs.length - 1; i >= 0; i--) {
            if (runs[i].startAt <= dieAt) {
                index = i;
                break;
            }
        }
        if (index < 0) return undefined;
        const run = runs[index];
        if (run.dieAt === undefined) {
            run.dieAt = dieAt;
            run.stable = dieAt - run.startAt >= CRASH_RECOVERY_UPTIME_MS;
        }
        this.incidentKeyFor(runs, index);
        return run;
    }

    // ========================================================================
    // Event handling
    // ========================================================================

    private handleRawEvent(line: string): void {
        let payload: DockerEventPayload;
        try {
            payload = JSON.parse(line);
        } catch {
            this.trackParseError();
            return;
        }
        try {
            this.handleEvent(payload);
        } catch (err) {
            if (isDebugEnabled()) {
                console.log(`[DockerEvents:${this.nodeName}:diag] event handler threw:`,
                    err instanceof Error ? err.message : err);
            }
        }
    }

    private handleEvent(event: DockerEventPayload): void {
        if (event.Type !== 'container') return;
        const action = event.Action ?? '';
        const id = event.Actor?.ID;
        if (!id) return;
        const attrs = event.Actor?.Attributes ?? {};
        const isSelf = this.isSelfContainer(id, attrs.name);

        // Normalize: `health_status: unhealthy` -> base action
        const baseAction = action.startsWith('health_status') ? 'health_status' : action;

        // Push a lightweight state-invalidate signal so connected UIs can
        // refetch stack statuses immediately on a real container event,
        // without waiting for the next polling tick. This is fire-and-forget
        // and is NOT persisted to the alerts history. Drop the statuses cache
        // key alongside the broadcast so the UI's refetch recomputes instead
        // of serving an entry the event just made stale. The full
        // invalidateNodeCaches helper is not used: container events do not
        // reshape the project-name map or file-root allowlists, and the stats
        // key self-refreshes on its own 2s TTL.
        if (STATE_INVALIDATE_ACTIONS.has(baseAction) && !isSelf) {
            CacheService.getInstance().invalidate(`stack-statuses:${this.nodeId}`);
            this.notifier.broadcastEvent({
                type: 'state-invalidate',
                scope: 'stack',
                nodeId: this.nodeId,
                stackName: attrs[COMPOSE_PROJECT_LABEL] ?? null,
                containerId: id,
                action: baseAction,
                ts: Date.now(),
            });
        }

        switch (baseAction) {
            case 'kill':
                return this.onKill(id, event);
            case 'die':
                return this.onDie(id, event);
            case 'oom':
                return this.onOom(id);
            case 'health_status':
                return this.onHealthStatus(id, action, event);
            case 'start':
                return this.onStart(id, event);
            case 'destroy':
                return this.onDestroy(id);
        }
    }

    private onKill(id: string, event: DockerEventPayload): void {
        const state = this.getOrCreateState(id, event);
        state.lastKillAt = this.eventTimeMs(event);
        state.lastActivityAt = Date.now();
    }

    private onDie(id: string, event: DockerEventPayload): void {
        // Capture the die time at arrival, not inside the deferred classifier, so a
        // start that races in during the grace window is correctly seen as later.
        const dieAt = this.eventTimeMs(event);
        // Attribute the run at arrival: stability and incident identity must be
        // fixed when the event sequence says they happened, not when a parked
        // inspect resolves. A late classification then reads the same evidence.
        const run = this.attributeDieToRun(id, dieAt);
        // Defer classification to absorb out-of-order kill events.
        const existing = this.pendingDieTimers.get(id);
        if (existing) clearTimeout(existing);
        const timer = setTimeout(() => {
            this.pendingDieTimers.delete(id);
            void this.classifyDie(id, event, dieAt, run);
        }, DIE_GRACE_WINDOW_MS);
        this.pendingDieTimers.set(id, timer);
    }

    /** Attribute a die to the latest observed run that started at or before it. */
    private attributeDieToRun(id: string, dieAt: number): ContainerRun | undefined {
        const runs = this.containerRuns.get(id);
        if (!runs) return undefined;
        let index = -1;
        for (let i = runs.length - 1; i >= 0; i--) {
            if (runs[i].startAt <= dieAt) {
                index = i;
                break;
            }
        }
        if (index < 0) return undefined;
        const run = runs[index];
        if (run.dieAt === undefined) {
            run.dieAt = dieAt;
            run.stable = dieAt - run.startAt >= CRASH_RECOVERY_UPTIME_MS;
        }
        this.incidentKeyFor(runs, index);
        return run;
    }

    /**
     * Incident key for a run: a stable run opens its own incident; a short lap
     * inherits the incident of the run before it. Memoized per run.
     */
    private incidentKeyFor(runs: ContainerRun[], index: number): number {
        const run = runs[index];
        if (run.incidentKey !== undefined) return run.incidentKey;
        if (run.stable || index === 0) {
            run.incidentKey = run.seq;
        } else {
            run.incidentKey = this.incidentKeyFor(runs, index - 1);
        }
        return run.incidentKey;
    }

    private onOom(id: string): void {
        const state = this.getOrCreateState(id);
        state.oomPending = true;
        state.lastActivityAt = Date.now();
    }

    private onHealthStatus(id: string, action: string, event: DockerEventPayload): void {
        const state = this.getOrCreateState(id, event);
        state.lastActivityAt = Date.now();

        if (action.includes('unhealthy')) {
            const enteringUnhealthy = state.healthStatus !== 'unhealthy';
            if (enteringUnhealthy) {
                state.unhealthySince = Date.now();
            }
            // Auto-Heal reads healthStatus / unhealthySince; update before any alert gate.
            state.healthStatus = 'unhealthy';
            if (!enteringUnhealthy) return;
            if (!this.isCrashAlertsEnabled()) return;
            void this.dispatchHealthAlert(id, state);
        } else {
            // Recovery clears Auto-Heal timing but must not erase health-alert dedup,
            // or a healthy↔unhealthy flap would re-alert immediately.
            state.unhealthySince = undefined;
            state.healthStatus = action.includes('starting') ? 'starting' : 'healthy';
            // Drop deferred-retry markers so a later unrelated persist failure cannot
            // spuriously retry from a flap that already recovered.
            this.healthAlertPendingRetry.delete(id);
        }
    }

    /**
     * Dispatch a healthcheck failure alert with transition already confirmed.
     * Dedup and rate checks run before the token is consumed. Advance dedup
     * only when dispatchAlert returns `{ persisted: true }` (history row written).
     */
    private async dispatchHealthAlert(id: string, state: InternalContainerState): Promise<void> {
        if (this.isStopped()) return;

        const now = Date.now();
        if (this.isWithinAlertDedupWindow(this.healthAlertDedupAt.get(id), now, HEALTH_DEDUP_MS)) {
            return;
        }
        if (this.healthAlertInFlight.has(id)) {
            this.healthAlertPendingRetry.add(id);
            return;
        }
        const token = this.consumeRateToken();
        if (!token) {
            this.suppressedHealthAlertCount += 1;
            this.scheduleSummary();
            return;
        }

        this.healthAlertInFlight.add(id);
        let persisted = false;
        try {
            if (this.isStopped()) {
                this.refundRateToken(token);
                this.healthAlertPendingRetry.delete(id);
                return;
            }
            const name = state.name ?? id.slice(0, 12);
            const result = await this.emitError(
                'monitor_alert',
                `Healthcheck failed: ${name} is unhealthy.`,
                state.stackName,
                state.name,
                state.isSelf === true,
                state.serviceName,
            );
            persisted = result.persisted;
            if (persisted) {
                this.healthAlertDedupAt.set(id, Date.now());
                this.healthAlertPendingRetry.delete(id);
            } else {
                // Refund only into the window that issued the token so a late
                // persist failure cannot inflate a newer window's budget.
                this.refundRateToken(token);
                console.error(
                    `[DockerEvents:${this.nodeName}] Health alert history not persisted for ${id}; dedup not advanced`,
                );
            }
        } finally {
            this.healthAlertInFlight.delete(id);
        }

        if (this.isStopped()) {
            this.healthAlertPendingRetry.delete(id);
            return;
        }

        // A concurrent healthy→unhealthy flap was deferred while we were in
        // flight. If the first write failed, retry so the alert is not lost
        // while the container stays unhealthy with no further transitions.
        if (this.shouldRetryHealthAlert(id, state, persisted)) {
            this.healthAlertPendingRetry.delete(id);
            await this.dispatchHealthAlert(id, state);
        }
    }

    private shouldRetryHealthAlert(
        id: string,
        state: InternalContainerState,
        persisted: boolean,
    ): boolean {
        return !this.isStopped()
            && !persisted
            && this.healthAlertPendingRetry.has(id)
            && state.healthStatus === 'unhealthy';
    }

    private onStart(id: string, event: DockerEventPayload): void {
        // Recorded before the state lookup: a start inside the die grace window
        // arrives before classifyDie has created the state, and the crash-loop
        // dedup must still measure uptime from it.
        const startedAt = this.eventTimeMs(event);
        const state = this.containerState.get(id);
        const runs = this.containerRuns.get(id);
        const lastRun = runs && runs.length > 0 ? runs[runs.length - 1] : undefined;
        // Starts advance a container's run; they never rewind it. A replayed or
        // reordered older `start` must not replace the current run's evidence or
        // clear a crash signal stamped after it, or the older run's `die` could
        // reopen an incident that was already alerted.
        const newestStartAt = Math.max(
            this.lastStartEventAt.get(id) ?? Number.NEGATIVE_INFINITY,
            lastRun?.startAt ?? Number.NEGATIVE_INFINITY,
            state?.lastStartAt ?? Number.NEGATIVE_INFINITY,
        );
        if (startedAt < newestStartAt) return;
        if (startedAt === newestStartAt) {
            // Second-resolution event times make a genuine restart look equal to
            // the run it replaces. Only a die since that run started proves it is
            // a new run; without one this is a duplicate delivery of the same start.
            const restartedAfterDie = lastRun?.dieAt !== undefined && lastRun.dieAt >= lastRun.startAt;
            if (!restartedAfterDie) return;
        }

        const previousStart = this.lastStartEventAt.get(id) ?? Number.NEGATIVE_INFINITY;
        if (startedAt > previousStart) this.lastStartEventAt.set(id, startedAt);
        if (runs) {
            runs.push({ seq: this.nextRunSeq++, startAt: startedAt, observedAt: Date.now() });
        } else {
            this.containerRuns.set(id, [{ seq: this.nextRunSeq++, startAt: startedAt, observedAt: Date.now() }]);
        }

        if (!state) return;
        // Container came back: clear transient flags but keep identity.
        // `lastCrashAlertAt` and `lastCrashAlertStartAt` deliberately survive:
        // Docker emits `start` on every restart-policy restart, so clearing them
        // here would let a crash loop re-alert on every lap. classifyDie is
        // where a crash that follows a genuinely stable run earns its own alert,
        // and where that run's recovery evidence is consumed.
        state.lastKillAt = undefined;
        state.oomPending = undefined;
        state.crashedAt = undefined;
        state.unhealthySince = undefined;
        state.healthStatus = 'starting';
        // Event time, not arrival time: the supersede check and the crash-loop
        // stability measure both compare this against a `die` event's own
        // timestamp, so reading both from one clock keeps them in agreement.
        state.lastStartAt = startedAt;
        state.lastActivityAt = Date.now();
        this.healthAlertPendingRetry.delete(id);
    }

    private onDestroy(id: string): void {
        this.containerState.delete(id);
        this.lastStartEventAt.delete(id);
        this.containerRuns.delete(id);
        this.crashAlertInFlight.delete(id);
        this.pendingCrashAlerts.delete(id);
        const pending = this.pendingDieTimers.get(id);
        if (pending) {
            clearTimeout(pending);
            this.pendingDieTimers.delete(id);
        }
        this.healthAlertPendingRetry.delete(id);
        this.healthAlertInFlight.delete(id);
        this.healthAlertDedupAt.delete(id);
    }

    private async classifyDie(
        id: string,
        event: DockerEventPayload,
        dieAt: number,
        run: ContainerRun | undefined,
    ): Promise<void> {
        // Drop an identical die that arrives while its own classification is
        // still running; a distinct die (different timestamp) still classifies.
        const key = `${id}:${dieAt}`;
        if (this.inFlightDies.has(key)) return;
        this.inFlightDies.add(key);
        try {
            await this.classifyDieEvent(id, event, dieAt, run);
        } finally {
            this.inFlightDies.delete(key);
        }
    }

    private async classifyDieEvent(
        id: string,
        event: DockerEventPayload,
        dieAt: number,
        run: ContainerRun | undefined,
    ): Promise<void> {
        const state = this.getOrCreateState(id, event);
        const exitCodeStr = event.Actor?.Attributes?.exitCode;
        const parsedExit = exitCodeStr !== undefined ? parseInt(exitCodeStr, 10) : undefined;
        const exitCode = Number.isFinite(parsedExit) ? (parsedExit as number) : undefined;
        const now = Date.now();

        let classification = classifyDie(
            { at: dieAt, exitCode },
            { lastKillAt: state.lastKillAt, oomPending: state.oomPending, helperContainer: state.helperContainer },
        );

        // Die arrived: clear the oom flag regardless (we've now used it).
        state.oomPending = undefined;
        state.lastActivityAt = now;

        // A clean or intentional exit clears any prior crash signal, so a stale
        // crash cannot outlive a later graceful stop and be mistaken for a fresh one.
        if (classification === 'intentional' || classification === 'clean') {
            state.crashedAt = undefined;
            return;
        }

        // If the container started again strictly after this die occurred, the die
        // is superseded (the container recovered). Do not stamp a crash signal or
        // alert for it; the classification is deferred 500ms, so an immediate
        // restart can race ahead of this handler. A start at the same instant is
        // treated as preceding a genuine re-crash, not superseding it. Only the
        // live state counts here: a start recorded while this die was the first
        // event for the container is the restart that followed it, and must not
        // suppress the crash it followed.
        if (state.lastStartAt !== undefined && state.lastStartAt > dieAt) return;

        // Stamp the heal signal for Auto-Heal before the alert dedup/toggle gates
        // below. This must be independent of whether a crash alert is dispatched,
        // so Auto-Heal still sees the crash when crash alerts are disabled or
        // rate-suppressed. Cleared on the next `start` or a later clean exit.
        state.crashedAt = now;

        // The run and its incident were captured when the die arrived, so a
        // late-resolving inspect cannot reorder which incident this die belongs
        // to. Dedup is per incident, not per "most recent start": a stable
        // predecessor that completes after its successor stays closed, and a
        // replay of an already-alerted run cannot reopen it.
        const startAt = run ? run.startAt : this.runStartForDie(id, state, dieAt);
        const incidentKey = run?.incidentKey;

        // Dedup early: crashloops repeatedly reach this point with exit 137,
        // and the OOM fallback below issues a Docker inspect. Skipping the
        // inspect on deduped crashes avoids hammering the daemon.
        if (this.isCrashIncidentSuppressed(state, incidentKey, startAt, dieAt, now)) {
            return;
        }

        // OOM fallback: if Docker never emitted an `oom` event but the exit
        // code is 137 (SIGKILL, often the cgroup OOM killer), inspect the
        // container and reuse classifyGapExit so the "what counts as OOM
        // from inspect" rule lives in one place.
        if (classification === 'crash' && exitCode === 137) {
            try {
                const inspect = await this.docker.getContainer(id).inspect();
                if (classifyGapExit(inspect) === 'oom') {
                    classification = 'oom';
                }
            } catch (err) {
                if (isDebugEnabled()) {
                    console.log(`[DockerEvents:${this.nodeName}:diag] OOM fallback inspect failed for ${id}:`,
                        getErrorMessage(err, 'unknown error'));
                }
            }
        }

        // The inspect above yields: another lap can pass the dedup gate and
        // stamp the incident while this one is parked. Revalidate the same gate
        // against the current state before consuming a token and stamping, so
        // whichever lap finishes first wins and the other stays deduped.
        if (this.isCrashIncidentSuppressed(state, incidentKey, startAt, dieAt, Date.now())) {
            return;
        }

        await this.emitClassification(classification, state, {
            id,
            name: state.name ?? id.slice(0, 12),
            exitCode: exitCode ?? 0,
            stackName: state.stackName,
            isSelf: state.isSelf === true,
            startAt,
            incidentKey,
        });
    }

    /** Start timestamp of the run that produced this die, if it was observed. */
    private runStartForDie(id: string, state: InternalContainerState, dieAt: number): number | undefined {
        const rawStartAt = this.lastStartEventAt.get(id) ?? state.lastStartAt;
        return rawStartAt !== undefined && rawStartAt <= dieAt ? rawStartAt : undefined;
    }

    /**
     * Whether this die was already reported for its incident.
     *
     * A die inside an incident that already alerted stays deduped for the
     * window. A stable run normally opens a new incident, but the same run's
     * duplicate delivery must not qualify twice, which the incident-key check
     * covers. Incident keys are stable regardless of completion order, so an
     * older classification cannot reopen a loop that a newer one closed.
     */
    private isCrashIncidentSuppressed(
        state: InternalContainerState,
        incidentKey: number | undefined,
        startAt: number | undefined,
        dieAt: number,
        now: number,
    ): boolean {
        const withinWindow = this.isWithinAlertDedupWindow(state.lastCrashAlertAt, now, CRASH_DEDUP_MS);
        if (!withinWindow) return false;

        const stable = this.hasStableRunSinceStart(startAt, dieAt);
        if (!stable) return true;
        if (incidentKey === undefined) {
            // No observed run to key on; fall back to the consumed start so a
            // duplicate stable delivery still stays deduped.
            return startAt !== undefined && startAt === state.lastCrashAlertStartAt;
        }
        return this.isWithinAlertDedupWindow(
            state.alertedIncidentKeys?.get(incidentKey),
            now,
            CRASH_DEDUP_MS,
        );
    }

    // ========================================================================
    // Alert emission + rate limiting
    // ========================================================================

    private async emitClassification(
        classification: Classification,
        state: InternalContainerState,
        info: CrashAlertInfo,
    ): Promise<void> {
        if (this.isStopped()) return;
        // Respect the existing global crash-alerts toggle so users who have
        // disabled these notifications in Settings remain opted out.
        if (!this.isCrashAlertsEnabled()) return;

        // A delivery for this container is already awaiting persistence. Keep
        // the latest one parked so it can retry if that write fails, instead of
        // letting both consume tokens and both dispatch.
        if (this.crashAlertInFlight.has(info.id)) {
            this.pendingCrashAlerts.set(info.id, { classification, state, info });
            return;
        }

        const message = classification === 'oom'
            ? `Container OOM Kill: ${info.name} was killed by the OOM killer (out of memory).`
            : `Container Crash Detected: ${info.name} exited unexpectedly (Code: ${info.exitCode}).`;

        const token = this.consumeRateToken();
        if (!token) {
            this.suppressedCrashAlertCount += 1;
            this.scheduleSummary();
            return;
        }

        this.crashAlertInFlight.add(info.id);
        let shouldRetry = false;
        try {
            if (this.isStopped()) {
                this.refundRateToken(token);
                this.pendingCrashAlerts.delete(info.id);
                return;
            }
            const result = await this.emitError(
                'monitor_alert',
                message,
                info.stackName,
                info.name,
                info.isSelf === true,
                state.serviceName,
            );
            if (result.persisted) {
                this.stampCrashAlert(state, info);
                this.pendingCrashAlerts.delete(info.id);
            } else {
                // A transient history-write failure must not consume the
                // incident, or the only alert for the loop is lost until the
                // window expires. Refund the issuing window's token and let a
                // later delivery (or a parked overlap) retry.
                this.refundRateToken(token);
                shouldRetry = true;
                console.error(
                    `[DockerEvents:${this.nodeName}] Crash alert history not persisted for ${info.id}; dedup not advanced`,
                );
            }
        } finally {
            this.crashAlertInFlight.delete(info.id);
        }

        if (this.isStopped()) {
            this.pendingCrashAlerts.delete(info.id);
            return;
        }

        // An overlapping delivery was deferred while persistence was pending.
        // If the first write failed, retry it now so the alert is not lost.
        if (shouldRetry) {
            const pending = this.pendingCrashAlerts.get(info.id);
            if (pending) {
                this.pendingCrashAlerts.delete(info.id);
                await this.emitClassification(pending.classification, pending.state, pending.info);
            }
        }
    }

    /** Record a crash alert that reached notification history. */
    private stampCrashAlert(state: InternalContainerState, info: CrashAlertInfo): void {
        const now = Date.now();
        state.lastCrashAlertAt = now;
        // Monotonic: a late older classification must not rewind the newest
        // consumed run's evidence, or a replay of the newer run re-alerts.
        if (info.startAt !== undefined
            && (state.lastCrashAlertStartAt === undefined || info.startAt > state.lastCrashAlertStartAt)) {
            state.lastCrashAlertStartAt = info.startAt;
        }
        if (info.incidentKey !== undefined) {
            if (!state.alertedIncidentKeys) state.alertedIncidentKeys = new Map();
            state.alertedIncidentKeys.set(info.incidentKey, now);
        }
    }

    private isCrashAlertsEnabled(): boolean {
        const now = Date.now();
        const cached = this.crashAlertsCache;
        if (cached && now - cached.at < SETTINGS_CACHE_MS) return cached.value;
        let value = false;
        try {
            const settings = DatabaseService.getInstance().getGlobalSettings();
            value = settings['global_crash'] === '1';
        } catch (err) {
            // Default-deny on settings lookup failure: don't spam users if the
            // DB is temporarily unavailable.
            if (isDebugEnabled()) {
                console.log(`[DockerEvents:${this.nodeName}:diag] settings lookup failed:`,
                    err instanceof Error ? err.message : err);
            }
        }
        this.crashAlertsCache = { value, at: now };
        return value;
    }

    /**
     * Consume one shared crash/health rate token for the current fixed window.
     * Returns null when the window is exhausted. Rolling into a new window first
     * flushes any pending overflow summary so counters cannot span windows.
     */
    private consumeRateToken(): RateToken | null {
        const now = Date.now();
        if (now - this.containerAlertRateWindowStart >= RATE_WINDOW_MS) {
            this.flushRateLimitSummaryNow();
            this.containerAlertRateWindowStart = now;
            this.containerAlertRateCount = 0;
        }
        if (this.containerAlertRateCount >= RATE_LIMIT_MAX) return null;
        this.containerAlertRateCount += 1;
        return { windowStart: this.containerAlertRateWindowStart };
    }

    /** Refund a token only when the issuing window is still active. */
    private refundRateToken(token: RateToken): void {
        if (token.windowStart !== this.containerAlertRateWindowStart) return;
        if (this.containerAlertRateCount > 0) this.containerAlertRateCount -= 1;
    }

    private isWithinAlertDedupWindow(
        lastAlertAt: number | undefined,
        now: number,
        windowMs: number,
    ): boolean {
        return lastAlertAt !== undefined && now - lastAlertAt < windowMs;
    }

    /**
     * Whether the container ran long enough after its last start for a fresh
     * crash to be a new incident. A container we never saw start (its state was
     * created from the die itself) has no evidence of stability, so it stays
     * inside the loop's dedup window.
     */
    private hasStableRunSinceStart(lastStartAt: number | undefined, dieAt: number): boolean {
        if (lastStartAt === undefined) return false;
        return dieAt - lastStartAt >= CRASH_RECOVERY_UPTIME_MS;
    }

    private buildRateLimitSummaryMessage(crash: number, health: number): string {
        const total = crash + health;
        if (crash > 0 && health > 0) {
            return `${total} additional container alerts were rate-limited in the last minute (${crash} crash, ${health} health).`;
        }
        if (health > 0) {
            return `${health} additional container health alerts were rate-limited in the last minute.`;
        }
        return `${crash} additional container crash alerts were rate-limited in the last minute.`;
    }

    /** Emit and clear any pending overflow roll-up immediately (e.g. on window roll). */
    private flushRateLimitSummaryNow(): void {
        if (this.summaryTimer) {
            clearTimeout(this.summaryTimer);
            this.summaryTimer = null;
        }
        const crash = this.suppressedCrashAlertCount;
        const health = this.suppressedHealthAlertCount;
        this.suppressedCrashAlertCount = 0;
        this.suppressedHealthAlertCount = 0;
        if (crash + health <= 0) return;
        if (this.status === 'stopped') return;
        void this.emitWarning('monitor_alert', this.buildRateLimitSummaryMessage(crash, health));
    }

    private scheduleSummary(): void {
        if (this.summaryTimer) return;
        const remaining = RATE_WINDOW_MS - (Date.now() - this.containerAlertRateWindowStart);
        const delay = Math.max(1_000, remaining);
        this.summaryTimer = setTimeout(() => {
            this.summaryTimer = null;
            this.flushRateLimitSummaryNow();
        }, delay);
    }

    private trackParseError(): void {
        const now = Date.now();
        if (now - this.parseErrorWindowStart >= PARSE_ERROR_WINDOW_MS) {
            this.parseErrorWindowStart = now;
            this.parseErrorCount = 0;
            this.parseWarningEmitted = false;
        }
        this.parseErrorCount += 1;
        if (this.parseErrorCount > PARSE_ERROR_THRESHOLD && !this.parseWarningEmitted) {
            this.parseWarningEmitted = true;
            void this.emitWarning(
                'system',
                `Received malformed Docker event payloads. Monitoring continues but some events may be skipped.`,
            );
        }
    }

    // ========================================================================
    // State + helpers
    // ========================================================================

    private getOrCreateState(id: string, event?: DockerEventPayload): InternalContainerState {
        let state = this.containerState.get(id);
        if (!state) {
            state = { lastActivityAt: Date.now() };
            this.containerState.set(id, state);
        }
        if (event) {
            const attrs = event.Actor?.Attributes ?? {};
            if (attrs.name && !state.name) state.name = attrs.name;
            // Sencho's own recovery helpers carry this label. Their exits are the
            // operation's result, so they never raise a crash signal or alert.
            if (attrs[RECOVERY_HELPER_LABEL]) state.helperContainer = true;
            const project = attrs[COMPOSE_PROJECT_LABEL];
            if (project && !state.stackName) state.stackName = project;
            const service = attrs[COMPOSE_SERVICE_LABEL];
            if (service && !state.serviceName) state.serviceName = service;
        }
        if (this.isSelfContainer(id, state.name)) {
            state.isSelf = true;
        }
        return state;
    }

    private isSelfContainer(id?: string, name?: string): boolean {
        const self = SelfIdentityService.getInstance();
        if (id && self.isOwnContainer(id)) return true;
        const normalizedName = name?.replace(/^\//, '');
        return normalizedName ? self.isOwnContainer(normalizedName) : false;
    }

    private eventTimeMs(event: DockerEventPayload): number {
        if (typeof event.timeNano === 'number') return Math.floor(event.timeNano / 1_000_000);
        if (typeof event.time === 'number') return event.time * 1000;
        return Date.now();
    }

    private pruneStaleState(): void {
        if (this.containerState.size > 0) {
            const cutoff = Date.now() - STATE_STALE_AFTER_MS;
            for (const [id, state] of this.containerState) {
                // Keep state for a container with an unresolved crash so Auto-Heal can
                // still act on it past the default stale window (policy thresholds run
                // up to 24h). It is cleared on `start` and removed on `destroy`.
                if (state.crashedAt !== undefined) continue;
                if (state.lastActivityAt < cutoff) {
                    this.containerState.delete(id);
                }
            }
        }
        // Health dedup lives outside containerState so the 60m window survives
        // ordinary 10m prune. Drop only entries whose window has fully expired.
        if (this.healthAlertDedupAt.size > 0) {
            const dedupCutoff = Date.now() - HEALTH_DEDUP_MS;
            for (const [id, at] of this.healthAlertDedupAt) {
                if (at < dedupCutoff) this.healthAlertDedupAt.delete(id);
            }
        }
        // Start evidence only matters while a crash dedup window it could lift
        // is open, so it expires with that window.
        if (this.lastStartEventAt.size > 0) {
            const startCutoff = Date.now() - CRASH_DEDUP_MS;
            for (const [id, at] of this.lastStartEventAt) {
                if (at < startCutoff) this.lastStartEventAt.delete(id);
            }
        }
        // Run history and consumed incident keys prune by wall-clock arrival,
        // not by event time: supported event timestamps can be second-resolution
        // or historical, but the dedup window is measured against the clock.
        const runCutoff = Date.now() - CRASH_DEDUP_MS;
        if (this.containerRuns.size > 0) {
            for (const [id, runs] of this.containerRuns) {
                const kept = runs.filter(run => run.observedAt >= runCutoff);
                if (kept.length === 0) this.containerRuns.delete(id);
                else if (kept.length !== runs.length) this.containerRuns.set(id, kept);
            }
        }
        for (const state of this.containerState.values()) {
            if (!state.alertedIncidentKeys) continue;
            for (const [key, at] of state.alertedIncidentKeys) {
                if (at < runCutoff) state.alertedIncidentKeys.delete(key);
            }
        }
    }

    // ========================================================================
    // Notification wrappers (node-neutral bodies; hub bell badges remotes)
    // ========================================================================

    private buildAlertOptions(
        stackName?: string,
        containerName?: string,
        systemOnly = false,
        serviceName?: string,
    ): { stackName?: string; containerName?: string; actor: string; serviceName?: string; nodeId: number } {
        // The node id travels with the alert so its routing keys are read from
        // the stack that actually raised it, never from whichever node is default.
        if (systemOnly) return { actor: 'system:docker-events', nodeId: this.nodeId };
        return {
            stackName,
            containerName,
            actor: 'system:docker-events',
            nodeId: this.nodeId,
            ...(serviceName ? { serviceName } : {}),
        };
    }

    private async emitError(category: NotificationCategory, message: string, stackName?: string, containerName?: string, systemOnly = false, serviceName?: string): Promise<{ persisted: boolean }> {
        return this.notifier.dispatchAlert('error', category, message, this.buildAlertOptions(stackName, containerName, systemOnly, serviceName));
    }

    private async emitWarning(category: NotificationCategory, message: string, stackName?: string, containerName?: string): Promise<{ persisted: boolean }> {
        return this.notifier.dispatchAlert('warning', category, message, this.buildAlertOptions(stackName, containerName));
    }

    private async emitInfo(category: NotificationCategory, message: string, stackName?: string, containerName?: string): Promise<{ persisted: boolean }> {
        return this.notifier.dispatchAlert('info', category, message, this.buildAlertOptions(stackName, containerName));
    }

    // ========================================================================
    // Diagnostics
    // ========================================================================

    public getStatus(): {
        nodeId: number;
        nodeName: string;
        status: LifecycleStatus;
        reconnectAttempts: number;
        trackedContainers: number;
    } {
        return {
            nodeId: this.nodeId,
            nodeName: this.nodeName,
            status: this.status,
            reconnectAttempts: this.reconnectAttempts,
            trackedContainers: this.containerState.size,
        };
    }

    // ========================================================================
    // Container state accessors (used by AutoHealService)
    // ========================================================================

    public listContainerStates(): ContainerHealthSnapshot[] {
        return Array.from(this.containerState.entries()).map(([id, s]) => ({
            id,
            name: s.name,
            stackName: s.stackName,
            healthStatus: s.healthStatus,
            unhealthySince: s.unhealthySince,
            lastKillAt: s.lastKillAt,
        }));
    }

    public getContainerState(id: string): ContainerHealthSnapshot | undefined {
        const s = this.containerState.get(id);
        if (!s) return undefined;
        return {
            id,
            name: s.name,
            stackName: s.stackName,
            healthStatus: s.healthStatus,
            unhealthySince: s.unhealthySince,
            lastKillAt: s.lastKillAt,
            crashedAt: s.crashedAt,
        };
    }
}
