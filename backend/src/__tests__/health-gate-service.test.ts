/**
 * State-machine tests for HealthGateService with fake timers and an in-memory
 * DatabaseService mock: verdicts, restart detection, supersede semantics,
 * startup sweep, the disabled setting, the concurrency cap, and timer hygiene.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

interface StoredRun {
  id: string;
  node_id: number;
  stack_name: string;
  trigger_action: 'update' | 'deploy';
  status: 'observing' | 'passed' | 'failed' | 'unknown';
  reason: string | null;
  window_seconds: number;
  containers_json: string;
  started_at: number;
  ended_at: number | null;
  created_by: string | null;
}

const { state } = vi.hoisted(() => ({
  state: {
    runs: new Map<string, StoredRun>(),
    activity: [] as Array<{ category?: string; message: string; level: string }>,
    settings: {} as Record<string, string>,
    listContainers: vi.fn(),
    inspect: vi.fn(),
  },
}));

vi.mock('../services/DatabaseService', () => ({
  DatabaseService: {
    getInstance: () => ({
      getGlobalSettings: () => state.settings,
      insertHealthGateRun: (run: StoredRun) => { state.runs.set(run.id, { ...run }); },
      finalizeHealthGateRun: (id: string, status: StoredRun['status'], reason: string | null, endedAt: number, containersJson: string) => {
        const run = state.runs.get(id);
        if (run) Object.assign(run, { status, reason, ended_at: endedAt, containers_json: containersJson });
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
      markInterruptedHealthGateRuns: (reason: string, endedAt: number) => {
        let n = 0;
        for (const run of state.runs.values()) {
          if (run.status === 'observing') {
            Object.assign(run, { status: 'unknown', reason, ended_at: endedAt });
            n++;
          }
        }
        return n;
      },
      addNotificationHistory: (_nodeId: number, item: { category?: string; message: string; level: string }) => {
        state.activity.push(item);
        return { ...item, id: state.activity.length, is_read: false };
      },
    }),
  },
}));

vi.mock('../services/DockerController', () => ({
  default: {
    getInstance: () => ({
      getDocker: () => ({
        listContainers: state.listContainers,
        getContainer: (id: string) => ({ inspect: () => state.inspect(id) }),
      }),
    }),
  },
}));

import { HealthGateService } from '../services/HealthGateService';

type ContainerFixture = {
  id: string;
  name: string;
  state?: string;
  health?: string | null;
  restartCount?: number;
  startedAt?: string;
};

/** Configure the docker mocks from a simple fixture list. */
function setContainers(fixtures: ContainerFixture[]): void {
  state.listContainers.mockResolvedValue(fixtures.map(f => ({ Id: f.id, Names: [`/${f.name}`], State: f.state ?? 'running' })));
  state.inspect.mockImplementation((id: string) => {
    const f = fixtures.find(c => c.id === id);
    if (!f) return Promise.reject(Object.assign(new Error('no such container'), { statusCode: 404 }));
    return Promise.resolve({
      State: {
        Status: f.state ?? 'running',
        Health: f.health !== undefined && f.health !== null ? { Status: f.health } : undefined,
        StartedAt: f.startedAt ?? '2026-06-10T00:00:00Z',
      },
      RestartCount: f.restartCount ?? 0,
    });
  });
}

const svc = () => HealthGateService.getInstance();

const latest = (stack = 'web') => svc().getReport(0, stack);

async function ticks(n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    await vi.advanceTimersByTimeAsync(5_000);
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  state.runs.clear();
  state.activity.length = 0;
  state.settings = { health_gate_enabled: '1', health_gate_window_seconds: '30' };
  state.listContainers.mockReset();
  state.inspect.mockReset();
  setContainers([{ id: 'aaa', name: 'web-app-1' }]);
  svc().start();
});

afterEach(() => {
  svc().stop();
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers();
});

