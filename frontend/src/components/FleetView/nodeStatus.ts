import type { StatusTone } from '@/lib/statusTone';
import { formatTimeAgo } from '@/lib/relativeTime';
import { formatVersion } from '@/lib/version';
import { getNodeCpu, getNodeDisk, isCritical } from './nodeUtils';
import type { FleetNode, NodeUpdateStatus } from './types';

/** The one resolving verb an Answer can carry. Whether the session may run it is the caller's call. */
export type NodeVerbId =
    | 'test-connection'
    | 'update'
    | 'update-dev'
    | 'retry-update'
    | 'open-gitops'
    | 'view-networking'
    | 'uncordon';

export interface NodeVerb {
    id: NodeVerbId;
    label: string;
}

/** A state that needs attention (or is worth noting). Healthy is the absence of these. */
export type ActiveConditionKind =
    | 'offline'
    | 'reconnecting'
    | 'critical'
    | 'update-failed'
    | 'updating'
    | 'gitops'
    | 'update-dev'
    | 'update-available'
    | 'update-pinned'
    | 'networking'
    | 'cordoned';

export type NodeConditionKind = ActiveConditionKind | 'healthy';

/** The conditions that describe an update, in the order the version stage reads them. */
type UpdateConditionKind = Extract<ActiveConditionKind, 'update-failed' | 'updating' | 'update-dev' | 'update-available' | 'update-pinned'>;

export interface NodeCondition<K extends NodeConditionKind = NodeConditionKind> {
    readonly kind: K;
    readonly tone: StatusTone;
    /** Short state name, shown as the card chip and the sheet Answer title. */
    readonly title: string;
    /** One sentence saying what is true. */
    readonly line: string;
    readonly verb?: NodeVerb;
}

export type NodeStageId = 'connection' | 'resources' | 'workload' | 'version' | 'scheduling' | 'gitops' | 'networking';

export interface NodeStatusStage {
    id: NodeStageId;
    label: string;
    tone: StatusTone;
    word: string;
    /** The sentence behind a blocking stage the Answer does not speak for. */
    line?: string;
}

export interface NetworkingSignal {
    exposed: boolean;
    unknown: boolean;
    drift: boolean;
}

export interface NodeStatusInput {
    node: FleetNode;
    isPilot: boolean;
    updateStatus?: NodeUpdateStatus;
    gitopsAttention?: number;
    networking?: NetworkingSignal;
}

export interface NodeStatus {
    /** The loudest thing that is true of this node, or Healthy. */
    readonly answer: NodeCondition;
    /** Every condition that holds, loudest first, never including Healthy. */
    readonly conditions: readonly NodeCondition<ActiveConditionKind>[];
    /** How many conditions the Answer does not speak for. */
    readonly otherCount: number;
    /** The quiet Path: only the stages that apply to this node. */
    readonly stages: readonly NodeStatusStage[];
}

/** Loudest first. An unreachable node outranks everything, a cordon is the quietest note. */
const PRIORITY: Record<ActiveConditionKind, number> = {
    offline: 0,
    reconnecting: 1,
    critical: 2,
    'update-failed': 3,
    updating: 4,
    gitops: 5,
    'update-dev': 6,
    'update-available': 7,
    'update-pinned': 8,
    networking: 9,
    cordoned: 10,
};

const HEALTHY: NodeCondition<'healthy'> = Object.freeze({
    kind: 'healthy',
    tone: 'success',
    title: 'Healthy',
    line: 'Reachable and nothing needs attention.',
});

const TEST_CONNECTION: NodeVerb = { id: 'test-connection', label: 'Test connection' };

/** FleetNode timestamps are Unix seconds; the relative-time formatter takes milliseconds. */
function secondsAgo(seconds: number | null | undefined): string | null {
    return seconds ? formatTimeAgo(seconds * 1000) : null;
}

function offlineCondition(node: FleetNode, isPilot: boolean): NodeCondition<ActiveConditionKind> {
    let line = 'Docker is unreachable on this host.';
    if (node.type !== 'local') {
        const seen = secondsAgo(isPilot ? node.pilot_last_seen : node.last_successful_contact);
        const what = isPilot ? 'Pilot disconnected' : 'Proxy unreachable';
        const when = seen ? ` · ${isPilot ? 'last seen' : 'last contact'} ${seen}` : ' · never connected';
        line = `${what}${when}`;
    }
    return { kind: 'offline', tone: 'destructive', title: 'Offline', line, verb: TEST_CONNECTION };
}

