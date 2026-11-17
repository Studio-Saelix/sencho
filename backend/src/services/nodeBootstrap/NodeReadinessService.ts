import crypto from 'crypto';
import axios from 'axios';
import { parseReadinessReport, READINESS_PATH } from '../../pilot/readinessContract';
import { getErrorMessage } from '../../utils/errors';
import { safeAxiosTransport } from '../../utils/outboundTarget';
import { sanitizeForLog } from '../../utils/safeLog';
import { DatabaseService, type NodeBootstrapEventStatus, type NodeReadinessRow, type NodeReadinessState } from '../DatabaseService';
import { NotificationService } from '../NotificationService';
import { PilotEnrollmentAttempts } from '../PilotEnrollmentAttempts';
import { PilotTunnelManager } from '../PilotTunnelManager';
import { getSenchoVersion } from '../CapabilityRegistry';
import { recordBootstrapAudit, type BootstrapAuditContext } from './audit';
import {
  evaluateReadiness,
  readinessWithoutReport,
  type ReadinessGate,
  type ReadinessResult,
} from './readinessGates';

/**
 * Verified readiness for nodes the bootstrap registered.
 *
 * A connected tunnel proves only that an agent holds a credential. This
 * service asks the agent, through that tunnel, for a fresh readiness report
 * (`pilot/readinessContract.ts`) and judges it (`readinessGates.ts`); the
 * node is `ready` only when no gate on that answer failed or was unknown
 * (warnings do not block).
 *
 * When it runs: on every tunnel-up for a bootstrapped node (first
 * enrollment, a reconnect after an agent restart, self-update, host reboot or
 * hub restart, and a re-enrollment), and when an admin asks to verify again.
 * There is no poller. A check is one bounded HTTP request; checks for one node
 * never overlap, and a check requested while one runs makes that check run
 * once more when it ends (up to MAX_RERUNS), so the stored verdict normally
 * describes the newest tunnel. A dropped tunnel, or a hub start, puts a ready
 * node back to provisional until the next check. Nodes enrolled by hand have
 * no readiness row and are never checked, so their connection status means
 * what it always meant.
 */

export const READINESS_TIMEOUT_MS = 15_000;
/** A run of tunnel flaps can ask for many reruns; past this the last result stands until the next tunnel-up. */
const MAX_RERUNS = 3;

interface InflightCheck {
  promise: Promise<NodeReadinessView | null>;
  rerun: boolean;
  /** Whose request the next run answers; an administrator joining a reconnect check takes it over. */
  audit: BootstrapAuditContext;
}

export interface NodeReadinessView {
  state: NodeReadinessState;
  operationId: string | null;
  checkedAt: number | null;
  agentVersion: string | null;
  gates: ReadinessGate[];
}

interface ReadinessTunnelPort {
  hasActiveTunnel(nodeId: number): boolean;
  getLoopbackUrl(nodeId: number): string | null;
  isTunnelConfidential(nodeId: number): boolean;
  on(event: 'tunnel-up' | 'tunnel-down', listener: (nodeId: number) => void): unknown;
  off(event: 'tunnel-up' | 'tunnel-down', listener: (nodeId: number) => void): unknown;
}

export type ReadinessFetch = (url: string, signal: AbortSignal) => Promise<{ status: number; body: unknown }>;

interface ReadinessDeps {
  db: DatabaseService;
  tunnels: ReadinessTunnelPort;
  fetch: ReadinessFetch;
  now: () => number;
  nonce: () => string;
  /** Tell open dashboards a node's readiness changed, so node lists refetch instead of showing a stale verdict. */
  changed: (nodeId: number) => void;
  /** What the hub saw when this node's Pilot was refused, to say why a tunnel is down when it can. */
  attempts: Pick<PilotEnrollmentAttempts, 'lastRefusal'>;
  timeoutMs: number;
}

const SYSTEM_AUDIT: BootstrapAuditContext = { username: 'system', ip: 'local', method: 'TUNNEL', path: 'node_readiness' };

const realFetch: ReadinessFetch = async (url, signal) => {
  const response = await axios.get(url, {
    ...safeAxiosTransport(true),
    signal,
    validateStatus: () => true,
    responseType: 'json',
    maxContentLength: 256 * 1024,
  });
  return { status: response.status, body: response.data };
};

const GATE_STATUSES: ReadonlySet<string> = new Set(['pass', 'warn', 'fail', 'unknown']);

