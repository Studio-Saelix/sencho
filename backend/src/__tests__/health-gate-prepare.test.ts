/**
 * Tests for the service-scoped health gate: prepare/attach/beginPrepared
 * nullability (disabled, unknown token, concurrency cap, armed), the prepare
 * TTL, and primary vs collateral failure attribution (regression-eligible
 * siblings can fail the gate; pre-existing unhealthy siblings stay advisory).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

interface StoredRun {
  id: string;
  node_id: number;
  stack_name: string;
  trigger_action: 'update' | 'deploy' | 'service_update' | 'service_restore';
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

const { state } = vi.hoisted(() => ({
  state: {
    runs: new Map<string, StoredRun>(),
    settings: {} as Record<string, string>,
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

// AutoHeal suppression is exercised elsewhere; here we only need the calls to
// not throw when the gate finalizes a service run.
vi.mock('../services/AutoHealService', () => ({
  AutoHealService: { getInstance: () => ({ clearSuppress: vi.fn() }) },
}));

import { HealthGateService } from '../services/HealthGateService';

type Fixture = {
  id: string;
  name: string;
  service: string;
  state?: string;
  health?: string | null;
  restartCount?: number;
  startedAt?: string;
  imageId?: string;
  exitCode?: number | null;
  restartPolicy?: string | null;
};

function setContainers(fixtures: Fixture[]): void {
  state.listContainers.mockResolvedValue(fixtures.map(f => ({
    Id: f.id,
    Names: [`/${f.name}`],
    State: f.state ?? 'running',
    Labels: { 'com.docker.compose.service': f.service },
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
      Image: f.imageId ?? 'sha256:app',
      HostConfig: { RestartPolicy: { Name: f.restartPolicy ?? 'unless-stopped' } },
      Config: { Labels: { 'com.docker.compose.service': f.service } },
    });
  });
}

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

async function ticks(n: number): Promise<void> {
  for (let i = 0; i < n; i++) await vi.advanceTimersByTimeAsync(5_000);
}

async function prepareService(
  fixtures: Fixture[],
  opts: { serviceName?: string; expectedReplicas?: number; trigger?: 'service_update' | 'service_restore' } = {},
): Promise<string> {
  setContainers(fixtures);
  const { prepareToken } = await svc().prepare({
    nodeId: 0,
    stackName: 'web',
    target: { scope: 'service', serviceName: opts.serviceName ?? 'app' },
    trigger: opts.trigger ?? 'service_update',
    expectedReplicas: opts.expectedReplicas ?? 1,
  });
  return prepareToken;
}

beforeEach(() => {
  vi.useFakeTimers();
  state.runs.clear();
  state.settings = { health_gate_enabled: '1', health_gate_window_seconds: '30' };
  state.listContainers.mockReset();
  state.inspect.mockReset();
  state.renderConfig.mockReset();
  setDeclaredRestarts({ app: 'unless-stopped', db: 'unless-stopped' });
  svc().start();
});

afterEach(() => {
  svc().stop();
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers();
});

describe('container-op supersede across sibling service gates', () => {
  it('detaches a deliberately stopped service from a sibling gate and keeps the sibling observing', async () => {
    // app is being observed after its update, and db is one of its
    // regression-eligible collateral siblings. The operator then stops db on
    // purpose, so db's containers leave app's observed set. Keeping them in
    // would fail app's gate on a deliberate stop and offer a Restore for a
    // service that is healthy; ending app's gate instead would throw away the
    // verdict the operator still needs.
    const token = await prepareService([
      { id: 'p1', name: 'web-app-1', service: 'app' },
      { id: 's1', name: 'web-db-1', service: 'db' },
    ]);
    svc().attachExpectedImage(token, 'sha256:app');
    const { runId } = svc().beginPrepared({ prepareToken: token, actor: 'tester' });
    await ticks(1); // arm expected from the primary plus the prepare collateral baseline

    setContainers([
      { id: 'p1', name: 'web-app-1', service: 'app' },
      { id: 's1', name: 'web-db-1', service: 'db', state: 'exited', exitCode: 0, restartPolicy: 'unless-stopped' },
    ]);
    // A sibling stays observing, so it is not counted among the ended gates.
    expect(svc().supersedeForContainerOp(0, 'web', 'the service db was stopped during the observation', ['db'])).toBe(0);
    await ticks(1);
    expect(svc().getReport(0, 'web', runId!).status).toBe('observing');

    // Past the window: app is up and db is deliberately down, so the gate passes
    // on its own runtime rather than reporting the operator's stop as a failure.
    await ticks(7);
    const report = svc().getReport(0, 'web', runId!);
    expect(report.status).toBe('passed');
    expect(report.failureSource).toBeNull();
  });

  it('detaches a service from a prepare that has not begun yet', async () => {
    // The window between prepare and begin is the compose up itself, so a
    // deliberate stop can land inside it. A gate armed afterwards seeds its
    // collateral set from the prepare baseline, which must no longer hold the
    // stopped service.
    const token = await prepareService([
      { id: 'p1', name: 'web-app-1', service: 'app' },
      { id: 's1', name: 'web-db-1', service: 'db' },
    ]);
    svc().attachExpectedImage(token, 'sha256:app');
    setContainers([
      { id: 'p1', name: 'web-app-1', service: 'app' },
      { id: 's1', name: 'web-db-1', service: 'db', state: 'exited', exitCode: 0, restartPolicy: 'unless-stopped' },
    ]);
    svc().supersedeForContainerOp(0, 'web', 'the service db was stopped during the observation', ['db']);

    const { runId } = svc().beginPrepared({ prepareToken: token, actor: 'tester' });
    await ticks(7);
    expect(svc().getReport(0, 'web', runId!).status).toBe('passed');
  });

  it('drops every pending prepare on the stack when the whole runtime is replaced', async () => {
    // The window between a prepare and its begin is the compose up, so a
    // stack-wide stop can land inside it. A gate armed afterwards would seed from
    // the pre-stop baseline and fail on the services that are now deliberately
    // down, which records a failure and offers a Restore. There is nothing left
    // for it to judge, so the token is dropped and the update simply reports no
    // gate.
    const token = await prepareService([
      { id: 'p1', name: 'web-app-1', service: 'app' },
      { id: 's1', name: 'web-db-1', service: 'db' },
    ]);
    setContainers([
      { id: 'p1', name: 'web-app-1', service: 'app', state: 'exited', exitCode: 0, restartPolicy: 'unless-stopped' },
      { id: 's1', name: 'web-db-1', service: 'db', state: 'exited', exitCode: 0, restartPolicy: 'unless-stopped' },
    ]);
    svc().supersedeForContainerOp(0, 'web', 'the stack was stopped during the observation');

    const { runId, observing } = svc().beginPrepared({ prepareToken: token, actor: 'tester' });
    expect(observing).toBe(false);
    expect(runId).toBeNull();
    await ticks(7);
    expect(state.runs.size).toBe(0);
  });

  it('says a dropped prepare had no gate because a container operation ended it', async () => {
    // The update is ungated, and the response has to be able to say why rather
    // than leaving a successful update with nothing watching it. A token this
    // process never issued must not be reported the same way.
    const token = await prepareService([
      { id: 'p1', name: 'web-app-1', service: 'app' },
      { id: 's1', name: 'web-db-1', service: 'db' },
    ], { serviceName: 'db' });
    // db's own update is the one whose observation the stop invalidates, so its
    // pending token is the one that goes. app's token is only detached.
    svc().supersedeForContainerOp(0, 'web', 'the service db was stopped during the observation', ['db']);

    expect(svc().beginPrepared({ prepareToken: token, actor: 'tester' }).droppedByContainerOp).toBe(true);
    expect(svc().beginPrepared({ prepareToken: 'never-issued', actor: 'tester' }).droppedByContainerOp).toBe(false);

    const live = await prepareService([{ id: 'p1', name: 'web-app-1', service: 'app' }], { serviceName: 'worker' });
    expect(svc().beginPrepared({ prepareToken: live, actor: 'tester' }).droppedByContainerOp).toBe(false);
  });

  it('ends the operated service gate, and leaves the sibling gate alone', async () => {
    // Two services on one stack, each with its own gate. The operated service's
    // own gate is judging the very container that is about to be stopped, so it
    // ends as unknown. The sibling's gate is not: the rule table in
    // supersedeForContainerOp covers the stack gate, which cannot be exercised
    // alongside a service gate because a stack begin supersedes those.
    setContainers([{ id: 'a1', name: 'web-app-1', service: 'app' }, { id: 'd1', name: 'web-db-1', service: 'db' }]);
    const appToken = await prepareService([{ id: 'a1', name: 'web-app-1', service: 'app' }], { serviceName: 'app' });
    const appRun = svc().beginPrepared({ prepareToken: appToken, actor: 'tester' }).runId!;
    const dbToken = await prepareService([{ id: 'd1', name: 'web-db-1', service: 'db' }], { serviceName: 'db' });
    const dbRun = svc().beginPrepared({ prepareToken: dbToken, actor: 'tester' }).runId!;
    await ticks(1);

    expect(svc().supersedeForContainerOp(0, 'web', 'the service app was stopped during the observation', ['app'])).toBe(1);
    const appReport = svc().getReport(0, 'web', appRun);
    expect(appReport.status).toBe('unknown');
    expect(appReport.reason).toBe('the service app was stopped during the observation');
    expect(svc().getReport(0, 'web', dbRun).status).toBe('observing');
  });

  it('ends every gate on the stack when the whole runtime is being replaced', async () => {
    // A stack stop or take-down replaces every service's containers, so there
    // is nothing left for a sibling gate to judge: no service is named, and all
    // three end.
    setContainers([{ id: 'a1', name: 'web-app-1', service: 'app' }, { id: 'd1', name: 'web-db-1', service: 'db' }]);
    const appToken = await prepareService([{ id: 'a1', name: 'web-app-1', service: 'app' }], { serviceName: 'app' });
    const appRun = svc().beginPrepared({ prepareToken: appToken, actor: 'tester' }).runId!;
    setContainers([{ id: 'd1', name: 'web-db-1', service: 'db' }]);
    const dbToken = await prepareService([{ id: 'd1', name: 'web-db-1', service: 'db' }], { serviceName: 'db' });
    const dbRun = svc().beginPrepared({ prepareToken: dbToken, actor: 'tester' }).runId!;
    await ticks(1);

    expect(svc().supersedeForContainerOp(0, 'web', 'the stack was stopped during the observation')).toBe(2);
    for (const run of [appRun, dbRun]) {
      const report = svc().getReport(0, 'web', run);
      expect(report.status).toBe('unknown');
      expect(report.reason).toBe('the stack was stopped during the observation');
    }
  });
});

describe('prepare / beginPrepared nullability', () => {
  it('prepare returns a token with a TTL that outlives the Compose timeout', async () => {
    const before = Date.now();
    setContainers([{ id: 'p1', name: 'web-app-1', service: 'app' }]);
    const { prepareToken, expiresAt } = await svc().prepare({
      nodeId: 0, stackName: 'web', target: { scope: 'service', serviceName: 'app' },
      trigger: 'service_update', expectedReplicas: 1,
    });
    expect(prepareToken).toBeTruthy();
    // Default compose timeout is 30m; prepare TTL is max(timeout, 30m) + 5m.
    expect(expiresAt).toBe(before + 35 * 60_000);
  });

  it('returns runId null / observing false when gating is disabled', async () => {
    const token = await prepareService([{ id: 'p1', name: 'web-app-1', service: 'app' }]);
    state.settings.health_gate_enabled = '0';
    expect(svc().beginPrepared({ prepareToken: token, actor: 'tester' }))
      .toEqual({ runId: null, observing: false, droppedByContainerOp: false });
  });

  it('returns runId null / observing false for an unknown or consumed token', async () => {
    const token = await prepareService([{ id: 'p1', name: 'web-app-1', service: 'app' }]);
    // First consume arms a gate; the second call sees a consumed token.
    svc().attachExpectedImage(token, 'sha256:app');
    const first = svc().beginPrepared({ prepareToken: token, actor: 'tester' });
    expect(first.observing).toBe(true);
    expect(svc().beginPrepared({ prepareToken: token, actor: 'tester' }))
      .toEqual({ runId: null, observing: false, droppedByContainerOp: false });
  });

  it('persists an immediate unknown past the concurrency cap', async () => {
    for (let i = 0; i < 25; i++) svc().beginStack(0, `stack-${i}`, 'update', 'tester', { deployedGenerationId: null });
    const token = await prepareService([{ id: 'p1', name: 'web-app-1', service: 'app' }]);
    svc().attachExpectedImage(token, 'sha256:app');
    const result = svc().beginPrepared({ prepareToken: token, actor: 'tester' });
    expect(result.runId).toBeTruthy();
    expect(result.observing).toBe(false);
    const report = svc().getReport(0, 'web', result.runId!);
    expect(report.status).toBe('unknown');
    expect(report.reason).toContain('concurrent');
  });
});

describe('primary vs collateral attribution', () => {
  it('fails with failureSource primary when a replica reports unhealthy', async () => {
    const token = await prepareService([
      { id: 'p1', name: 'web-app-1', service: 'app' },
      { id: 's1', name: 'web-db-1', service: 'db' },
    ]);
    svc().attachExpectedImage(token, 'sha256:app');
    const { runId } = svc().beginPrepared({ prepareToken: token, actor: 'tester' });
    await ticks(1); // arm expected set
    setContainers([
      { id: 'p1', name: 'web-app-1', service: 'app', health: 'unhealthy' },
      { id: 's1', name: 'web-db-1', service: 'db' },
    ]);
    await ticks(1);
    const report = svc().getReport(0, 'web', runId!);
    expect(report.status).toBe('failed');
    expect(report.failureSource).toBe('primary');
  });

  it('fails with failureSource collateral when a regression-eligible sibling exits', async () => {
    const token = await prepareService([
      { id: 'p1', name: 'web-app-1', service: 'app' },
      { id: 's1', name: 'web-db-1', service: 'db' },
    ]);
    svc().attachExpectedImage(token, 'sha256:app');
    const { runId } = svc().beginPrepared({ prepareToken: token, actor: 'tester' });
    await ticks(1);
    setContainers([
      { id: 'p1', name: 'web-app-1', service: 'app' },
      { id: 's1', name: 'web-db-1', service: 'db', state: 'exited', exitCode: 1, restartPolicy: 'unless-stopped' },
    ]);
    await ticks(1);
    const report = svc().getReport(0, 'web', runId!);
    expect(report.status).toBe('failed');
    expect(report.failureSource).toBe('collateral');
  });

  it('passes when a collateral one-shot exits 0 with restart no', async () => {
    setDeclaredRestarts({ app: 'unless-stopped', migrate: 'no' });
    const token = await prepareService([
      { id: 'p1', name: 'web-app-1', service: 'app', restartPolicy: 'unless-stopped' },
      { id: 's1', name: 'web-migrate-1', service: 'migrate', restartPolicy: 'no' },
    ]);
    svc().attachExpectedImage(token, 'sha256:app');
    const { runId } = svc().beginPrepared({ prepareToken: token, actor: 'tester' });
    await ticks(1);
    setContainers([
      { id: 'p1', name: 'web-app-1', service: 'app', restartPolicy: 'unless-stopped' },
      { id: 's1', name: 'web-migrate-1', service: 'migrate', state: 'exited', exitCode: 0, restartPolicy: 'no' },
    ]);
    await ticks(1);
    expect(svc().getReport(0, 'web', runId!).status).toBe('observing');
    await ticks(6);
    expect(svc().getReport(0, 'web', runId!).status).toBe('passed');
  });

  it('passes a collateral one-shot with residual unhealthy health', async () => {
    setDeclaredRestarts({ app: 'unless-stopped', migrate: 'no' });
    const token = await prepareService([
      { id: 'p1', name: 'web-app-1', service: 'app', restartPolicy: 'unless-stopped' },
      { id: 's1', name: 'web-migrate-1', service: 'migrate', restartPolicy: 'no' },
    ]);
    svc().attachExpectedImage(token, 'sha256:app');
    const { runId } = svc().beginPrepared({ prepareToken: token, actor: 'tester' });
    await ticks(1);
    setContainers([
      { id: 'p1', name: 'web-app-1', service: 'app', restartPolicy: 'unless-stopped' },
      {
        id: 's1', name: 'web-migrate-1', service: 'migrate', state: 'exited', exitCode: 0,
        restartPolicy: 'no', health: 'unhealthy',
      },
    ]);
    await ticks(1);
    expect(svc().getReport(0, 'web', runId!).status).toBe('observing');
    await ticks(6);
    expect(svc().getReport(0, 'web', runId!).status).toBe('passed');
  });

  it('fails when a collateral daemon with omitted restart exits 0', async () => {
    setDeclaredRestarts({ app: 'unless-stopped', 'daemon-default': undefined });
    const token = await prepareService([
      { id: 'p1', name: 'web-app-1', service: 'app', restartPolicy: 'unless-stopped' },
      { id: 's1', name: 'web-daemon-1', service: 'daemon-default', restartPolicy: 'no' },
    ]);
    svc().attachExpectedImage(token, 'sha256:app');
    const { runId } = svc().beginPrepared({ prepareToken: token, actor: 'tester' });
    await ticks(1);
    setContainers([
      { id: 'p1', name: 'web-app-1', service: 'app', restartPolicy: 'unless-stopped' },
      {
        id: 's1', name: 'web-daemon-1', service: 'daemon-default',
        state: 'exited', exitCode: 0, restartPolicy: 'no',
      },
    ]);
    await ticks(1);
    const report = svc().getReport(0, 'web', runId!);
    expect(report.status).toBe('failed');
    expect(report.failureSource).toBe('collateral');
    expect(report.reason).toContain('exited during observation');
  });

  it('passes when the primary service is a completed one-shot', async () => {
    setDeclaredRestarts({ job: 'no' });
    const token = await prepareService([
      { id: 'p1', name: 'web-job-1', service: 'job', restartPolicy: 'no' },
    ], { serviceName: 'job', expectedReplicas: 1 });
    svc().attachExpectedImage(token, 'sha256:app');
    const { runId } = svc().beginPrepared({ prepareToken: token, actor: 'tester' });
    await ticks(1);
    setContainers([
      { id: 'p1', name: 'web-job-1', service: 'job', state: 'exited', exitCode: 0, restartPolicy: 'no', imageId: 'sha256:app' },
    ]);
    await ticks(1);
    expect(svc().getReport(0, 'web', runId!).status).toBe('observing');
    await ticks(6);
    expect(svc().getReport(0, 'web', runId!).status).toBe('passed');
  });

  it('passes a primary one-shot with residual unhealthy health', async () => {
    setDeclaredRestarts({ job: 'no' });
    const token = await prepareService([
      { id: 'p1', name: 'web-job-1', service: 'job', restartPolicy: 'no' },
    ], { serviceName: 'job', expectedReplicas: 1 });
    svc().attachExpectedImage(token, 'sha256:app');
    const { runId } = svc().beginPrepared({ prepareToken: token, actor: 'tester' });
    await ticks(1);
    setContainers([
      {
        id: 'p1', name: 'web-job-1', service: 'job', state: 'exited', exitCode: 0,
        restartPolicy: 'no', health: 'unhealthy', imageId: 'sha256:app',
      },
    ]);
    await ticks(1);
    expect(svc().getReport(0, 'web', runId!).status).toBe('observing');
    await ticks(6);
    expect(svc().getReport(0, 'web', runId!).status).toBe('passed');
  });

  it('passes a primary one-shot with residual starting health', async () => {
    setDeclaredRestarts({ job: 'no' });
    const token = await prepareService([
      { id: 'p1', name: 'web-job-1', service: 'job', restartPolicy: 'no' },
    ], { serviceName: 'job', expectedReplicas: 1 });
    svc().attachExpectedImage(token, 'sha256:app');
    const { runId } = svc().beginPrepared({ prepareToken: token, actor: 'tester' });
    await ticks(1);
    setContainers([
      {
        id: 'p1', name: 'web-job-1', service: 'job', state: 'exited', exitCode: 0,
        restartPolicy: 'no', health: 'starting', imageId: 'sha256:app',
      },
    ]);
    await ticks(1);
    expect(svc().getReport(0, 'web', runId!).status).toBe('observing');
    await ticks(6);
    expect(svc().getReport(0, 'web', runId!).status).toBe('passed');
  });

  it('fails when a primary one-shot exits with null exit code', async () => {
    const token = await prepareService([
      { id: 'p1', name: 'web-job-1', service: 'job', restartPolicy: 'no' },
    ], { serviceName: 'job', expectedReplicas: 1 });
    svc().attachExpectedImage(token, 'sha256:app');
    const { runId } = svc().beginPrepared({ prepareToken: token, actor: 'tester' });
    await ticks(1);
    setContainers([
      { id: 'p1', name: 'web-job-1', service: 'job', state: 'exited', exitCode: null, restartPolicy: 'no', imageId: 'sha256:app' },
    ]);
    await ticks(1);
    const report = svc().getReport(0, 'web', runId!);
    expect(report.status).toBe('failed');
    expect(report.reason).toContain('exited during observation');
    expect(report.failureSource).toBe('primary');
  });

  it('fails when a primary one-shot exits 0 under unless-stopped', async () => {
    const token = await prepareService([
      { id: 'p1', name: 'web-job-1', service: 'job', restartPolicy: 'unless-stopped' },
    ], { serviceName: 'job', expectedReplicas: 1 });
    svc().attachExpectedImage(token, 'sha256:app');
    const { runId } = svc().beginPrepared({ prepareToken: token, actor: 'tester' });
    await ticks(1);
    setContainers([
      { id: 'p1', name: 'web-job-1', service: 'job', state: 'exited', exitCode: 0, restartPolicy: 'unless-stopped', imageId: 'sha256:app' },
    ]);
    await ticks(1);
    const report = svc().getReport(0, 'web', runId!);
    expect(report.status).toBe('failed');
    expect(report.reason).toContain('exited during observation');
    expect(report.failureSource).toBe('primary');
  });

  it('fails when a primary one-shot exits non-zero', async () => {
    const token = await prepareService([
      { id: 'p1', name: 'web-job-1', service: 'job', restartPolicy: 'no' },
    ], { serviceName: 'job', expectedReplicas: 1 });
    svc().attachExpectedImage(token, 'sha256:app');
    const { runId } = svc().beginPrepared({ prepareToken: token, actor: 'tester' });
    await ticks(1);
    setContainers([
      { id: 'p1', name: 'web-job-1', service: 'job', state: 'exited', exitCode: 1, restartPolicy: 'no', imageId: 'sha256:app' },
    ]);
    await ticks(1);
    const report = svc().getReport(0, 'web', runId!);
    expect(report.status).toBe('failed');
    expect(report.reason).toContain('exited during observation');
    expect(report.failureSource).toBe('primary');
  });

  it('fails with failureSource collateral when a healthy sibling vanishes before the first poll', async () => {
    // Sibling is healthy at prepare, then gone before arming. Seeding expected
    // from the prepare baseline must still track it so the gate fails.
    const token = await prepareService([
      { id: 'p1', name: 'web-app-1', service: 'app' },
      { id: 's1', name: 'web-db-1', service: 'db' },
    ]);
    svc().attachExpectedImage(token, 'sha256:app');
    setContainers([
      { id: 'p1', name: 'web-app-1', service: 'app' },
    ]);
    const { runId } = svc().beginPrepared({ prepareToken: token, actor: 'tester' });
    await ticks(1); // arm expected from primary + prepare collateral baseline
    await ticks(1); // first miss on the vanished sibling
    await ticks(1); // second miss fails the gate
    const report = svc().getReport(0, 'web', runId!);
    expect(report.status).toBe('failed');
    expect(report.failureSource).toBe('collateral');
    expect(report.reason ?? '').toMatch(/disappeared|sibling/i);
  });

  it('keeps a pre-existing unhealthy sibling advisory: the gate can still pass', async () => {
    // The sibling is unhealthy at prepare, so it is not regression-eligible and
    // cannot fail the service gate; the healthy primary carries it to a pass.
    const token = await prepareService([
      { id: 'p1', name: 'web-app-1', service: 'app' },
      { id: 's1', name: 'web-db-1', service: 'db', health: 'unhealthy' },
    ]);
    svc().attachExpectedImage(token, 'sha256:app');
    const { runId } = svc().beginPrepared({ prepareToken: token, actor: 'tester' });
    await ticks(8); // through the 30s window
    const report = svc().getReport(0, 'web', runId!);
    expect(report.status).toBe('passed');
    expect(report.failureSource).toBeNull();
  });

  it('lets different-service gates coexist while same-service begin supersedes', async () => {
    const appToken = await prepareService(
      [{ id: 'p1', name: 'web-app-1', service: 'app' }, { id: 's1', name: 'web-db-1', service: 'db' }],
      { serviceName: 'app' },
    );
    svc().attachExpectedImage(appToken, 'sha256:app');
    const appFirst = svc().beginPrepared({ prepareToken: appToken, actor: 'tester' });
    expect(appFirst.observing).toBe(true);

    const dbToken = await prepareService(
      [{ id: 'p1', name: 'web-app-1', service: 'app' }, { id: 's1', name: 'web-db-1', service: 'db' }],
      { serviceName: 'db' },
    );
    svc().attachExpectedImage(dbToken, 'sha256:db');
    const dbGate = svc().beginPrepared({ prepareToken: dbToken, actor: 'tester' });
    expect(dbGate.observing).toBe(true);
    expect(svc().getReport(0, 'web', appFirst.runId!).status).toBe('observing');
    expect(svc().getReport(0, 'web', dbGate.runId!).status).toBe('observing');

    const appToken2 = await prepareService(
      [{ id: 'p1', name: 'web-app-1', service: 'app' }, { id: 's1', name: 'web-db-1', service: 'db' }],
      { serviceName: 'app' },
    );
    svc().attachExpectedImage(appToken2, 'sha256:app2');
    const appSecond = svc().beginPrepared({ prepareToken: appToken2, actor: 'tester' });
    expect(appSecond.observing).toBe(true);
    expect(svc().getReport(0, 'web', appFirst.runId!).status).toBe('unknown');
    expect(svc().getReport(0, 'web', dbGate.runId!).status).toBe('observing');
    expect(svc().getReport(0, 'web', appSecond.runId!).status).toBe('observing');
  });
});