describe('HealthGateService verdicts', () => {
  it('passes at the window end when containers stay running', async () => {
    const id = svc().begin(0, 'web', 'update', 'tester');
    expect(id).toBeTruthy();
    await ticks(3); // 15s: still observing
    expect(latest().status).toBe('observing');
    await ticks(4); // past the 30s window
    expect(latest().status).toBe('passed');
    expect(state.activity.some(a => a.category === 'health_gate_passed')).toBe(true);
  });

  it('fails fast when a container exits', async () => {
    svc().begin(0, 'web', 'update', 'tester');
    await ticks(1); // baseline
    setContainers([{ id: 'aaa', name: 'web-app-1', state: 'exited' }]);
    await ticks(1);
    const report = latest();
    expect(report.status).toBe('failed');
    expect(report.reason).toContain('exited');
    expect(state.activity.some(a => a.category === 'health_gate_failed')).toBe(true);
  });

  it('fails fast when a healthcheck reports unhealthy', async () => {
    svc().begin(0, 'web', 'update', 'tester');
    await ticks(1);
    setContainers([{ id: 'aaa', name: 'web-app-1', health: 'unhealthy' }]);
    await ticks(1);
    expect(latest().status).toBe('failed');
    expect(latest().reason).toContain('unhealthy');
  });

  it('detects a restart loop via container replacement (new id)', async () => {
    svc().begin(0, 'web', 'update', 'tester');
    await ticks(1);
    setContainers([{ id: 'bbb', name: 'web-app-1' }]);
    await ticks(1); // restart 1 observed; carried as new baseline
    setContainers([{ id: 'ccc', name: 'web-app-1' }]);
    await ticks(1); // restart 2: loop
    const report = latest();
    expect(report.status).toBe('failed');
    expect(report.reason).toContain('restart looping');
    // The persisted summary reflects the tally the verdict acted on.
    expect(report.containers).toEqual([
      expect.objectContaining({ name: 'web-app-1', restarts: 2 }),
    ]);
  });

  it('detects a restart loop via RestartCount and StartedAt movement', async () => {
    svc().begin(0, 'web', 'update', 'tester');
    await ticks(1);
    setContainers([{ id: 'aaa', name: 'web-app-1', restartCount: 1 }]);
    await ticks(1);
    setContainers([{ id: 'aaa', name: 'web-app-1', restartCount: 1, startedAt: '2026-06-10T00:05:00Z' }]);
    await ticks(1);
    const report = latest();
    expect(report.status).toBe('failed');
    expect(report.reason).toContain('restart looping');
    expect(report.containers).toEqual([
      expect.objectContaining({ name: 'web-app-1', restarts: 2 }),
    ]);
  });

  it('tolerates a one-poll disappearance but fails on two consecutive misses', async () => {
    svc().begin(0, 'web', 'update', 'tester');
    await ticks(1); // baseline
    setContainers([]); // one missed poll: tolerated
    await ticks(1);
    setContainers([{ id: 'aaa', name: 'web-app-1' }]); // back before the second miss
    await ticks(5); // through the 30s window
    expect(latest().status).toBe('passed');

    const second = svc().begin(0, 'web', 'update', 'tester')!;
    await ticks(1);
    setContainers([]);
    await ticks(2); // two consecutive misses: disappeared
    const report = svc().getReport(0, 'web', second);
    expect(report.status).toBe('failed');
    expect(report.reason).toContain('disappeared');
  });

  it('fails when a container is stuck restarting across consecutive polls', async () => {
    svc().begin(0, 'web', 'update', 'tester');
    await ticks(1);
    setContainers([{ id: 'aaa', name: 'web-app-1', state: 'restarting' }]);
    await ticks(2);
    expect(latest().status).toBe('failed');
    expect(latest().reason).toContain('restarting');
  });

  it('goes unknown after three consecutive docker errors', async () => {
    svc().begin(0, 'web', 'update', 'tester');
    await ticks(1);
    state.listContainers.mockRejectedValue(new Error('socket gone'));
    await ticks(3);
    expect(latest().status).toBe('unknown');
    expect(latest().reason).toContain('unreachable');
  });

  it('resolves unknown when every docker observe hangs', async () => {
    svc().begin(0, 'web', 'update', 'tester');
    // A wedged socket never settles. The per-observe timeout turns each poll
    // into an error, and three in a row finalize the gate unknown instead of
    // observing forever on a pending promise.
    state.listContainers.mockImplementation(() => new Promise<never>(() => {}));
    // Each cycle is the 5s interval plus the 8s observe timeout; 45s covers
    // three of them.
    await vi.advanceTimersByTimeAsync(45_000);
    expect(latest().status).toBe('unknown');
    expect(latest().reason).toContain('unreachable');
  });

  it('recovers from a transient observe timeout instead of finalizing', async () => {
    svc().begin(0, 'web', 'update', 'tester');
    // One observe wedges and times out (a single strike), then the socket
    // recovers; the gate must keep observing, not give up at one error.
    state.listContainers.mockImplementationOnce(() => new Promise<never>(() => {}));
    // 14s covers the first cycle's 5s wait plus 8s timeout.
    await vi.advanceTimersByTimeAsync(14_000);
    expect(latest().status).toBe('observing');
    // Later polls succeed and carry the gate to a pass at the window end.
    await vi.advanceTimersByTimeAsync(50_000);
    expect(latest().status).toBe('passed');
  });

  it('runs polls single-flight: no second observe until the first settles', async () => {
    svc().begin(0, 'web', 'update', 'tester');
    let release: (value: Array<{ Id: string; Names: string[]; State: string }>) => void = () => {};
    state.listContainers.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    // Advance past a second poll interval while the first observe is still
    // pending. Self-scheduling means the next poll is armed only after the
    // current cycle settles, so listContainers is entered exactly once.
    await vi.advanceTimersByTimeAsync(7_000);
    expect(state.listContainers).toHaveBeenCalledTimes(1);
    // Let the first cycle finish; the next poll then runs and observes again.
    release([{ Id: 'aaa', Names: ['/web-app-1'], State: 'running' }]);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(state.listContainers.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('ends unknown when a healthcheck is still starting at the window end', async () => {
    svc().begin(0, 'web', 'update', 'tester');
    setContainers([{ id: 'aaa', name: 'web-app-1', health: 'starting' }]);
    await ticks(7);
    expect(latest().status).toBe('unknown');
    expect(latest().reason).toContain('still starting');
  });

  it('goes unknown when no containers ever appear', async () => {
    setContainers([]);
    svc().begin(0, 'web', 'update', 'tester');
    await ticks(4);
    expect(latest().status).toBe('unknown');
    expect(latest().reason).toContain('no containers');
  });
});

describe('HealthGateService lifecycle', () => {
  it('never lets a poll that straddled a supersede overwrite the terminal verdict', async () => {
    // A poll is mid-await on Docker when a newer update supersedes the gate;
    // when the await resolves with healthy containers, the superseded run
    // must keep its terminal unknown verdict.
    const first = svc().begin(0, 'web', 'update', 'tester')!;
    await ticks(2); // baseline established, healthy

    let releasePoll: (value: Array<{ Id: string; Names: string[]; State: string }>) => void = () => {};
    state.listContainers.mockImplementationOnce(
      () => new Promise(resolve => { releasePoll = resolve; }),
    );
    const straddlingPoll = vi.advanceTimersByTimeAsync(5_000); // poll now awaiting Docker

    const second = svc().begin(0, 'web', 'update', 'tester')!;
    expect(svc().getReport(0, 'web', first).status).toBe('unknown');

    releasePoll([{ Id: 'aaa', Names: ['/web-app-1'], State: 'running' }]);
    await straddlingPoll;

    const superseded = svc().getReport(0, 'web', first);
    expect(superseded.status).toBe('unknown');
    expect(superseded.reason).toContain('superseded');

    await ticks(7);
    expect(svc().getReport(0, 'web', second).status).toBe('passed');
  });

  it('supersede finalizes the old run as unknown, clears its timer, and getRun still resolves it', async () => {
    const first = svc().begin(0, 'web', 'update', 'tester')!;
    await ticks(1);
    const timersBefore = vi.getTimerCount();
    const second = svc().begin(0, 'web', 'update', 'tester')!;
    expect(vi.getTimerCount()).toBe(timersBefore); // old interval cleared, new one added

    const superseded = svc().getReport(0, 'web', first);
    expect(superseded.status).toBe('unknown');
    expect(superseded.reason).toContain('superseded');

    await ticks(7);
    expect(svc().getReport(0, 'web', second).status).toBe('passed');
    // The by-id read still returns the superseded run unchanged.
    expect(svc().getReport(0, 'web', first).status).toBe('unknown');
  });

  it('start() sweeps runs left observing by a previous process', () => {
    state.runs.set('stale', {
      id: 'stale', node_id: 0, stack_name: 'web', trigger_action: 'update', status: 'observing',
      reason: null, window_seconds: 30, containers_json: '[]', started_at: 1, ended_at: null, created_by: null,
    });
    svc().start();
    expect(state.runs.get('stale')!.status).toBe('unknown');
    expect(state.runs.get('stale')!.reason).toContain('restarted');
  });

  it('no-ops when disabled but still records the update_started event', () => {
    state.settings.health_gate_enabled = '0';
    const id = svc().begin(0, 'web', 'update', 'tester');
    expect(id).toBeNull();
    expect(state.runs.size).toBe(0);
    expect(state.activity.some(a => a.category === 'update_started')).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('records update_started for update triggers but not deploy triggers', () => {
    svc().begin(0, 'web', 'deploy', 'tester');
    expect(state.activity.some(a => a.category === 'update_started')).toBe(false);
    svc().begin(0, 'web', 'update', 'tester');
    expect(state.activity.some(a => a.category === 'update_started')).toBe(true);
  });

  it('refuses to begin before start() so shutdown cannot leak timers', () => {
    svc().stop();
    expect(svc().begin(0, 'web', 'update', 'tester')).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    svc().start();
  });

  it('persists an immediate unknown past the concurrency cap', () => {
    for (let i = 0; i < 25; i++) {
      svc().begin(0, `stack-${i}`, 'update', 'tester');
    }
    const overCap = svc().begin(0, 'one-too-many', 'update', 'tester')!;
    const report = svc().getReport(0, 'one-too-many', overCap);
    expect(report.status).toBe('unknown');
    expect(report.reason).toContain('concurrent');
  });

  it('clamps the configured window into its valid range and falls back on garbage', () => {
    state.settings.health_gate_window_seconds = '99999';
    const a = svc().begin(0, 'web', 'update', 'tester')!;
    expect(svc().getReport(0, 'web', a).windowSeconds).toBe(600);
    state.settings.health_gate_window_seconds = 'banana';
    const b = svc().begin(0, 'web', 'update', 'tester')!;
    expect(svc().getReport(0, 'web', b).windowSeconds).toBe(90);
  });

  it('returns the never-run sentinel for a stack with no runs', () => {
    const report = svc().getReport(0, 'nothing-here');
    expect(report.status).toBe('never-run');
    expect(report.id).toBeNull();
  });

  it('stop() finalizes in-flight gates as unknown with zero timers left', async () => {
    const id = svc().begin(0, 'web', 'update', 'tester')!;
    await ticks(1);
    svc().stop();
    expect(vi.getTimerCount()).toBe(0);
    expect(svc().getReport(0, 'web', id).status).toBe('unknown');
    svc().start();
  });
});