function isStoredGate(value: unknown): value is ReadinessGate {
  if (!value || typeof value !== 'object') return false;
  const gate = value as Record<string, unknown>;
  if (typeof gate.id !== 'string' || typeof gate.label !== 'string' || typeof gate.summary !== 'string') return false;
  if (typeof gate.status !== 'string' || !GATE_STATUSES.has(gate.status)) return false;
  return gate.status === 'pass' || typeof gate.remediation === 'string';
}

/** The stored gates, or null when they cannot be read back as gates. */
function parseGates(json: string | null): ReadinessGate[] | null {
  if (!json) return [];
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) && parsed.every(isStoredGate) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * The state a reader may rely on. A verdict of ready is only as good as the
 * evidence stored with it: unreadable or missing gates, or a stored failure,
 * do not read as ready. Readers must go through this.
 */
export function effectiveReadinessState(row: Pick<NodeReadinessRow, 'state' | 'gates_json'>): NodeReadinessState {
  if (row.state !== 'ready') return row.state;
  const gates = parseGates(row.gates_json);
  const proven = gates !== null && gates.length > 0 && gates.every((gate) => gate.status === 'pass' || gate.status === 'warn');
  return proven ? 'ready' : 'not_ready';
}

export function readinessView(row: NodeReadinessRow): NodeReadinessView {
  const gates = parseGates(row.gates_json);
  // Only a ready verdict changes meaning when its gates cannot be read. The node list reads rows
  // directly and does not come through here, but get() does (run views, Verify), so this repeats on
  // each such read until the next check rewrites the row.
  if (gates === null && row.state === 'ready') {
    console.warn(`[Readiness] Node ${row.node_id} has a ready verdict whose stored gates cannot be read; it reads as not ready.`);
  }
  return {
    state: effectiveReadinessState(row),
    operationId: row.operation_id,
    checkedAt: row.checked_at,
    agentVersion: row.agent_version,
    gates: gates ?? [],
  };
}

export class NodeReadinessService {
  private static instance: NodeReadinessService | null = null;
  private readonly deps: ReadinessDeps;
  private readonly inflight = new Map<number, InflightCheck>();
  private started = false;
  private readonly onTunnelUp = (nodeId: number): void => {
    // Deferred to a macrotask so the bootstrap run's own tunnel-up continuation (which marks the run enrolled) runs first.
    setImmediate(() => {
      try {
        if (!this.deps.db.getNodeReadiness(nodeId)) return;
      } catch (error: unknown) {
        console.error(`[Readiness] Node ${nodeId} readiness could not be read:`, sanitizeForLog(getErrorMessage(error, 'unknown')));
        return;
      }
      this.verify(nodeId, SYSTEM_AUDIT).catch((error: unknown) => {
        console.error(`[Readiness] Check for node ${nodeId} failed:`, sanitizeForLog(getErrorMessage(error, 'unknown')));
      });
    });
  };

  private readonly onTunnelDown = (nodeId: number): void => {
    try {
      if (this.deps.db.demoteNodeReadinessOnDisconnect(nodeId, this.deps.now())) this.announce(nodeId);
    } catch (error: unknown) {
      console.error(`[Readiness] Node ${nodeId} could not be marked disconnected:`, sanitizeForLog(getErrorMessage(error, 'unknown')));
    }
  };

  public constructor(deps: Partial<ReadinessDeps> = {}) {
    this.deps = {
      db: DatabaseService.getInstance(),
      tunnels: PilotTunnelManager.getInstance(),
      fetch: realFetch,
      now: () => Date.now(),
      nonce: () => crypto.randomBytes(16).toString('hex'),
      changed: (nodeId) => NotificationService.getInstance().broadcastEvent({ type: 'state-invalidate', scope: 'node-readiness', nodeId }),
      attempts: PilotEnrollmentAttempts.getInstance(),
      timeoutMs: READINESS_TIMEOUT_MS,
      ...deps,
    };
  }

  public static getInstance(): NodeReadinessService {
    if (!NodeReadinessService.instance) NodeReadinessService.instance = new NodeReadinessService();
    return NodeReadinessService.instance;
  }

