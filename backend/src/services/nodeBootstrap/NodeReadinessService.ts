import crypto from 'crypto';
import axios from 'axios';
import { parseReadinessReport, READINESS_PATH } from '../../pilot/readinessContract';
import { getErrorMessage } from '../../utils/errors';
import { safeAxiosTransport } from '../../utils/outboundTarget';
import { sanitizeForLog } from '../../utils/safeLog';
import { DatabaseService, type NodeBootstrapEventStatus, type NodeReadinessRow, type NodeReadinessState } from '../DatabaseService';
import { PilotTunnelManager } from '../PilotTunnelManager';
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
 * node is `ready` only when every gate passes on that answer.
 *
 * When it runs: on every tunnel-up for a bootstrapped node (first
 * enrollment, a reconnect after an agent restart, self-update, host reboot or
 * hub restart, and a re-enrollment), and when an admin asks to verify again.
 * There is no poller. A check is one bounded HTTP request; checks for one node
 * never overlap, and a check requested while one runs makes that check run
 * once more when it ends, so the stored verdict always describes the newest
 * tunnel. Nodes enrolled by hand have no readiness row and are never checked,
 * so their connection status means what it always meant.
 */

export const READINESS_TIMEOUT_MS = 15_000;
/** A run of tunnel flaps can ask for many reruns; past this the last result stands until the next tunnel-up. */
const MAX_RERUNS = 3;

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
  on(event: 'tunnel-up', listener: (nodeId: number) => void): unknown;
  off(event: 'tunnel-up', listener: (nodeId: number) => void): unknown;
}

export type ReadinessFetch = (url: string, signal: AbortSignal) => Promise<{ status: number; body: unknown }>;

interface ReadinessDeps {
  db: DatabaseService;
  tunnels: ReadinessTunnelPort;
  fetch: ReadinessFetch;
  now: () => number;
  nonce: () => string;
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

function parseGates(json: string | null): ReadinessGate[] {
  if (!json) return [];
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? parsed as ReadinessGate[] : [];
  } catch {
    return [];
  }
}

export function readinessView(row: NodeReadinessRow): NodeReadinessView {
  return {
    state: row.state,
    operationId: row.operation_id,
    checkedAt: row.checked_at,
    agentVersion: row.agent_version,
    gates: parseGates(row.gates_json),
  };
}

export class NodeReadinessService {
  private static instance: NodeReadinessService | null = null;
  private readonly deps: ReadinessDeps;
  private readonly inflight = new Map<number, { promise: Promise<NodeReadinessView | null>; rerun: boolean }>();
  private started = false;
  private readonly onTunnelUp = (nodeId: number): void => {
    // Deferred a turn so a bootstrap run that waited for this tunnel records its enrollment first.
    setImmediate(() => {
      if (!this.deps.db.getNodeReadiness(nodeId)) return;
      this.verify(nodeId, SYSTEM_AUDIT).catch((error: unknown) => {
        console.error(`[Readiness] Check for node ${nodeId} failed:`, sanitizeForLog(getErrorMessage(error, 'unknown')));
      });
    });
  };

