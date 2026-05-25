import Docker from 'dockerode';
import { NodeRegistry } from './NodeRegistry';
import { NotificationCategory, NotificationService } from './NotificationService';
import { DatabaseService } from './DatabaseService';
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
}

/** Grace window after a `die` before classifying, to absorb out-of-order kill events. */
const DIE_GRACE_WINDOW_MS = 500;

/** Max crash alerts emitted per node within RATE_WINDOW_MS. Overflow is batched. */
const RATE_LIMIT_MAX = 20;
const RATE_WINDOW_MS = 60_000;

/** Dedup window for repeat crash alerts of the same container. */
const CRASH_DEDUP_MS = 60 * 60_000;

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
    lastCrashAlertAt?: number;
    lastActivityAt: number;
    healthStatus?: 'healthy' | 'unhealthy' | 'starting';
    unhealthySince?: number;
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

    /** Rate-limiter bookkeeping. */
    private rateWindowStart = 0;
    private rateCount = 0;
    private suppressedCount = 0;
    private summaryTimer: NodeJS.Timeout | null = null;

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
            if (classification === 'clean' || classification === 'intentional') return;

            const name = inspect.Name?.replace(/^\//, '') ?? containerId.slice(0, 12);
            const stackName = inspect.Config?.Labels?.[COMPOSE_PROJECT_LABEL];
            const exitCode = inspect.State?.ExitCode ?? 0;

            // Gap exits have no in-memory state, so there's no dedup to bump.
            await this.emitClassification(classification, null, { name, exitCode, stackName });
        } catch (err) {
            if (isDebugEnabled()) {
                console.log(`[DockerEvents:${this.nodeName}:diag] gap inspect failed:`,
                    err instanceof Error ? err.message : err);
            }
        }
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

        // Normalize: `health_status: unhealthy` -> base action
        const baseAction = action.startsWith('health_status') ? 'health_status' : action;

        // Push a lightweight state-invalidate signal so connected UIs can
        // refetch stack statuses immediately on a real container event,
        // without waiting for the next polling tick. This is fire-and-forget
        // and is NOT persisted to the alerts history.
        if (STATE_INVALIDATE_ACTIONS.has(baseAction)) {
            this.notifier.broadcastEvent({
                type: 'state-invalidate',
                scope: 'stack',
                nodeId: this.nodeId,
                stackName: event.Actor?.Attributes?.[COMPOSE_PROJECT_LABEL] ?? null,
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
                return this.onStart(id);
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
        // Defer classification to absorb out-of-order kill events.
        const existing = this.pendingDieTimers.get(id);
        if (existing) clearTimeout(existing);
        const timer = setTimeout(() => {
            this.pendingDieTimers.delete(id);
            void this.classifyDie(id, event);
        }, DIE_GRACE_WINDOW_MS);
        this.pendingDieTimers.set(id, timer);
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
            if (state.healthStatus !== 'unhealthy') {
                state.unhealthySince = Date.now();
            }
            state.healthStatus = 'unhealthy';
            if (!this.isCrashAlertsEnabled()) return;
            const name = state.name ?? id.slice(0, 12);
            const stackName = state.stackName;
            void this.emitError(
                'monitor_alert',
                `Healthcheck failed: ${name} is unhealthy.`,
                stackName,
                state.name,
            );
        } else {
            state.unhealthySince = undefined;
            if (action.includes('starting')) {
                state.healthStatus = 'starting';
            } else {
                state.healthStatus = 'healthy';
            }
        }
    }

    private onStart(id: string): void {
        const state = this.containerState.get(id);
        if (!state) return;
        // Container came back: clear transient flags but keep identity.
        state.lastKillAt = undefined;
        state.oomPending = undefined;
        state.lastCrashAlertAt = undefined;
        state.unhealthySince = undefined;
        state.healthStatus = 'starting';
        state.lastActivityAt = Date.now();
    }

    private onDestroy(id: string): void {
        this.containerState.delete(id);
        const pending = this.pendingDieTimers.get(id);
        if (pending) {
            clearTimeout(pending);
            this.pendingDieTimers.delete(id);
        }
    }

    private async classifyDie(id: string, event: DockerEventPayload): Promise<void> {
        const state = this.getOrCreateState(id, event);
        const exitCodeStr = event.Actor?.Attributes?.exitCode;
        const parsedExit = exitCodeStr !== undefined ? parseInt(exitCodeStr, 10) : undefined;
        const exitCode = Number.isFinite(parsedExit) ? (parsedExit as number) : undefined;
        const now = Date.now();

        let classification = classifyDie(
            { at: this.eventTimeMs(event), exitCode },
            { lastKillAt: state.lastKillAt, oomPending: state.oomPending },
        );

        // Die arrived: clear the oom flag regardless (we've now used it).
        state.oomPending = undefined;
        state.lastActivityAt = now;

        if (classification === 'intentional' || classification === 'clean') return;

        // Dedup early: crashloops repeatedly reach this point with exit 137,
        // and the OOM fallback below issues a Docker inspect. Skipping the
        // inspect on deduped crashes avoids hammering the daemon.
        if (state.lastCrashAlertAt && now - state.lastCrashAlertAt < CRASH_DEDUP_MS) {
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

        await this.emitClassification(classification, state, {
            name: state.name ?? id.slice(0, 12),
            exitCode: exitCode ?? 0,
            stackName: state.stackName,
        });
    }

    // ========================================================================
    // Alert emission + rate limiting
    // ========================================================================

    private async emitClassification(
        classification: Classification,
        state: InternalContainerState | null,
        info: { name: string; exitCode: number; stackName?: string },
    ): Promise<void> {
        // Respect the existing global crash-alerts toggle so users who have
        // disabled these notifications in Settings remain opted out.
        if (!this.isCrashAlertsEnabled()) return;

        const message = classification === 'oom'
            ? `Container OOM Kill: ${info.name} was killed by the OOM killer (out of memory).`
            : `Container Crash Detected: ${info.name} exited unexpectedly (Code: ${info.exitCode}).`;

        if (!this.consumeRateToken()) {
            this.suppressedCount += 1;
            this.scheduleSummary();
            return;
        }

        // Stamp the dedup clock only after the alert is actually dispatched, so
        // rate-suppressed alerts don't silently lock out the next real crash.
        if (state) state.lastCrashAlertAt = Date.now();

        await this.emitError('monitor_alert', message, info.stackName, info.name);
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

    /** Return true if an alert can be emitted now. Side effect: increments counters. */
    private consumeRateToken(): boolean {
        const now = Date.now();
        if (now - this.rateWindowStart >= RATE_WINDOW_MS) {
            this.rateWindowStart = now;
            this.rateCount = 0;
        }
        if (this.rateCount >= RATE_LIMIT_MAX) return false;
        this.rateCount += 1;
        return true;
    }

    private scheduleSummary(): void {
        if (this.summaryTimer) return;
        const remaining = RATE_WINDOW_MS - (Date.now() - this.rateWindowStart);
        const delay = Math.max(1_000, remaining);
        this.summaryTimer = setTimeout(() => {
            const count = this.suppressedCount;
            this.summaryTimer = null;
            this.suppressedCount = 0;
            if (count > 0) {
                void this.emitWarning(
                    'monitor_alert',
                    `${count} additional containers crashed in the last minute.`,
                );
            }
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
            const project = attrs[COMPOSE_PROJECT_LABEL];
            if (project && !state.stackName) state.stackName = project;
        }
        return state;
    }

    private eventTimeMs(event: DockerEventPayload): number {
        if (typeof event.timeNano === 'number') return Math.floor(event.timeNano / 1_000_000);
        if (typeof event.time === 'number') return event.time * 1000;
        return Date.now();
    }

    private pruneStaleState(): void {
        if (this.containerState.size === 0) return;
        const cutoff = Date.now() - STATE_STALE_AFTER_MS;
        for (const [id, state] of this.containerState) {
            if (state.lastActivityAt < cutoff) {
                this.containerState.delete(id);
            }
        }
    }

    // ========================================================================
    // Notification wrappers (prefix with node name for multi-node clarity)
    // ========================================================================

    private async emitError(category: NotificationCategory, message: string, stackName?: string, containerName?: string): Promise<void> {
        return this.notifier.dispatchAlert('error', category, this.prefix(message), { stackName, containerName, actor: 'system:docker-events' });
    }

    private async emitWarning(category: NotificationCategory, message: string, stackName?: string, containerName?: string): Promise<void> {
        return this.notifier.dispatchAlert('warning', category, this.prefix(message), { stackName, containerName, actor: 'system:docker-events' });
    }

    private async emitInfo(category: NotificationCategory, message: string, stackName?: string, containerName?: string): Promise<void> {
        return this.notifier.dispatchAlert('info', category, this.prefix(message), { stackName, containerName, actor: 'system:docker-events' });
    }

    private prefix(message: string): string {
        return `[Node: ${this.nodeName}] ${message}`;
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
        };
    }
}