  /**
   * Subscribe to tunnel-up, and settle checks a hub restart cut short: a row
   * left `verifying` has no check behind it, so it is recorded as not ready
   * until the agent reconnects and is checked again.
   */
  public start(): void {
    if (this.started) return;
    this.started = true;
    try {
      // Runs before the server accepts connections, so no tunnel is up: nothing is known to be ready yet.
      this.deps.db.demoteReadyNodeReadiness(this.deps.now());
    } catch (error: unknown) {
      console.error('[Readiness] Ready nodes could not be reset at startup:', sanitizeForLog(getErrorMessage(error, 'unknown')));
    }
    for (const row of this.deps.db.listNodeReadiness()) {
      if (row.state !== 'verifying') continue;
      try {
        this.record(row.node_id, row.operation_id, readinessWithoutReport({ kind: 'unreachable', message: 'the hub restarted during the check.' }), null);
      } catch (error: unknown) {
        console.error(`[Readiness] Node ${row.node_id} could not be settled:`, sanitizeForLog(getErrorMessage(error, 'unknown')));
      }
    }
    this.deps.tunnels.on('tunnel-up', this.onTunnelUp);
    this.deps.tunnels.on('tunnel-down', this.onTunnelDown);
  }

  public stop(): void {
    if (!this.started) return;
    this.started = false;
    this.deps.tunnels.off('tunnel-up', this.onTunnelUp);
    this.deps.tunnels.off('tunnel-down', this.onTunnelDown);
  }

  /** Test hook: wait for every check in flight. */
  public async settled(): Promise<void> {
    await Promise.all([...this.inflight.values()].map((entry) => entry.promise.catch(() => null)));
  }

  public get(nodeId: number): NodeReadinessView | null {
    const row = this.deps.db.getNodeReadiness(nodeId);
    return row ? readinessView(row) : null;
  }

  /**
   * Check a bootstrapped node now. Resolves with its stored readiness, or null
   * when the node has no readiness row (it was not bootstrapped). A call while
   * a check runs joins it and makes it run once more.
   */
  public verify(nodeId: number, audit: BootstrapAuditContext): Promise<NodeReadinessView | null> {
    const current = this.inflight.get(nodeId);
    if (current) {
      current.rerun = true;
      // An administrator who asks while a reconnect check runs gets the rerun recorded as theirs.
      if (audit !== SYSTEM_AUDIT) current.audit = audit;
      return current.promise;
    }
    const entry: InflightCheck = { promise: Promise.resolve(null), rerun: false, audit };
    entry.promise = (async () => {
      // Yield once so the entry is registered before the first check reaches the Pilot: a request made meanwhile joins it.
      await Promise.resolve();
      try {
        let view: NodeReadinessView | null;
        let runs = 0;
        do {
          entry.rerun = false;
          view = await this.checkOnce(nodeId, entry.audit);
          runs += 1;
        } while (entry.rerun && view !== null && runs <= MAX_RERUNS);
        return view;
      } finally {
        // Synchronous with the last loop test, so no request can join an entry that will not run again.
        this.inflight.delete(nodeId);
      }
    })();
    this.inflight.set(nodeId, entry);
    return entry.promise;
  }

  private async checkOnce(nodeId: number, audit: BootstrapAuditContext): Promise<NodeReadinessView | null> {
    const row = this.deps.db.getNodeReadiness(nodeId);
    if (!row) return null;
    const operationId = row.operation_id;
    if (!this.deps.db.markNodeReadinessVerifying(nodeId, operationId, this.deps.now())) return this.get(nodeId);
    this.announce(nodeId);
    let outcome: { result: ReadinessResult; agentVersion: string | null };
    try {
      outcome = await this.ask(nodeId, row);
    } catch (error: unknown) {
      // A check that broke on the hub must not leave the row verifying with no way out.
      const reason = sanitizeForLog(getErrorMessage(error, 'unknown'));
      console.error(`[Readiness] Check for node ${nodeId} broke on the hub:`, reason);
      const message = `the hub could not finish the check (${reason.slice(0, 200)}).`;
      outcome = { result: readinessWithoutReport({ kind: 'unreachable', message }), agentVersion: null };
    }
    const { result, agentVersion } = outcome;
    // A retry's new enrollment, a dropped tunnel or a removed node changed the row while the Pilot answered: this answer is stale and is dropped.
    if (!this.record(nodeId, operationId, result, agentVersion)) return this.get(nodeId);
    // A reconnect that confirms this enrollment's last verdict is not news (a dropped tunnel demotes the state, not the verdict); an asked-for check, or a changed verdict, is recorded.
    if (audit === SYSTEM_AUDIT && row.verdict === result.verdict) return this.get(nodeId);
    this.note(row, result);
    recordBootstrapAudit(this.deps.db, this.deps.now(), audit, 'bootstrap.readiness.checked', {
      node: nodeId,
      operation: operationId,
      verdict: result.verdict,
      failed: result.gates.filter((gate) => gate.status === 'fail' || gate.status === 'unknown').map((gate) => gate.id),
    }, 200);
    return this.get(nodeId);
  }

