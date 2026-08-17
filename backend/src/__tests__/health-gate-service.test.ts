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
  trigger_action: 'update' | 'deploy' | 'service_update' | 'service_restore' | 'recovery';
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
  deployed_generation_id?: string | null;
}

const { state } = vi.hoisted(() => ({
  state: {
    runs: new Map<string, StoredRun>(),
    recoveries: new Map<string, { id: string; health_gate_id: string | null }>(),
    activity: [] as Array<{ category?: string; message: string; level: string }>,
    settings: {} as Record<string, string>,
    /** Run id whose finalize write should fail, for the per-row sweep guard. */
    failFinalizeFor: null as string | null,
    listContainers: vi.fn(),
    inspect: vi.fn(),
    renderConfig: vi.fn(),
  },
}));

vi.mock('../services/DatabaseService', () => ({
  DatabaseService: {
    getInstance: () => ({
      getGlobalSettings: () => state.settings,
      insertHealthGateRun: (run: StoredRun) => { state.runs.set(run.id, { ...run }); },
      finalizeHealthGateRun: (id: string, status: StoredRun['status'], reason: string | null, endedAt: number, containersJson: string, failureSource: StoredRun['failure_source'] = null) => {
        if (state.failFinalizeFor === id) throw new Error('row is unreadable');
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
      getStackUpdateRecoveryGeneration: (id: string) => {
        const row = state.recoveries.get(id);
        return row ? { ...row } : undefined;
      },
      updateStackUpdateRecoveryGeneration: (id: string, patch: { health_gate_id?: string | null }) => {
        const row = state.recoveries.get(id);
        if (row) Object.assign(row, patch);
      },
      listObservingHealthGateRuns: () => [...state.runs.values()]
        .filter(run => run.status === 'observing')
        .map(run => ({ ...run })),
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

vi.mock('../services/ComposeService', () => ({
  getComposeCommandTimeoutMs: () => 30_000,
  ComposeService: {
    getInstance: () => ({
      renderConfig: state.renderConfig,
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
  exitCode?: number | null;
  restartPolicy?: string | null;
  service?: string;
  imageId?: string;
};

/** Configure the docker mocks from a simple fixture list. */
function setContainers(fixtures: ContainerFixture[]): void {
  state.listContainers.mockResolvedValue(fixtures.map(f => ({
    Id: f.id,
    Names: [`/${f.name}`],
    State: f.state ?? 'running',
    Labels: f.service ? { 'com.docker.compose.service': f.service } : {},
  })));
  state.inspect.mockImplementation((id: string) => {
    const f = fixtures.find(c => c.id === id);
    if (!f) return Promise.reject(Object.assign(new Error('no such container'), { statusCode: 404 }));
    return Promise.resolve({
      State: {
        Status: f.state ?? 'running',
        ExitCode: f.exitCode === undefined ? (f.state === 'exited' ? 1 : 0) : f.exitCode,
        Health: f.health !== undefined && f.health !== null ? { Status: f.health } : undefined,
        StartedAt: f.startedAt ?? '2026-06-10T00:00:00Z',
      },
      RestartCount: f.restartCount ?? 0,
      Image: f.imageId ?? 'sha256:img',
      HostConfig: { RestartPolicy: { Name: f.restartPolicy ?? '' } },
      Config: { Labels: f.service ? { 'com.docker.compose.service': f.service } : {} },
    });
  });
}

/** Declared Compose restart map used for one-shot recognition (not inspect). */
function setDeclaredRestarts(services: Record<string, string | undefined>): void {
  const rendered = {
    name: 'web',
    services: Object.fromEntries(
      Object.entries(services).map(([name, restart]) => [
        name,
        restart === undefined ? { image: `${name}:1` } : { image: `${name}:1`, restart },
      ]),
    ),
  };
  state.renderConfig.mockResolvedValue({
    rendered: JSON.stringify(rendered),
    stderr: '',
    code: 0,
    timedOut: false,
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
  state.recoveries.clear();
  state.failFinalizeFor = null;
  state.activity.length = 0;
  state.settings = { health_gate_enabled: '1', health_gate_window_seconds: '30' };
  state.listContainers.mockReset();
  state.inspect.mockReset();
  state.renderConfig.mockReset();
  setDeclaredRestarts({ app: 'unless-stopped' });
  setContainers([{ id: 'aaa', name: 'web-app-1', service: 'app', restartPolicy: 'unless-stopped' }]);
  svc().start();
});

afterEach(() => {
  svc().stop();
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers();
});

describe('HealthGateService verdicts', () => {
  it('passes at the window end when containers stay running', async () => {
    const id = svc().beginStack(0, 'web', 'update', 'tester', { deployedGenerationId: null });
    expect(id).toBeTruthy();
    await ticks(3); // 15s: still observing
    expect(latest().status).toBe('observing');
    await ticks(4); // past the 30s window
    expect(latest().status).toBe('passed');
    expect(state.activity.some(a => a.category === 'health_gate_passed')).toBe(true);
  });

  it('fails fast when a container exits', async () => {
    svc().beginStack(0, 'web', 'update', 'tester', { deployedGenerationId: null });
    await ticks(1); // baseline
    setContainers([{ id: 'aaa', name: 'web-app-1', state: 'exited', exitCode: 1, restartPolicy: 'unless-stopped' }]);
    await ticks(1);
    const report = latest();
    expect(report.status).toBe('failed');
    expect(report.reason).toContain('exited');
    expect(state.activity.some(a => a.category === 'health_gate_failed')).toBe(true);
  });

  it('passes when a clean one-shot exits 0 with explicit declared restart no', async () => {
    setDeclaredRestarts({ app: 'unless-stopped', migrate: 'no' });
    setContainers([
      { id: 'app', name: 'web-app-1', service: 'app', state: 'running', restartPolicy: 'unless-stopped' },
      { id: 'job', name: 'web-migrate-1', service: 'migrate', state: 'running', restartPolicy: 'no' },
    ]);
    svc().beginStack(0, 'web', 'update', 'tester', { deployedGenerationId: null });
    await ticks(1);
    setContainers([
      { id: 'app', name: 'web-app-1', service: 'app', state: 'running', restartPolicy: 'unless-stopped' },
      { id: 'job', name: 'web-migrate-1', service: 'migrate', state: 'exited', exitCode: 0, restartPolicy: 'no' },
    ]);
    await ticks(1);
    expect(latest().status).toBe('observing');
    await ticks(6);
    expect(latest().status).toBe('passed');
  });

  it('fails when a daemon with omitted Compose restart exits 0 (inspect also reports no)', async () => {
    // QA P0: Docker HostConfig.RestartPolicy.Name is "no" for both omit and
    // explicit restart:"no". Declared intent must decide, not inspect.
    setDeclaredRestarts({ 'daemon-default': undefined });
    setContainers([
      {
        id: 'daemon', name: 'web-daemon-default-1', service: 'daemon-default',
        state: 'running', restartPolicy: 'no',
      },
    ]);
    svc().beginStack(0, 'web', 'update', 'tester', { deployedGenerationId: null });
    await ticks(1);
    setContainers([
      {
        id: 'daemon', name: 'web-daemon-default-1', service: 'daemon-default',
        state: 'exited', exitCode: 0, restartPolicy: 'no',
      },
    ]);
    await ticks(1);
    expect(latest().status).toBe('failed');
    expect(latest().reason).toContain('exited during observation');
  });

  it('passes a clean one-shot even when residual health is unhealthy', async () => {
    setDeclaredRestarts({ app: 'unless-stopped', migrate: 'no' });
    setContainers([
      { id: 'app', name: 'web-app-1', service: 'app', state: 'running', restartPolicy: 'unless-stopped' },
      { id: 'job', name: 'web-migrate-1', service: 'migrate', state: 'running', restartPolicy: 'no' },
    ]);
    svc().beginStack(0, 'web', 'update', 'tester', { deployedGenerationId: null });
    await ticks(1);
    setContainers([
      { id: 'app', name: 'web-app-1', service: 'app', state: 'running', restartPolicy: 'unless-stopped' },
      {
        id: 'job', name: 'web-migrate-1', service: 'migrate', state: 'exited', exitCode: 0,
        restartPolicy: 'no', health: 'unhealthy',
      },
    ]);
    await ticks(1);
    expect(latest().status).toBe('observing');
    await ticks(6);
    expect(latest().status).toBe('passed');
  });

  it('passes a clean one-shot even when residual health is still starting', async () => {
    setDeclaredRestarts({ app: 'unless-stopped', migrate: 'no' });
    setContainers([
      { id: 'app', name: 'web-app-1', service: 'app', state: 'running', restartPolicy: 'unless-stopped' },
      { id: 'job', name: 'web-migrate-1', service: 'migrate', state: 'running', restartPolicy: 'no' },
    ]);
    svc().beginStack(0, 'web', 'update', 'tester', { deployedGenerationId: null });
    await ticks(1);
    setContainers([
      { id: 'app', name: 'web-app-1', service: 'app', state: 'running', restartPolicy: 'unless-stopped' },
      {
        id: 'job', name: 'web-migrate-1', service: 'migrate', state: 'exited', exitCode: 0,
        restartPolicy: 'no', health: 'starting',
      },
    ]);
    await ticks(1);
    expect(latest().status).toBe('observing');
    await ticks(6);
    expect(latest().status).toBe('passed');
  });

  it('still fails unhealthy on a long-running container', async () => {
    setDeclaredRestarts({ app: 'unless-stopped', migrate: 'no' });
    setContainers([
      { id: 'app', name: 'web-app-1', service: 'app', state: 'running', restartPolicy: 'unless-stopped' },
      { id: 'job', name: 'web-migrate-1', service: 'migrate', state: 'running', restartPolicy: 'no' },
    ]);
    svc().beginStack(0, 'web', 'update', 'tester', { deployedGenerationId: null });
    await ticks(1);
    setContainers([
      {
        id: 'app', name: 'web-app-1', service: 'app', state: 'running',
        restartPolicy: 'unless-stopped', health: 'unhealthy',
      },
      { id: 'job', name: 'web-migrate-1', service: 'migrate', state: 'exited', exitCode: 0, restartPolicy: 'no' },
    ]);
    await ticks(1);
    expect(latest().status).toBe('failed');
    expect(latest().reason).toContain('unhealthy');
  });

  it('still ends unknown when a long-running healthcheck is starting at window end', async () => {
    setDeclaredRestarts({ app: 'unless-stopped', migrate: 'no' });
    setContainers([
      { id: 'app', name: 'web-app-1', service: 'app', state: 'running', restartPolicy: 'unless-stopped' },
      { id: 'job', name: 'web-migrate-1', service: 'migrate', state: 'running', restartPolicy: 'no' },
    ]);
    svc().beginStack(0, 'web', 'update', 'tester', { deployedGenerationId: null });
    await ticks(1);
    setContainers([
      {
        id: 'app', name: 'web-app-1', service: 'app', state: 'running',
        restartPolicy: 'unless-stopped', health: 'starting',
      },
      { id: 'job', name: 'web-migrate-1', service: 'migrate', state: 'exited', exitCode: 0, restartPolicy: 'no' },
    ]);
    await ticks(1);
    expect(latest().status).toBe('observing');
    await ticks(6);
    expect(latest().status).toBe('unknown');
    expect(latest().reason).toContain('still starting');
  });

  it('fails when exit 0 has unless-stopped restart policy', async () => {
    svc().beginStack(0, 'web', 'update', 'tester', { deployedGenerationId: null });
    await ticks(1);
    setContainers([{ id: 'aaa', name: 'web-app-1', state: 'exited', exitCode: 0, restartPolicy: 'unless-stopped' }]);
    await ticks(1);
    expect(latest().status).toBe('failed');
    expect(latest().reason).toContain('exited during observation');
  });

  it('fails when exit 0 has always restart policy', async () => {
    svc().beginStack(0, 'web', 'update', 'tester', { deployedGenerationId: null });
    await ticks(1);
    setContainers([{ id: 'aaa', name: 'web-app-1', state: 'exited', exitCode: 0, restartPolicy: 'always' }]);
    await ticks(1);
    expect(latest().status).toBe('failed');
    expect(latest().reason).toContain('exited during observation');
  });

  it('fails closed when exit code is null on an exited container', async () => {
    svc().beginStack(0, 'web', 'update', 'tester', { deployedGenerationId: null });
    await ticks(1);
    setContainers([{ id: 'aaa', name: 'web-app-1', state: 'exited', exitCode: null, restartPolicy: 'no' }]);
    await ticks(1);
    expect(latest().status).toBe('failed');
    expect(latest().reason).toContain('exited during observation');
  });

  it('fails when a one-shot exits non-zero', async () => {
    svc().beginStack(0, 'web', 'update', 'tester', { deployedGenerationId: null });
    await ticks(1);
    setContainers([{ id: 'aaa', name: 'web-app-1', state: 'exited', exitCode: 1, restartPolicy: 'no' }]);
    await ticks(1);
    expect(latest().status).toBe('failed');
    expect(latest().reason).toContain('exited during observation');
  });

  it('fails fast when a healthcheck reports unhealthy', async () => {
    svc().beginStack(0, 'web', 'update', 'tester', { deployedGenerationId: null });
    await ticks(1);
    setContainers([{ id: 'aaa', name: 'web-app-1', health: 'unhealthy' }]);
    await ticks(1);
    expect(latest().status).toBe('failed');
    expect(latest().reason).toContain('unhealthy');
  });

  it('detects a restart loop via container replacement (new id)', async () => {
    svc().beginStack(0, 'web', 'update', 'tester', { deployedGenerationId: null });
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
    svc().beginStack(0, 'web', 'update', 'tester', { deployedGenerationId: null });
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
    svc().beginStack(0, 'web', 'update', 'tester', { deployedGenerationId: null });
    await ticks(1); // baseline
    setContainers([]); // one missed poll: tolerated
    await ticks(1);
    setContainers([{ id: 'aaa', name: 'web-app-1' }]); // back before the second miss
    await ticks(5); // through the 30s window
    expect(latest().status).toBe('passed');

    const second = svc().beginStack(0, 'web', 'update', 'tester', { deployedGenerationId: null })!;
    await ticks(1);
    setContainers([]);
    await ticks(2); // two consecutive misses: disappeared
    const report = svc().getReport(0, 'web', second);
    expect(report.status).toBe('failed');
    expect(report.reason).toContain('disappeared');
  });

  it('fails when a container is stuck restarting across consecutive polls', async () => {
    svc().beginStack(0, 'web', 'update', 'tester', { deployedGenerationId: null });
    await ticks(1);
    setContainers([{ id: 'aaa', name: 'web-app-1', state: 'restarting' }]);
    await ticks(2);
    expect(latest().status).toBe('failed');
    expect(latest().reason).toContain('restarting');
  });

  it('goes unknown after three consecutive docker errors', async () => {
    svc().beginStack(0, 'web', 'update', 'tester', { deployedGenerationId: null });
    await ticks(1);
    state.listContainers.mockRejectedValue(new Error('socket gone'));
    await ticks(3);
    expect(latest().status).toBe('unknown');
    expect(latest().reason).toContain('unreachable');
  });

  it('resolves unknown when every docker observe hangs', async () => {
    svc().beginStack(0, 'web', 'update', 'tester', { deployedGenerationId: null });
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
    svc().beginStack(0, 'web', 'update', 'tester', { deployedGenerationId: null });
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
    svc().beginStack(0, 'web', 'update', 'tester', { deployedGenerationId: null });
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
    svc().beginStack(0, 'web', 'update', 'tester', { deployedGenerationId: null });
    setContainers([{ id: 'aaa', name: 'web-app-1', health: 'starting' }]);
    await ticks(7);
    expect(latest().status).toBe('unknown');
    expect(latest().reason).toContain('still starting');
  });

  it('goes unknown when no containers ever appear', async () => {
    setContainers([]);
    svc().beginStack(0, 'web', 'update', 'tester', { deployedGenerationId: null });
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
    const first = svc().beginStack(0, 'web', 'update', 'tester', { deployedGenerationId: null })!;
    await ticks(2); // baseline established, healthy

    let releasePoll: (value: Array<{ Id: string; Names: string[]; State: string }>) => void = () => {};
    state.listContainers.mockImplementationOnce(
      () => new Promise(resolve => { releasePoll = resolve; }),
    );
    const straddlingPoll = vi.advanceTimersByTimeAsync(5_000); // poll now awaiting Docker

    const second = svc().beginStack(0, 'web', 'update', 'tester', { deployedGenerationId: null })!;
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
    const first = svc().beginStack(0, 'web', 'update', 'tester', { deployedGenerationId: null })!;
    await ticks(1);
    const timersBefore = vi.getTimerCount();
    const second = svc().beginStack(0, 'web', 'update', 'tester', { deployedGenerationId: null })!;
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
      target_scope: 'stack', service_name: null, failure_source: null,
    });
    svc().start();
    expect(state.runs.get('stale')!.status).toBe('unknown');
    expect(state.runs.get('stale')!.reason).toContain('restarted');
  });

  it('start() finalizes every interrupted run even when one of them is unreadable', () => {
    state.runs.set('bad', {
      id: 'bad', node_id: 0, stack_name: 'web', trigger_action: 'update', status: 'observing',
      reason: null, window_seconds: 30, containers_json: '[]', started_at: 1, ended_at: null, created_by: null,
      target_scope: 'stack', service_name: null, failure_source: null,
    });
    state.runs.set('good', {
      id: 'good', node_id: 0, stack_name: 'other', trigger_action: 'recovery', status: 'observing',
      reason: null, window_seconds: 30, containers_json: '[]', started_at: 1, ended_at: null, created_by: null,
      target_scope: 'stack', service_name: null, failure_source: null,
    });
    // One row that cannot be written must not cost every later row its verdict.
    // A bulk sweep is what this replaced, and it told the model about none of
    // them; finalizing per row is only better if one bad row stays contained.
    state.failFinalizeFor = 'bad';

    svc().start();

    expect(state.runs.get('bad')!.status).toBe('observing');
    expect(state.runs.get('good')!.status).toBe('unknown');
  });
});

describe('HealthGateService recovery reservations', () => {
  /** A reserved, committed recovery run as `compensateWithCandidate` leaves it. */
  function reserve(recoveryRef = 'rec-1', stackName = 'web') {
    state.recoveries.set(recoveryRef, { id: recoveryRef, health_gate_id: null });
    return svc().reserveRecoveryRun({
      recoveryRef,
      nodeId: 0,
      stackName,
      deployedGenerationId: 'gen-1',
      actor: 'system:recovery',
    });
  }

  it('writes the run and links it to the recovery generation', () => {
    const result = reserve();
    expect(result.outcome).toBe('reserved');
    expect(result.runId).toBeTruthy();

    const run = state.runs.get(result.runId!)!;
    expect(run.trigger_action).toBe('recovery');
    expect(run.status).toBe('observing');
    // The generation is on the row, so the verdict is attributed to what this
    // run was recorded as observing rather than to whatever is current later.
    expect(run.deployed_generation_id).toBe('gen-1');
    expect(state.recoveries.get('rec-1')!.health_gate_id).toBe(result.runId);
    // Reserving is a write, not an observation: no timer yet.
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reuses the run a replayed recovery already owns', () => {
    const first = reserve();
    const second = svc().reserveRecoveryRun({
      recoveryRef: 'rec-1',
      nodeId: 0,
      stackName: 'web',
      deployedGenerationId: 'gen-1',
      actor: 'system:recovery',
    });
    expect(second.outcome).toBe('replayed');
    expect(second.runId).toBe(first.runId);
    expect(state.runs.size).toBe(1);
  });

  it('reserves nothing when the gate is disabled', () => {
    state.settings.health_gate_enabled = '0';
    const result = reserve();
    expect(result).toEqual({ outcome: 'disabled', runId: null });
    expect(state.runs.size).toBe(0);
  });

  it('arms a reserved run without inserting a second one, and is idempotent', async () => {
    const { runId } = reserve();
    svc().armReservedRun(runId!, 0, 'web');
    expect(state.runs.size).toBe(1);

    // Arming the run that is already the active gate must not supersede it.
    svc().armReservedRun(runId!, 0, 'web');
    expect(state.runs.size).toBe(1);
    expect(state.runs.get(runId!)!.status).toBe('observing');

    await ticks(7);
    expect(state.runs.get(runId!)!.status).toBe('passed');
  });

  it('supersedes a conflicting stack gate rather than observing twice', async () => {
    const older = svc().beginStack(0, 'web', 'update', 'tester', { deployedGenerationId: null });
    const { runId } = reserve();
    svc().armReservedRun(runId!, 0, 'web');

    expect(state.runs.get(older!)!.status).toBe('unknown');
    expect(state.runs.get(older!)!.reason).toContain('superseded');
    await ticks(7);
    expect(state.runs.get(runId!)!.status).toBe('passed');
  });

  it('refuses to arm a run that is not a reserved stack recovery', () => {
    const { runId } = reserve();
    state.runs.get(runId!)!.trigger_action = 'update';
    expect(() => svc().armReservedRun(runId!, 0, 'web')).toThrow(/reserved stack recovery/);

    expect(() => svc().armReservedRun('no-such-run', 0, 'web')).toThrow(/not found/);
  });

  it('refuses to arm anything once the service is stopped', () => {
    const { runId } = reserve();
    svc().stop();
    expect(() => svc().armReservedRun(runId!, 0, 'web')).toThrow(/not started/);
    svc().start();
  });

  it('writes off a reservation nothing could arm', () => {
    const { runId } = reserve();
    svc().abandonReservedRun(runId!, 0, 'web', 'could not arm: too many concurrent observations');

    const run = state.runs.get(runId!)!;
    expect(run.status).toBe('unknown');
    expect(run.reason).toContain('could not arm');
    // Writing it off twice must not reopen or rewrite it.
    svc().abandonReservedRun(runId!, 0, 'web', 'second attempt');
    expect(state.runs.get(runId!)!.reason).toContain('could not arm');
  });

  it('never arms a reservation that outlived its process', () => {
    const { runId } = reserve();
    // A restart: the row is still observing, and nothing in memory owns it.
    svc().stop();
    svc().start();

    expect(state.runs.get(runId!)!.status).toBe('unknown');
    expect(state.runs.get(runId!)!.reason).toContain('restarted');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('no-ops when disabled but still records the update_started event', () => {
    state.settings.health_gate_enabled = '0';
    const id = svc().beginStack(0, 'web', 'update', 'tester', { deployedGenerationId: null });
    expect(id).toBeNull();
    expect(state.runs.size).toBe(0);
    expect(state.activity.some(a => a.category === 'update_started')).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('records update_started for update triggers but not deploy triggers', () => {
    svc().beginStack(0, 'web', 'deploy', 'tester', { deployedGenerationId: null });
    expect(state.activity.some(a => a.category === 'update_started')).toBe(false);
    svc().beginStack(0, 'web', 'update', 'tester', { deployedGenerationId: null });
    expect(state.activity.some(a => a.category === 'update_started')).toBe(true);
  });

  it('refuses to begin before start() so shutdown cannot leak timers', () => {
    svc().stop();
    expect(svc().beginStack(0, 'web', 'update', 'tester', { deployedGenerationId: null })).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    svc().start();
  });

  it('persists an immediate unknown past the concurrency cap', () => {
    for (let i = 0; i < 25; i++) {
      svc().beginStack(0, `stack-${i}`, 'update', 'tester', { deployedGenerationId: null });
    }
    const overCap = svc().beginStack(0, 'one-too-many', 'update', 'tester', { deployedGenerationId: null })!;
    const report = svc().getReport(0, 'one-too-many', overCap);
    expect(report.status).toBe('unknown');
    expect(report.reason).toContain('concurrent');
  });

  it('clamps the configured window into its valid range and falls back on garbage', () => {
    state.settings.health_gate_window_seconds = '99999';
    const a = svc().beginStack(0, 'web', 'update', 'tester', { deployedGenerationId: null })!;
    expect(svc().getReport(0, 'web', a).windowSeconds).toBe(600);
    state.settings.health_gate_window_seconds = 'banana';
    const b = svc().beginStack(0, 'web', 'update', 'tester', { deployedGenerationId: null })!;
    expect(svc().getReport(0, 'web', b).windowSeconds).toBe(90);
  });

  it('returns the never-run sentinel for a stack with no runs', () => {
    const report = svc().getReport(0, 'nothing-here');
    expect(report.status).toBe('never-run');
    expect(report.id).toBeNull();
  });

  it('stop() finalizes in-flight gates as unknown with zero timers left', async () => {
    const id = svc().beginStack(0, 'web', 'update', 'tester', { deployedGenerationId: null })!;
    await ticks(1);
    svc().stop();
    expect(vi.getTimerCount()).toBe(0);
    expect(svc().getReport(0, 'web', id).status).toBe('unknown');
    svc().start();
  });
});