  public constructor(deps: Partial<ReadinessDeps> = {}) {
    this.deps = {
      db: DatabaseService.getInstance(),
      tunnels: PilotTunnelManager.getInstance(),
      fetch: realFetch,
      now: () => Date.now(),
      nonce: () => crypto.randomBytes(16).toString('hex'),
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
    for (const row of this.deps.db.listNodeReadiness()) {
      if (row.state !== 'verifying') continue;
      try {
        this.record(row.node_id, readinessWithoutReport({ kind: 'unreachable', message: 'the hub restarted during the check.' }), null);
      } catch (error: unknown) {
        console.error(`[Readiness] Node ${row.node_id} could not be settled:`, sanitizeForLog(getErrorMessage(error, 'unknown')));
      }
    }
    this.deps.tunnels.on('tunnel-up', this.onTunnelUp);
  }

  public stop(): void {
    if (!this.started) return;
    this.started = false;
    this.deps.tunnels.off('tunnel-up', this.onTunnelUp);
  }

  /** Test hook: wait for every check in flight. */
  public async settled(): Promise<void> {
    await Promise.all([...this.inflight.values()].map((entry) => entry.promise.catch(() => null)));
  }

  public get(nodeId: number): NodeReadinessView | null {
    const row = this.deps.db.getNodeReadiness(nodeId);
    return row ? readinessView(row) : null;
  }

  /** The readiness state of every bootstrapped node, for the node list. */
  public summaries(): Map<number, { state: NodeReadinessState; operationId: string | null; checkedAt: number | null }> {
    return new Map(this.deps.db.listNodeReadiness().map((row) => [row.node_id, { state: row.state, operationId: row.operation_id, checkedAt: row.checked_at }]));
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
      return current.promise;
    }
    const entry: { promise: Promise<NodeReadinessView | null>; rerun: boolean } = { promise: Promise.resolve(null), rerun: false };
    entry.promise = (async () => {
      let view: NodeReadinessView | null;
      let runs = 0;
      do {
        entry.rerun = false;
        view = await this.checkOnce(nodeId, audit);
        runs += 1;
      } while (entry.rerun && view !== null && runs <= MAX_RERUNS);
      return view;
    })().finally(() => {
      this.inflight.delete(nodeId);
    });
    this.inflight.set(nodeId, entry);
    return entry.promise;
  }

  private async checkOnce(nodeId: number, audit: BootstrapAuditContext): Promise<NodeReadinessView | null> {
    const row = this.deps.db.getNodeReadiness(nodeId);
    if (!row) return null;
    this.deps.db.setNodeReadinessState(nodeId, 'verifying', this.deps.now());
    const { result, agentVersion } = await this.ask(nodeId, row);
    this.record(nodeId, result, agentVersion);
    // A reconnect that confirms the same verdict is not news; an asked-for check, or a changed verdict, is recorded.
    if (audit === SYSTEM_AUDIT && row.state === result.verdict) return this.get(nodeId);
    this.note(row, result);
    recordBootstrapAudit(this.deps.db, this.deps.now(), audit, 'bootstrap.readiness.checked', {
      node: nodeId,
      operation: row.operation_id,
      verdict: result.verdict,
      failed: result.gates.filter((gate) => gate.status === 'fail' || gate.status === 'unknown').map((gate) => gate.id),
    }, 200);
    return this.get(nodeId);
  }

  private async ask(nodeId: number, row: NodeReadinessRow): Promise<{ result: ReadinessResult; agentVersion: string | null }> {
    const loopback = this.deps.tunnels.hasActiveTunnel(nodeId) ? this.deps.tunnels.getLoopbackUrl(nodeId) : null;
    if (!loopback) return { result: readinessWithoutReport({ kind: 'not_connected' }), agentVersion: null };
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
      tunnelConfidential: this.deps.tunnels.isTunnelConfidential(nodeId),
      requestedAt,
      receivedAt,
    });
    return { result, agentVersion: report.agent.version };
  }

  private record(nodeId: number, result: ReadinessResult, agentVersion: string | null): void {
    this.deps.db.recordNodeReadinessResult(nodeId, {
      state: result.verdict,
      gatesJson: JSON.stringify(result.gates),
      agentVersion,
      checkedAt: this.deps.now(),
    });
  }

  /** Add the verdict to the bootstrap's activity, when that record still exists. */
  private note(row: NodeReadinessRow, result: ReadinessResult): void {
    if (!row.operation_id) return;
    const op = this.deps.db.getNodeBootstrapOperation(row.operation_id);
    if (!op) return;
    const blocking = result.gates.filter((gate) => gate.status === 'fail' || gate.status === 'unknown');
    const status: NodeBootstrapEventStatus = result.verdict === 'ready' ? 'done' : 'failed';
    const message = result.verdict === 'ready'
      ? `Readiness verified: all ${result.gates.length} checks passed. The node is ready for deployments.`
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