  private async ask(nodeId: number, row: NodeReadinessRow): Promise<{ result: ReadinessResult; agentVersion: string | null }> {
    const loopback = this.deps.tunnels.hasActiveTunnel(nodeId) ? this.deps.tunnels.getLoopbackUrl(nodeId) : null;
    if (!loopback) {
      const refusal = this.deps.attempts.lastRefusal(nodeId)?.reason;
      return { result: readinessWithoutReport({ kind: 'not_connected', refusal }), agentVersion: null };
    }
    const nonce = this.deps.nonce();
    const requestedAt = this.deps.now();
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), this.deps.timeoutMs);
    let response: { status: number; body: unknown };
    try {
      response = await this.deps.fetch(`${loopback.replace(/\/$/, '')}${READINESS_PATH}?nonce=${nonce}`, abort.signal);
    } catch (error: unknown) {
      const message = abort.signal.aborted
        ? `no answer within ${Math.round(this.deps.timeoutMs / 1000)}s.`
        : `${sanitizeForLog(getErrorMessage(error, 'the tunnel closed')).slice(0, 200)}.`;
      return { result: readinessWithoutReport({ kind: 'unreachable', message }), agentVersion: null };
    } finally {
      clearTimeout(timer);
    }
    const receivedAt = this.deps.now();
    if (response.status === 404) return { result: readinessWithoutReport({ kind: 'unsupported', status: 404 }), agentVersion: null };
    if (response.status === 401 || response.status === 403) {
      return { result: readinessWithoutReport({ kind: 'refused', status: response.status }), agentVersion: null };
    }
    if (response.status !== 200) {
      return { result: readinessWithoutReport({ kind: 'unreachable', message: `the Pilot answered HTTP ${response.status}.` }), agentVersion: null };
    }
    const report = parseReadinessReport(response.body);
    if (!report) return { result: readinessWithoutReport({ kind: 'malformed' }), agentVersion: null };
    // Read after the answer: a reconnect while the request ran updates the announced version, and a mismatch then fails closed.
    const node = this.deps.db.getNode(nodeId);
    const result = evaluateReadiness(report, {
      nodeId,
      nonce,
      hubUrl: row.hub_url ?? '',
      composeDir: node?.compose_dir ?? '',
      tunnelAgentVersion: node?.pilot_agent_version ?? null,
      hubVersion: getSenchoVersion() || 'unknown',
      tunnelConfidential: this.deps.tunnels.isTunnelConfidential(nodeId),
      requestedAt,
      receivedAt,
    });
    return { result, agentVersion: report.agent.version };
  }

  /** Store the verdict, only if the row is still the one this check started on. */
  private record(nodeId: number, operationId: string | null, result: ReadinessResult, agentVersion: string | null): boolean {
    const recorded = this.deps.db.recordNodeReadinessResult(nodeId, operationId, {
      state: result.verdict,
      gatesJson: JSON.stringify(result.gates),
      agentVersion,
      checkedAt: this.deps.now(),
    });
    if (recorded) this.announce(nodeId);
    return recorded;
  }

  /** Announce a change. A failed announcement is logged and never fails the check that made the change. */
  private announce(nodeId: number): void {
    try {
      this.deps.changed(nodeId);
    } catch (error: unknown) {
      console.error(`[Readiness] Change for node ${nodeId} could not be announced:`, sanitizeForLog(getErrorMessage(error, 'unknown')));
    }
  }

  /** Add the verdict to the bootstrap's activity, when that record still exists. */
  private note(row: NodeReadinessRow, result: ReadinessResult): void {
    if (!row.operation_id) return;
    const op = this.deps.db.getNodeBootstrapOperation(row.operation_id);
    if (!op) return;
    const blocking = result.gates.filter((gate) => gate.status === 'fail' || gate.status === 'unknown');
    const status: NodeBootstrapEventStatus = result.verdict === 'ready' ? 'done' : 'failed';
    const warnings = result.gates.filter((gate) => gate.status === 'warn').length;
    const message = result.verdict === 'ready'
      ? `Readiness verified: no check failed${warnings > 0 ? ` (${warnings} warning${warnings === 1 ? '' : 's'})` : ''}. The node is ready for deployments.`
      : `Not ready for deployments: ${blocking.map((gate) => gate.summary).slice(0, 2).join(' ')}`;
    this.deps.db.appendNodeBootstrapEvent({
      operation_id: op.id,
      attempt: op.attempt,
      at: this.deps.now(),
      stage: 'verify',
      step: null,
      status,
      message,
      detail: null,
    });
  }
}