function criticalLine(node: FleetNode): string {
    const cpu = getNodeCpu(node);
    const disk = getNodeDisk(node);
    const parts: string[] = [];
    if (cpu > 90) parts.push(`CPU ${cpu.toFixed(0)}%`);
    if (disk > 90) parts.push(`disk ${disk.toFixed(0)}%`);
    return `${parts.join(' and ')} is above the critical threshold.`;
}

function hasNetworkingSignal(signal: NetworkingSignal | undefined): signal is NetworkingSignal {
    return Boolean(signal && (signal.exposed || signal.unknown || signal.drift));
}

function networkingWord(signal: NetworkingSignal): string {
    return signal.drift ? 'drift' : signal.exposed ? 'exposed' : 'unknown exposure';
}

/**
 * A failed or running update is a control-plane record, not a reading from the
 * node, so it stays true while the node is offline (a node restarting into an
 * update is offline by design) and its error and retry must stay reachable.
 */
function updateProgressConditions(status: NodeUpdateStatus): NodeCondition<ActiveConditionKind>[] {
    if (status.updateStatus === 'failed' || status.updateStatus === 'timeout') {
        const timedOut = status.updateStatus === 'timeout';
        return [{
            kind: 'update-failed',
            tone: 'destructive',
            title: timedOut ? 'Update timed out' : 'Update failed',
            line: status.error ?? (timedOut ? 'The node did not come back in time.' : 'The update did not complete.'),
            verb: { id: 'retry-update', label: 'Retry update' },
        }];
    }
    if (status.updateStatus === 'updating') {
        return [{ kind: 'updating', tone: 'brand', title: 'Updating', line: 'An update is in progress.' }];
    }
    return [];
}

/** An update the operator can start. Only meaningful for a node that is reachable now. */
function updateOfferConditions(status: NodeUpdateStatus): NodeCondition<ActiveConditionKind>[] {
    const conditions: NodeCondition<ActiveConditionKind>[] = [];
    const latest = formatVersion(status.latestVersion);

    if (status.devBuildUpdateAvailable && !status.updateStatus) {
        conditions.push({
            kind: 'update-dev',
            tone: 'warning',
            title: 'New dev build',
            line: 'A newer integration build is available.',
            verb: { id: 'update-dev', label: 'Update dev build' },
        });
    }

    const available = status.updateAvailable && !status.updateStatus && !status.skipActive;
    const pinned = Boolean(status.updateBlocked) && status.imageChannel !== 'hardened';
    if (available && !pinned) {
        conditions.push({
            kind: 'update-available',
            tone: 'warning',
            title: 'Update available',
            line: latest ? `Sencho ${latest} is available.` : 'A newer Sencho release is available.',
            verb: { id: 'update', label: latest ? `Update to ${latest}` : 'Update' },
        });
    } else if (available && pinned) {
        conditions.push({
            kind: 'update-pinned',
            tone: 'neutral',
            title: 'Update pinned',
            line: status.updateBlockedReason ?? 'This node cannot be updated automatically while its image is pinned this way.',
        });
    }
    return conditions;
}

const UPDATE_STAGE_WORD: Record<UpdateConditionKind, string> = {
    'update-failed': 'update failed',
    updating: 'updating',
    'update-dev': 'integration image',
    'update-available': 'update available',
    'update-pinned': 'pinned',
};

function isUpdateCondition(condition: NodeCondition<ActiveConditionKind>): condition is NodeCondition<UpdateConditionKind> {
    return condition.kind in UPDATE_STAGE_WORD;
}

function versionStage(status: NodeUpdateStatus, conditions: readonly NodeCondition<ActiveConditionKind>[]): NodeStatusStage {
    const base = { id: 'version', label: 'version' } as const;
    const update = conditions.find(isUpdateCondition);
    if (update) {
        const blocking = update.kind === 'update-failed';
        return { ...base, tone: update.tone, word: UPDATE_STAGE_WORD[update.kind], ...(blocking ? { line: update.line } : {}) };
    }
    if (status.isDevImage) return { ...base, tone: 'warning', word: 'integration image' };
    if (status.updateAvailable && status.skipActive) return { ...base, tone: 'neutral', word: 'update skipped' };
    return { ...base, tone: 'success', word: 'up to date' };
}

