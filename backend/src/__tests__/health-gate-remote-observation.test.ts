/**
 * A health-gated rollout target on a remote node: the gate reads that node's
 * own observation, so a verdict is about the containers the node is running
 * rather than a socket this instance never had.
 *
 * What this pins is the classification of a read that cannot happen. An answer
 * that the node does not report the facts a verdict needs ends the observation
 * at once, because asking again would hear the same thing; a read that may work
 * later keeps the gate's existing error budget; and the accounting itself is
 * unchanged, so a failing container fails the verdict the same way it does
 * locally.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface StoredRun {
  id: string;
  node_id: number;
  stack_name: string;
  trigger_action: string;
  status: 'observing' | 'passed' | 'failed' | 'unknown';
  reason: string | null;
  window_seconds: number;
  containers_json: string;
  started_at: number;
  ended_at: number | null;
  created_by: string | null;
  target_scope: 'stack' | 'service';
  service_name: string | null;
  failure_source: 'primary' | 'collateral' | null;
}

const REMOTE_NODE_ID = 7;

const { state } = vi.hoisted(() => ({
  state: {
    runs: new Map<string, StoredRun>(),
    settings: {} as Record<string, string>,
    readFacts: vi.fn(),
    readDeclared: vi.fn(),
  },
}));

vi.mock('../services/health/stackHealthFacts', () => ({
  readStackHealthFacts: (...args: unknown[]) => state.readFacts(...args),
  readStackDeclaredRestartIntent: (...args: unknown[]) => state.readDeclared(...args),
}));

vi.mock('../services/DatabaseService', () => ({
  DatabaseService: {
    getInstance: () => ({
      getGlobalSettings: () => state.settings,
      // The gate asks what kind of node it is observing before it reads.
      getNode: (nodeId: number) => ({ id: nodeId, type: 'remote' }),
      insertHealthGateRun: (run: StoredRun) => { state.runs.set(run.id, { ...run }); },
      finalizeHealthGateRun: (
        id: string,
        status: StoredRun['status'],
        reason: string | null,
        endedAt: number,
        containersJson: string,
        failureSource: StoredRun['failure_source'] = null,
      ) => {
        const run = state.runs.get(id);
        if (run) Object.assign(run, { status, reason, ended_at: endedAt, containers_json: containersJson, failure_source: failureSource });
      },
      getHealthGateRun: (nodeId: number, stackName: string, id: string) => {
        const run = state.runs.get(id);
        return run && run.node_id === nodeId && run.stack_name === stackName ? { ...run } : undefined;
      },
      getLatestHealthGateRun: (nodeId: number, stackName: string) => {
        const matches = [...state.runs.values()]
          .filter(r => r.node_id === nodeId && r.stack_name === stackName)
          .sort((a, b) => b.started_at - a.started_at);
        return matches[0] ? { ...matches[0] } : undefined;
      },
      listObservingHealthGateRuns: () => [],
      addNotificationHistory: (_nodeId: number, item: { category?: string; message: string; level: string }) => ({ ...item, id: 1, is_read: false }),
    }),
  },
}));

vi.mock('../services/ComposeService', () => ({
  getComposeCommandTimeoutMs: () => 30_000,
  ComposeService: { getInstance: () => ({ renderConfig: vi.fn() }) },
}));

vi.mock('../services/AutoHealService', () => ({
  AutoHealService: { getInstance: () => ({ clearSuppress: vi.fn() }) },
}));

import { HealthGateService } from '../services/HealthGateService';

const svc = () => HealthGateService.getInstance();
const latest = () => svc().getReport(REMOTE_NODE_ID, 'web');

async function ticks(n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    await vi.advanceTimersByTimeAsync(5_000);
  }
}

function container(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'c1'.padEnd(64, '0'),
    name: 'web-app-1',
    service: 'app',
    state: 'running',
    health: 'healthy',
    restartCount: 0,
    startedAt: '2026-06-10T00:00:00Z',
    imageId: 'sha256:abc',
    exitCode: 0,
    restartPolicy: 'unless-stopped',
    ...overrides,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  state.runs.clear();
  state.settings = { health_gate_enabled: '1', health_gate_window_seconds: '30' };
  state.readFacts.mockReset();
  state.readDeclared.mockReset();
  state.readDeclared.mockResolvedValue(new Map());
  svc().start();
});

afterEach(() => {
  svc().stop();
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers();
});

describe('HealthGateService on a remote target', () => {
  it('passes from the node\'s own observation', async () => {
    state.readFacts.mockResolvedValue({ kind: 'ok', containers: [container()] });

    svc().beginStack(REMOTE_NODE_ID, 'web', 'update', 'tester', { deployedGenerationId: null });
    await ticks(3);
    expect(latest().status, 'still observing inside the window').toBe('observing');
    await ticks(4);

    expect(latest().status).toBe('passed');
    expect(state.readFacts).toHaveBeenCalledWith({ nodeId: REMOTE_NODE_ID, stackName: 'web' });
  });

  it('fails on the same accounting a local target gets', async () => {
    state.readFacts.mockResolvedValue({ kind: 'ok', containers: [container({ health: 'unhealthy' })] });

    svc().beginStack(REMOTE_NODE_ID, 'web', 'deploy', 'tester', { deployedGenerationId: null });
    // The first poll arms the expected set; the verdict comes from the next one.
    await ticks(2);

    expect(latest().status).toBe('failed');
    expect(latest().reason).toBe('container web-app-1 reported unhealthy');
  });

  it('ends at once when the node does not report what a verdict needs', async () => {
    state.readFacts.mockResolvedValue({ kind: 'unsupported' });

    svc().beginStack(REMOTE_NODE_ID, 'web', 'update', 'tester', { deployedGenerationId: null });
    await ticks(1);

    expect(latest().status).toBe('unknown');
    expect(latest().reason).toBe('The target node does not report the runtime facts a health verdict needs.');
    expect(state.readFacts, 'no later poll can hear anything different').toHaveBeenCalledTimes(1);
  });

  it('keeps the error budget for a node that could not be read', async () => {
    state.readFacts.mockResolvedValue({ kind: 'unavailable', cause: 'node', detail: 'HTTP 503' });

    svc().beginStack(REMOTE_NODE_ID, 'web', 'update', 'tester', { deployedGenerationId: null });
    await ticks(2);
    expect(latest().status, 'a read that may work later does not end it').toBe('observing');
    await ticks(1);

    expect(latest().status).toBe('unknown');
    expect(latest().reason).toBe('The target node could not be read during observation.');
  });

  it('names the node, not Docker, when a read never answers at all', async () => {
    state.readFacts.mockRejectedValue(new Error('read hung past the poll ceiling'));

    svc().beginStack(REMOTE_NODE_ID, 'web', 'update', 'tester', { deployedGenerationId: null });
    await ticks(3);

    expect(latest().status).toBe('unknown');
    expect(latest().reason).toBe('The target node could not be read during observation.');
  });

  it('reads the declared restart intent once, from the gate that owns the run', async () => {
    state.readFacts.mockResolvedValue({ kind: 'ok', containers: [container()] });
    state.readDeclared.mockResolvedValue(new Map([['app', 'unless-stopped']]));

    svc().beginStack(REMOTE_NODE_ID, 'web', 'update', 'tester', { deployedGenerationId: null });
    await ticks(4);

    expect(state.readDeclared).toHaveBeenCalledWith({ nodeId: REMOTE_NODE_ID, stackName: 'web' });
    expect(state.readDeclared).toHaveBeenCalledTimes(1);
  });

  it('ends unknown, not failed, when an exit cannot be told from a completed one-shot', async () => {
    // The one-shot that finished exactly as its compose declares, on a window
    // whose declared intent the node could not report: failing it would let a
    // rollback policy restore a workload that was never unhealthy.
    state.readFacts.mockResolvedValue({
      kind: 'ok',
      containers: [container({ state: 'exited', exitCode: 0, restartPolicy: 'no' })],
    });
    state.readDeclared.mockResolvedValue(null);

    svc().beginStack(REMOTE_NODE_ID, 'web', 'update', 'tester', { deployedGenerationId: null });
    await ticks(2);

    expect(latest().status).toBe('unknown');
    expect(latest().reason).toContain('declared restart intent could not be read');
  });

  it('lets a definite peer decide the verdict even when the ambiguous exit is listed first', async () => {
    // The accounting on the node's facts is the same one the local gate runs:
    // the completed job alone would be undecidable, but the unhealthy
    // application container beside it is a failure the ambiguity must not hide.
    state.readFacts.mockResolvedValue({
      kind: 'ok',
      containers: [
        container({
          id: 'job'.padEnd(64, '0'), name: 'web-migrate-1', service: 'migrate',
          state: 'exited', exitCode: 0, restartPolicy: 'no',
        }),
        container({ id: 'app'.padEnd(64, '0'), health: 'unhealthy' }),
      ],
    });
    state.readDeclared.mockResolvedValue(null);

    svc().beginStack(REMOTE_NODE_ID, 'web', 'update', 'tester', { deployedGenerationId: null });
    await ticks(2);

    expect(latest().status).toBe('failed');
    expect(latest().reason).toBe('container web-app-1 reported unhealthy');
  });

  it('still fails an exit that cannot be a completed one-shot', async () => {
    // A non-zero exit is a failure whether or not the compose declared
    // `restart: "no"`, so the missing intent must not soften it.
    state.readFacts.mockResolvedValue({
      kind: 'ok',
      containers: [container({ state: 'exited', exitCode: 1, restartPolicy: 'no' })],
    });
    state.readDeclared.mockResolvedValue(null);

    svc().beginStack(REMOTE_NODE_ID, 'web', 'update', 'tester', { deployedGenerationId: null });
    await ticks(2);

    expect(latest().status).toBe('failed');
    expect(latest().reason).toBe('container web-app-1 exited during observation');
  });
});