/**
 * One model of a node's state, read by the Fleet card and the details sheet so
 * the two never disagree. The Answer is the loudest condition that holds; the
 * rest are counted, not restated. An offline node reports only its connection
 * and scheduling, because every other reading about it is stale.
 */
export function deriveNodeStatus({ node, isPilot, updateStatus, gitopsAttention = 0, networking }: NodeStatusInput): NodeStatus {
    const online = node.status === 'online';
    const conditions: NodeCondition<ActiveConditionKind>[] = [];
    const stages: NodeStatusStage[] = [];

    // Online with no readings at all is a Pilot inside its reconnect grace window.
    const reconnecting = online && node.type === 'remote' && node.stats === null && node.systemStats === null;

    if (!online) {
        conditions.push(offlineCondition(node, isPilot));
    } else if (reconnecting) {
        const seen = secondsAgo(node.pilot_last_seen);
        conditions.push({
            kind: 'reconnecting',
            tone: 'warning',
            title: 'Reconnecting',
            line: seen ? `The tunnel closed ${seen}; waiting for the agent to reconnect.` : 'Waiting for the agent to reconnect.',
            verb: TEST_CONNECTION,
        });
    } else {
        if (isCritical(node)) {
            conditions.push({ kind: 'critical', tone: 'destructive', title: 'Critical', line: criticalLine(node) });
        }
        if (updateStatus) conditions.push(...updateOfferConditions(updateStatus));
        if (gitopsAttention > 0) {
            conditions.push({
                kind: 'gitops',
                tone: 'warning',
                title: 'GitOps',
                line: `${gitopsAttention} ${gitopsAttention === 1 ? 'application needs' : 'applications need'} attention on this node.`,
                verb: { id: 'open-gitops', label: 'Open GitOps' },
            });
        }
        if (hasNetworkingSignal(networking)) {
            conditions.push({
                kind: 'networking',
                tone: 'warning',
                title: 'Networking',
                line: `Networking: ${networkingWord(networking)}.`,
                verb: { id: 'view-networking', label: 'View networking' },
            });
        }
    }
    // Whatever the connection, the control plane's own update record stays true.
    if (updateStatus) conditions.push(...updateProgressConditions(updateStatus));
    if (node.cordoned) {
        conditions.push({
            kind: 'cordoned',
            tone: 'neutral',
            title: 'Cordoned',
            line: node.cordoned_reason ?? 'New Blueprint deployments skip this node.',
            verb: { id: 'uncordon', label: 'Uncordon node' },
        });
    }

    conditions.sort((a, b) => PRIORITY[a.kind] - PRIORITY[b.kind]);

    if (node.type === 'remote') {
        stages.push({
            id: 'connection',
            label: 'connection',
            tone: !online ? 'destructive' : reconnecting ? 'warning' : 'success',
            word: !online ? 'offline' : reconnecting ? 'reconnecting' : 'connected',
        });
    }
    if (online && !reconnecting) {
        if (node.systemStats) {
            const critical = isCritical(node);
            stages.push({ id: 'resources', label: 'resources', tone: critical ? 'destructive' : 'success', word: critical ? 'critical' : 'normal' });
        }
        if (node.stats) {
            const word = node.stats.exited > 0
                ? `${node.stats.active} running · ${node.stats.exited} stopped`
                : `${node.stats.active} running`;
            stages.push({ id: 'workload', label: 'workload', tone: 'neutral', word });
        }
        if (updateStatus) stages.push(versionStage(updateStatus, conditions));
        if (gitopsAttention > 0) stages.push({ id: 'gitops', label: 'gitops', tone: 'warning', word: `${gitopsAttention} need attention` });
        if (hasNetworkingSignal(networking)) {
            stages.push({ id: 'networking', label: 'networking', tone: 'warning', word: networkingWord(networking) });
        }
    }
    // A node with no readings still reports a failed or running update on the Path.
    if (!(online && !reconnecting) && updateStatus && conditions.some(isUpdateCondition)) {
        stages.push(versionStage(updateStatus, conditions));
    }
    if (node.cordoned) stages.push({ id: 'scheduling', label: 'scheduling', tone: 'neutral', word: 'cordoned' });

    const answer = conditions[0] ?? HEALTHY;
    return { answer, conditions, otherCount: Math.max(0, conditions.length - 1), stages };
}
