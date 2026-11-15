import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import jwt from 'jsonwebtoken';
import { setupTestDb, cleanupTestDb, TEST_USERNAME } from './helpers/setupTestDb';
import { DatabaseService } from '../services/DatabaseService';
import { NodeReadinessService, type ReadinessFetch } from '../services/nodeBootstrap/NodeReadinessService';
import { buildReadinessReport, type ReadinessProbes } from '../routes/pilotReadiness';
import type { EnvironmentProbes } from '../services/EnvironmentCheckService';
import { PilotEnrollmentAttempts } from '../services/PilotEnrollmentAttempts';

/**
 * Readiness checks against a scripted Pilot. The fetch below runs the agent's
 * own report builder with stubbed host probes, so the hub's verdict is tested
 * against the report a real agent would send, and every failure is injected at
 * the transport: a tunnel that is down, drops mid-request, never answers,
 * answers twice, answers from an older agent, or reconnects while a check runs.
 */

const HUB_URL = 'https://hub.example.com';
const COMPOSE_DIR = '/opt/docker/sencho';
const AUDIT = { username: TEST_USERNAME, ip: '127.0.0.1', method: 'POST', path: '/api/nodes/bootstrap/operations/x/verify' };

let tmpDir: string;
let db: DatabaseService;

beforeAll(async () => {
  tmpDir = await setupTestDb();
  db = DatabaseService.getInstance();
});

afterAll(() => cleanupTestDb(tmpDir));

class FakeTunnels extends EventEmitter {
  public readonly up = new Set<number>();
  public confidential = true;
  public hasActiveTunnel(nodeId: number): boolean { return this.up.has(nodeId); }
  public getLoopbackUrl(nodeId: number): string | null { return this.up.has(nodeId) ? `http://127.0.0.1:${40000 + nodeId}` : null; }
  public isTunnelConfidential(): boolean { return this.confidential; }
  public connect(nodeId: number): void {
    this.up.add(nodeId);
    this.emit('tunnel-up', nodeId);
  }
  public disconnect(nodeId: number): void {
    this.up.delete(nodeId);
    this.emit('tunnel-down', nodeId);
  }
}

function environment(overrides: Partial<EnvironmentProbes> = {}): EnvironmentProbes {
  return {
    proto: 'https',
    host: 'pilot',
    composeDir: COMPOSE_DIR,
    pingDocker: async () => undefined,
    composeVersion: async () => '2.35.1',
    accessDir: async () => ({ exists: true, isDir: true, writable: true }),
    bindMounts: async () => [{ source: COMPOSE_DIR, destination: COMPOSE_DIR }],
    selfStackDirectoryName: async () => null,
    diskUsage: async () => ({ usePercent: 40, freeBytes: 50 * 1024 ** 3 }),
    ...overrides,
  };
}

interface AgentModel {
  nodeId: number;
  probes: Partial<ReadinessProbes>;
  env: Partial<EnvironmentProbes>;
}

function agentProbes(model: AgentModel): ReadinessProbes {
  return {
    environment: () => environment(model.env),
    dockerVersion: async () => ({ Version: '28.1.1', ApiVersion: '1.49' }),
    listContainers: async () => [
      { State: 'running', Labels: { 'com.docker.compose.project': 'sencho-agent' }, Mounts: [{ Type: 'volume', Name: 'sencho-agent_sencho-agent-data', Destination: '/app/data' }] },
      { State: 'running', Labels: { 'com.docker.compose.project': 'media' }, Mounts: [] },
    ],
    persistedToken: () => jwt.sign({ scope: 'pilot_tunnel', nodeId: model.nodeId }, 'hub-secret-the-agent-cannot-verify'),
    now: () => Date.now(),
    ...model.probes,
  };
}

/** A fetch that answers as the agent's own route would. */
function agentFetch(model: AgentModel): ReadinessFetch {
  return async (url) => {
    const nonce = new URL(url).searchParams.get('nonce') ?? '';
    return { status: 200, body: JSON.parse(JSON.stringify(await buildReadinessReport(nonce, agentProbes(model)))) };
  };
}

let counter = 0;
const services: NodeReadinessService[] = [];

function setup(options: { fetch?: ReadinessFetch; bootstrapped?: boolean; timeoutMs?: number } = {}) {
  counter += 1;
  process.env.SENCHO_PRIMARY_URL = HUB_URL;
  const nodeId = db.addNode({
    name: `readiness-${counter}`,
    type: 'remote',
    compose_dir: COMPOSE_DIR,
    is_default: false,
    api_url: '',
    api_token: '',
    mode: 'pilot_agent',
  });
  db.updateNode(nodeId, { pilot_agent_version: '0.0.0' });
  const operationId = `00000000-0000-4000-8000-${String(counter).padStart(12, '0')}`;
  if (options.bootstrapped !== false) db.markNodeReadinessProvisional(nodeId, operationId, HUB_URL, Date.now());
  const model: AgentModel = { nodeId, probes: {}, env: {} };
  const tunnels = new FakeTunnels();
  const fetch = vi.fn(options.fetch ?? agentFetch(model));
  const changed = vi.fn();
  const service = new NodeReadinessService({ db, tunnels, fetch, changed, timeoutMs: options.timeoutMs ?? 2_000 });
  services.push(service);
  return { nodeId, operationId, model, tunnels, fetch, service, changed };
}

/** The report builder reads the app version; the tests' tunnel announces the same one. */
function announce(nodeId: number, version: string): void {
  db.updateNode(nodeId, { pilot_agent_version: version });
}

async function settle(service: NodeReadinessService): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await service.settled();
}

afterEach(() => {
  for (const service of services.splice(0)) service.stop();
});

describe('node readiness', () => {
  it('checks a bootstrapped node when its tunnel comes up and records it ready', async () => {
    const { nodeId, tunnels, service, fetch } = setup();
    const version = (await buildReadinessReport('a'.repeat(32), agentProbes({ nodeId, probes: {}, env: {} }))).agent.version;
    announce(nodeId, version);
    service.start();
    expect(service.get(nodeId)?.state).toBe('provisional');
    tunnels.connect(nodeId);
    await settle(service);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:${40000 + nodeId}/api/pilot/readiness\\?nonce=[a-f0-9]{32}$`));
    const view = service.get(nodeId);
    expect(view).toMatchObject({ state: 'ready', agentVersion: version });
    expect(view?.gates.every((gate) => gate.status === 'pass')).toBe(true);
  });

  it('never checks a node that was not bootstrapped', async () => {
    const { nodeId, tunnels, service, fetch } = setup({ bootstrapped: false });
    service.start();
    tunnels.connect(nodeId);
    await settle(service);
    expect(fetch).not.toHaveBeenCalled();
    expect(service.get(nodeId)).toBeNull();
    expect(await service.verify(nodeId, AUDIT)).toBeNull();
    expect(db.getNodeReadiness(nodeId)).toBeUndefined();
  });

  it('records a node whose tunnel is down as not ready, without asking anything', async () => {
    const { nodeId, service, fetch } = setup();
    const view = await service.verify(nodeId, AUDIT);
    expect(fetch).not.toHaveBeenCalled();
    expect(view).toMatchObject({ state: 'not_ready' });
    expect(view?.gates).toEqual([expect.objectContaining({ id: 'tunnel', status: 'fail' })]);
  });

  it.each([
    ['a tunnel that drops mid-request', async () => { throw new Error('socket hang up'); }, 'tunnel', /socket hang up/],
    ['an older Pilot without the report', async () => ({ status: 404, body: { error: 'Not found' } }), 'contract', /does not provide/],
    ['a Pilot that refuses the hub', async () => ({ status: 403, body: { code: 'READINESS_HUB_ONLY' } }), 'contract', /refused/],
    ['a Pilot that errors', async () => ({ status: 500, body: {} }), 'tunnel', /HTTP 500/],
    ['an answer that is not a report', async () => ({ status: 200, body: '<html>proxy</html>' }), 'contract', /not a readiness report/],
  ] as Array<[string, ReadinessFetch, string, RegExp]>)('fails closed on %s', async (_label, fetch, gateId, summary) => {
    const { nodeId, tunnels, service } = setup({ fetch });
    tunnels.up.add(nodeId);
    const view = await service.verify(nodeId, AUDIT);
    expect(view?.state).toBe('not_ready');
    const gate = view?.gates.find((entry) => entry.id === gateId);
    expect(gate?.status === 'fail' || gate?.status === 'unknown').toBe(true);
    expect(gate?.summary).toMatch(summary);
  });

  it('fails closed when the Pilot never answers', async () => {
    const hang: ReadinessFetch = (_url, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
    const { nodeId, tunnels, service } = setup({ fetch: hang, timeoutMs: 20 });
    tunnels.up.add(nodeId);
    const view = await service.verify(nodeId, AUDIT);
    expect(view?.state).toBe('not_ready');
    expect(view?.gates.at(-1)).toMatchObject({ id: 'tunnel', status: 'unknown', summary: expect.stringMatching(/no answer within/) });
  });

  it('refuses a report that answers an earlier request', async () => {
    let stale: unknown = null;
    const { nodeId, model, tunnels, service } = setup({ fetch: async () => ({ status: 200, body: stale }) });
    const earlier = await buildReadinessReport('b'.repeat(32), agentProbes(model));
    announce(nodeId, earlier.agent.version);
    stale = JSON.parse(JSON.stringify(earlier));
    tunnels.up.add(nodeId);
    const view = await service.verify(nodeId, AUDIT);
    expect(view?.state).toBe('not_ready');
    expect(view?.gates.find((gate) => gate.id === 'contract')).toMatchObject({ status: 'fail' });
  });

  it('stays unverified when the tunnel is up but Docker or Compose is denied', async () => {
    const { nodeId, model, tunnels, service } = setup();
    model.env = {
      pingDocker: async () => { throw Object.assign(new Error('connect EACCES /var/run/docker.sock'), { code: 'EACCES' }); },
      composeVersion: async () => { throw new Error('docker: \'compose\' is not a docker command.'); },
    };
    model.probes = { dockerVersion: async () => { throw new Error('EACCES'); } };
    announce(nodeId, (await buildReadinessReport('c'.repeat(32), agentProbes(model))).agent.version);
    tunnels.up.add(nodeId);
    const view = await service.verify(nodeId, AUDIT);
    expect(view?.state).toBe('not_ready');
    const failed = view?.gates.filter((gate) => gate.status === 'fail' || gate.status === 'unknown').map((gate) => gate.id);
    expect(failed).toEqual(expect.arrayContaining(['docker_daemon', 'docker_compose']));
  });

  it('stays unverified when the Compose directory is not mounted into the Pilot', async () => {
    const { nodeId, model, tunnels, service } = setup();
    model.env = { bindMounts: async () => [], accessDir: async () => ({ exists: false, isDir: false, writable: false }) };
    announce(nodeId, (await buildReadinessReport('c'.repeat(32), agentProbes(model))).agent.version);
    tunnels.up.add(nodeId);
    const view = await service.verify(nodeId, AUDIT);
    expect(view?.state).toBe('not_ready');
    expect(view?.gates.find((gate) => gate.id === 'compose_dir')?.status).toBe('fail');
  });

  it('stays unverified when the answering Pilot is enrolled as another node', async () => {
    const { nodeId, model, tunnels, service } = setup();
    model.nodeId = nodeId + 1000;
    announce(nodeId, (await buildReadinessReport('c'.repeat(32), agentProbes(model))).agent.version);
    tunnels.up.add(nodeId);
    const view = await service.verify(nodeId, AUDIT);
    expect(view?.gates.find((gate) => gate.id === 'identity')).toMatchObject({ status: 'fail' });
  });

  it('never runs two checks for one node at once, and reruns once for a check asked while one ran', async () => {
    let release: () => void = () => undefined;
    let active = 0;
    let maxActive = 0;
    const answers: Array<'ready' | 'broken'> = ['ready', 'broken'];
    const { nodeId, model, tunnels, service } = setup({
      fetch: async (url) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        const answer = answers.shift();
        if (answer === 'ready') await new Promise<void>((resolve) => { release = resolve; });
        const nonce = new URL(url).searchParams.get('nonce') ?? '';
        const body = await buildReadinessReport(nonce, agentProbes(answer === 'broken' ? { ...model, env: { composeVersion: async () => { throw new Error('missing'); } } } : model));
        active -= 1;
        return { status: 200, body: JSON.parse(JSON.stringify(body)) };
      },
    });
    announce(nodeId, (await buildReadinessReport('c'.repeat(32), agentProbes(model))).agent.version);
    tunnels.up.add(nodeId);
    const first = service.verify(nodeId, AUDIT);
    await new Promise((resolve) => setImmediate(resolve));
    expect(service.get(nodeId)?.state).toBe('verifying');
    // A reconnect while the first check runs joins it instead of starting a second request.
    const second = service.verify(nodeId, AUDIT);
    release();
    const [a, b] = await Promise.all([first, second]);
    expect(maxActive).toBe(1);
    // The stored verdict is the newest answer, not the first one.
    expect(a?.state).toBe('not_ready');
    expect(b?.state).toBe('not_ready');
    expect(service.get(nodeId)?.gates.find((gate) => gate.id === 'docker_compose')?.status).toBe('fail');
  });

  it('fails closed when the agent reconnects with another version while a check runs', async () => {
    const { nodeId, model, tunnels, service } = setup({
      fetch: async (url) => {
        const nonce = new URL(url).searchParams.get('nonce') ?? '';
        const body = await buildReadinessReport(nonce, agentProbes(model));
        // The agent self-updated: the new tunnel announced a newer version before the old answer arrived.
        db.updateNode(nodeId, { pilot_agent_version: '99.0.0' });
        return { status: 200, body: JSON.parse(JSON.stringify(body)) };
      },
    });
    tunnels.up.add(nodeId);
    const view = await service.verify(nodeId, AUDIT);
    expect(view?.state).toBe('not_ready');
    expect(view?.gates.find((gate) => gate.id === 'agent_version')).toMatchObject({ status: 'fail' });
  });

  it('re-checks a ready node on every reconnect, so a reconnect alone never keeps it ready', async () => {
    const { nodeId, model, tunnels, service } = setup();
    announce(nodeId, (await buildReadinessReport('c'.repeat(32), agentProbes(model))).agent.version);
    service.start();
    tunnels.connect(nodeId);
    await settle(service);
    expect(service.get(nodeId)?.state).toBe('ready');
    // The host rebooted and Docker came back without the Compose directory mounted.
    model.env = { bindMounts: async () => [] };
    tunnels.connect(nodeId);
    await settle(service);
    expect(service.get(nodeId)?.state).toBe('not_ready');
    expect(db.getNodes().filter((node) => node.name === `readiness-${counter}`)).toHaveLength(1);
  });

  it('resets the verdict to provisional on a new enrollment for the same node', async () => {
    const { nodeId, operationId, model, tunnels, service } = setup();
    announce(nodeId, (await buildReadinessReport('c'.repeat(32), agentProbes(model))).agent.version);
    tunnels.up.add(nodeId);
    await service.verify(nodeId, AUDIT);
    expect(service.get(nodeId)?.state).toBe('ready');
    db.markNodeReadinessProvisional(nodeId, operationId, HUB_URL, Date.now());
    expect(service.get(nodeId)).toMatchObject({ state: 'provisional', checkedAt: null, gates: [] });
  });

  it('settles a check a hub restart cut short as not ready', () => {
    const { nodeId } = setup();
    const { operationId } = { operationId: db.getNodeReadiness(nodeId)?.operation_id ?? null };
    db.markNodeReadinessVerifying(nodeId, operationId, Date.now());
    const restarted = new NodeReadinessService({ db, tunnels: new FakeTunnels(), fetch: vi.fn(), changed: vi.fn() });
    services.push(restarted);
    restarted.start();
    expect(restarted.get(nodeId)).toMatchObject({ state: 'not_ready', gates: expect.arrayContaining([expect.objectContaining({ summary: expect.stringMatching(/hub restarted/) })]) });
  });

  it('records a changed verdict on the run, but not a reconnect that confirms it', async () => {
    const { nodeId, model, tunnels, service } = setup();
    announce(nodeId, (await buildReadinessReport('c'.repeat(32), agentProbes(model))).agent.version);
    const audits = () => db.getAuditLogs({ page: 1, limit: 500 }).entries.filter((row) => row.summary.includes(`node=${nodeId} `)).length;
    service.start();
    tunnels.connect(nodeId);
    await settle(service);
    expect(audits()).toBe(1);
    tunnels.connect(nodeId);
    await settle(service);
    expect(audits()).toBe(1);
    await service.verify(nodeId, AUDIT);
    expect(audits()).toBe(2);
  });

  it('drops a late answer when a retry re-enrolled the node while the Pilot answered', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const holder: { model?: AgentModel } = {};
    const { nodeId, model, tunnels, service, changed } = setup({
      fetch: async (url, signal) => { await gate; return agentFetch(holder.model as AgentModel)(url, signal); },
    });
    holder.model = model;
    announce(nodeId, (await buildReadinessReport('e'.repeat(32), agentProbes(model))).agent.version);
    tunnels.up.add(nodeId);
    const audits = () => db.getAuditLogs({ page: 1, limit: 500 }).entries.filter((row) => row.summary.includes(`node=${nodeId} `)).length;
    const check = service.verify(nodeId, AUDIT);
    await new Promise((resolve) => setImmediate(resolve));
    expect(service.get(nodeId)?.state).toBe('verifying');
    // The retry mints a new enrollment for the same node under a new run.
    db.markNodeReadinessProvisional(nodeId, 'retry-operation', HUB_URL, Date.now());
    release();
    await check;
    expect(service.get(nodeId)).toMatchObject({ state: 'provisional', operationId: 'retry-operation', gates: [] });
    expect(audits()).toBe(0);
    expect(changed).toHaveBeenCalledTimes(1); // only the verifying transition; the dropped answer announces nothing
  });

  it('writes nothing when the node is removed while its Pilot answers', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const holder: { model?: AgentModel } = {};
    const { nodeId, model, tunnels, service } = setup({
      fetch: async (url, signal) => { await gate; return agentFetch(holder.model as AgentModel)(url, signal); },
    });
    holder.model = model;
    tunnels.up.add(nodeId);
    const audits = () => db.getAuditLogs({ page: 1, limit: 500 }).entries.filter((row) => row.summary.includes(`node=${nodeId} `)).length;
    const check = service.verify(nodeId, AUDIT);
    await new Promise((resolve) => setImmediate(resolve));
    db.deleteNode(nodeId);
    release();
    await expect(check).resolves.toBeNull();
    expect(db.getNodeReadiness(nodeId)).toBeUndefined();
    expect(audits()).toBe(0);
  });

  it('records a check that broke on the hub as not ready instead of leaving it verifying', async () => {
    const { nodeId, model, tunnels, service } = setup();
    announce(nodeId, (await buildReadinessReport('f'.repeat(32), agentProbes(model))).agent.version);
    tunnels.up.add(nodeId);
    tunnels.isTunnelConfidential = () => { throw new Error('bridge state unavailable'); };
    const view = await service.verify(nodeId, AUDIT);
    expect(view?.state).toBe('not_ready');
    expect(view?.gates.find((gate) => gate.id === 'tunnel')).toMatchObject({ status: 'unknown', summary: expect.stringContaining('could not finish the check') });
  });

  it('stops calling a ready node ready once its tunnel drops, and checks it again on reconnect', async () => {
    const { nodeId, model, tunnels, service, fetch, changed } = setup();
    announce(nodeId, (await buildReadinessReport('a'.repeat(32), agentProbes(model))).agent.version);
    service.start();
    tunnels.connect(nodeId);
    await settle(service);
    expect(service.get(nodeId)?.state).toBe('ready');
    changed.mockClear();
    tunnels.disconnect(nodeId);
    expect(service.get(nodeId)?.state).toBe('provisional');
    expect(changed).toHaveBeenCalledWith(nodeId);
    tunnels.connect(nodeId);
    await settle(service);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(service.get(nodeId)?.state).toBe('ready');
  });

  it('keeps a not-ready verdict and its reasons when the tunnel drops', async () => {
    const { nodeId, model, tunnels, service } = setup();
    model.env = { composeVersion: async () => { throw new Error('compose missing'); } };
    service.start();
    tunnels.connect(nodeId);
    await settle(service);
    expect(service.get(nodeId)?.state).toBe('not_ready');
    tunnels.disconnect(nodeId);
    expect(service.get(nodeId)?.state).toBe('not_ready');
  });

  it('records an administrator who asks while a reconnect check runs as the one who asked', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const holder: { model?: AgentModel; first: boolean } = { first: true };
    const { nodeId, model, tunnels, service } = setup({
      fetch: async (url, signal) => {
        if (holder.first) { holder.first = false; await gate; }
        return agentFetch(holder.model as AgentModel)(url, signal);
      },
    });
    holder.model = model;
    announce(nodeId, (await buildReadinessReport('a'.repeat(32), agentProbes(model))).agent.version);
    service.start();
    tunnels.connect(nodeId);
    await new Promise((resolve) => setImmediate(resolve));
    const asked = service.verify(nodeId, AUDIT);
    release();
    await asked;
    const rows = db.getAuditLogs({ page: 1, limit: 500 }).entries.filter((row) => row.summary.includes(`node=${nodeId} `));
    expect(rows.some((row) => row.username === TEST_USERNAME)).toBe(true);
  });

  it('does not count a stopped leftover of the Pilot project as the answering agent', async () => {
    const { nodeId, model, tunnels, service } = setup();
    announce(nodeId, (await buildReadinessReport('a'.repeat(32), agentProbes(model))).agent.version);
    model.probes = {
      listContainers: async () => [
        { State: 'exited', Labels: { 'com.docker.compose.project': 'sencho-agent' }, Mounts: [{ Type: 'volume', Name: 'sencho-agent-data', Destination: '/app/data' }] },
      ],
    };
    tunnels.up.add(nodeId);
    const view = await service.verify(nodeId, AUDIT);
    expect(view?.state).toBe('not_ready');
    expect(view?.gates.find((gate) => gate.id === 'inventory')?.status).toBe('fail');
  });

  it('does not read a ready verdict whose stored evidence cannot be read back as ready', () => {
    const { nodeId, operationId, service } = setup();
    db.markNodeReadinessVerifying(nodeId, operationId, Date.now());
    db.recordNodeReadinessResult(nodeId, operationId, { state: 'ready', gatesJson: '{"not":"gates"}', agentVersion: '1.0.0', checkedAt: Date.now() });
    expect(service.get(nodeId)).toMatchObject({ state: 'not_ready', gates: [] });
    db.markNodeReadinessVerifying(nodeId, operationId, Date.now());
    db.recordNodeReadinessResult(nodeId, operationId, { state: 'ready', gatesJson: '[]', agentVersion: '1.0.0', checkedAt: Date.now() });
    expect(service.get(nodeId)?.state).toBe('not_ready');
    // A stored failure or unknown under a ready state does not read as ready either.
    for (const status of ['fail', 'unknown'] as const) {
      db.markNodeReadinessVerifying(nodeId, operationId, Date.now());
      db.recordNodeReadinessResult(nodeId, operationId, {
        state: 'ready',
        gatesJson: JSON.stringify([{ id: 'docker_compose', label: 'Docker Compose', status, summary: 'Missing.', remediation: 'Install it.' }]),
        agentVersion: '1.0.0',
        checkedAt: Date.now(),
      });
      expect(service.get(nodeId)?.state).toBe('not_ready');
    }
  });

  it('logs unreadable stored gates only when they back a ready verdict', () => {
    const { nodeId, operationId, service } = setup();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      db.markNodeReadinessVerifying(nodeId, operationId, Date.now());
      db.recordNodeReadinessResult(nodeId, operationId, { state: 'not_ready', gatesJson: 'not json', agentVersion: '1.0.0', checkedAt: Date.now() });
      service.get(nodeId);
      expect(warn).not.toHaveBeenCalled();
      db.markNodeReadinessVerifying(nodeId, operationId, Date.now());
      db.recordNodeReadinessResult(nodeId, operationId, { state: 'ready', gatesJson: 'not json', agentVersion: '1.0.0', checkedAt: Date.now() });
      expect(service.get(nodeId)?.state).toBe('not_ready');
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain(`Node ${nodeId}`);
    } finally {
      warn.mockRestore();
    }
  });

  it('audits the first verdict of a new enrollment even when it repeats the last one', async () => {
    const { nodeId, operationId, model, tunnels, service } = setup();
    announce(nodeId, (await buildReadinessReport('a'.repeat(32), agentProbes(model))).agent.version);
    const audits = () => db.getAuditLogs({ page: 1, limit: 500 }).entries.filter((row) => row.summary.includes(`node=${nodeId} `)).length;
    service.start();
    tunnels.connect(nodeId);
    await settle(service);
    expect(audits()).toBe(1);
    db.markNodeReadinessProvisional(nodeId, operationId, HUB_URL, Date.now());
    tunnels.disconnect(nodeId);
    tunnels.connect(nodeId);
    await settle(service);
    expect(service.get(nodeId)?.state).toBe('ready');
    expect(audits()).toBe(2);
  });

  it('does not audit every reconnect of a ready node after its tunnel drops', async () => {
    const { nodeId, model, tunnels, service } = setup();
    announce(nodeId, (await buildReadinessReport('a'.repeat(32), agentProbes(model))).agent.version);
    const audits = () => db.getAuditLogs({ page: 1, limit: 500 }).entries.filter((row) => row.summary.includes(`node=${nodeId} `)).length;
    service.start();
    tunnels.connect(nodeId);
    await settle(service);
    expect(audits()).toBe(1);
    for (let flap = 0; flap < 4; flap += 1) {
      tunnels.disconnect(nodeId);
      tunnels.connect(nodeId);
      await settle(service);
    }
    expect(service.get(nodeId)?.state).toBe('ready');
    expect(audits()).toBe(1);
  });

  it('does not keep a node ready across a hub start, before its Pilot reconnects', async () => {
    const { nodeId, model, tunnels, service } = setup();
    announce(nodeId, (await buildReadinessReport('a'.repeat(32), agentProbes(model))).agent.version);
    tunnels.up.add(nodeId);
    await service.verify(nodeId, AUDIT);
    expect(service.get(nodeId)?.state).toBe('ready');
    const restarted = new NodeReadinessService({ db, tunnels: new FakeTunnels(), fetch: vi.fn(), changed: vi.fn() });
    services.push(restarted);
    restarted.start();
    expect(restarted.get(nodeId)?.state).toBe('provisional');
  });

  it('drops an answer whose tunnel dropped while the Pilot answered', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const holder: { model?: AgentModel } = {};
    const { nodeId, model, tunnels, service } = setup({
      fetch: async (url, signal) => { await gate; return agentFetch(holder.model as AgentModel)(url, signal); },
    });
    holder.model = model;
    announce(nodeId, (await buildReadinessReport('a'.repeat(32), agentProbes(model))).agent.version);
    service.start();
    tunnels.up.add(nodeId);
    const check = service.verify(nodeId, AUDIT);
    await new Promise((resolve) => setImmediate(resolve));
    tunnels.disconnect(nodeId);
    release();
    await check;
    expect(service.get(nodeId)?.state).toBe('provisional');
  });

  it('finishes a check whose change announcement fails', async () => {
    const { nodeId, model, tunnels } = setup();
    announce(nodeId, (await buildReadinessReport('a'.repeat(32), agentProbes(model))).agent.version);
    tunnels.up.add(nodeId);
    const failing = new NodeReadinessService({
      db, tunnels, fetch: agentFetch(model), changed: () => { throw new Error('socket gone'); }, timeoutMs: 2_000,
    });
    services.push(failing);
    const view = await failing.verify(nodeId, AUDIT);
    expect(view?.state).toBe('ready');
  });

  it('stops rerunning a check after a bounded number of reruns', async () => {
    const holder: { service?: NodeReadinessService; model?: AgentModel; nodeId?: number } = {};
    const { nodeId, model, tunnels, service, fetch } = setup({
      fetch: async (url, signal) => {
        // Every answer arrives with another request already waiting, as under a flapping tunnel.
        void holder.service?.verify(holder.nodeId as number, AUDIT);
        return agentFetch(holder.model as AgentModel)(url, signal);
      },
    });
    Object.assign(holder, { service, model, nodeId });
    tunnels.up.add(nodeId);
    await service.verify(nodeId, AUDIT);
    await service.settled();
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it('keeps the agent credential out of the report', async () => {
    const model: AgentModel = { nodeId: 5, probes: {}, env: {} };
    const token = agentProbes(model).persistedToken() as string;
    const body = JSON.stringify(await buildReadinessReport('d'.repeat(32), { ...agentProbes(model), persistedToken: () => token }));
    expect(body).not.toContain(token);
    expect(body).not.toContain(token.split('.')[1]);
    expect(JSON.parse(body).agent.enrolledNodeId).toBe(5);
  });
});

describe('node readiness: evidence the agent could not measure', () => {
  /** Run a real check, from the agent's own report builder through the hub's gates, with one disk probe. */
  async function checkDisk(diskUsage: EnvironmentProbes['diskUsage'], trigger: 'tunnel-up' | 'admin') {
    const { nodeId, model, tunnels, service } = setup();
    model.env = { diskUsage };
    announce(nodeId, (await buildReadinessReport('c'.repeat(32), agentProbes(model))).agent.version);
    let view;
    if (trigger === 'admin') {
      tunnels.up.add(nodeId);
      view = await service.verify(nodeId, AUDIT);
    } else {
      service.start();
      tunnels.connect(nodeId);
      await settle(service);
      view = service.get(nodeId);
    }
    return { nodeId, view };
  }

  it.each(['tunnel-up', 'admin'] as const)('does not call a node ready when disk usage could not be determined (%s)', async (trigger) => {
    for (const diskUsage of [async () => null, async () => { throw new Error('fsSize blew up'); }] as Array<EnvironmentProbes['diskUsage']>) {
      const { nodeId, view } = await checkDisk(diskUsage, trigger);
      expect(view?.state).toBe('not_ready');
      expect(view?.gates.find((gate) => gate.id === 'disk_space')).toMatchObject({ status: 'unknown', summary: 'Disk usage could not be determined.' });
      expect(db.getNodeReadiness(nodeId)?.state).toBe('not_ready');
    }
  });

  it.each(['tunnel-up', 'admin'] as const)('still calls a node ready when the disk is measured, even low (%s)', async (trigger) => {
    const normal = await checkDisk(async () => ({ usePercent: 40, freeBytes: 50 * 1024 ** 3 }), trigger);
    expect(normal.view?.state).toBe('ready');
    expect(normal.view?.gates.find((gate) => gate.id === 'disk_space')?.status).toBe('pass');
    const low = await checkDisk(async () => ({ usePercent: 96, freeBytes: 1 * 1024 ** 3 }), trigger);
    expect(low.view?.state).toBe('ready');
    expect(low.view?.gates.find((gate) => gate.id === 'disk_space')).toMatchObject({ status: 'warn', summary: expect.stringMatching(/96% used/) });
  });

  it('reports a probe without a reading as unknown, and a measured warning as a warning', async () => {
    const unread = await buildReadinessReport('e'.repeat(32), agentProbes({ nodeId: 1, probes: {}, env: { diskUsage: async () => null } }));
    expect(unread.checks.find((check) => check.id === 'disk_space')).toMatchObject({ status: 'unknown' });
    const low = await buildReadinessReport('e'.repeat(32), agentProbes({ nodeId: 1, probes: {}, env: { diskUsage: async () => ({ usePercent: 99, freeBytes: 1024 }) } }));
    expect(low.checks.find((check) => check.id === 'disk_space')).toMatchObject({ status: 'warn' });
    const unreadMounts = await buildReadinessReport('e'.repeat(32), agentProbes({ nodeId: 1, probes: {}, env: { bindMounts: async () => { throw new Error('inspect failed'); } } }));
    expect(unreadMounts.checks.find((check) => check.id === 'path_mapping')).toMatchObject({ status: 'unknown' });
  });
});

describe('node readiness: capabilities', () => {
  it('calls a node ready only when the Pilot advertises the deployment baseline, taken in this report', async () => {
    const { nodeId, model, tunnels, service } = setup();
    const report = await buildReadinessReport('c'.repeat(32), agentProbes(model));
    expect(report.agent.capabilities).toEqual(expect.arrayContaining(['stacks', 'containers', 'cross-node-rbac']));
    announce(nodeId, report.agent.version);
    tunnels.up.add(nodeId);
    const view = await service.verify(nodeId, AUDIT);
    expect(view?.state).toBe('ready');
    expect(view?.gates.find((gate) => gate.id === 'capabilities')).toMatchObject({ status: 'pass' });
  });

  it.each([
    ['advertises none', () => []],
    ['lacks one the baseline needs', (all: string[]) => all.filter((capability) => capability !== 'containers')],
  ])('does not call a node ready when the Pilot %s', async (_label, narrow) => {
    const honest = await buildReadinessReport('c'.repeat(32), agentProbes({ nodeId: 1, probes: {}, env: {} }));
    let target = 0;
    const answer: ReadinessFetch = async (url) => ({
      status: 200,
      body: JSON.parse(JSON.stringify({
        ...honest,
        nonce: new URL(url).searchParams.get('nonce'),
        agent: { ...honest.agent, enrolledNodeId: target, capabilities: narrow(honest.agent.capabilities) },
      })),
    });
    const { nodeId, tunnels, service } = setup({ fetch: answer });
    target = nodeId;
    announce(nodeId, honest.agent.version);
    tunnels.up.add(nodeId);
    const view = await service.verify(nodeId, AUDIT);
    expect(view?.state).toBe('not_ready');
    expect(view?.gates.find((gate) => gate.id === 'identity')?.status).toBe('pass');
    expect(view?.gates.find((gate) => gate.id === 'capabilities')?.status).toBe('fail');
  });

  it('treats an answer with no capability list as an unreadable report', async () => {
    const honest = await buildReadinessReport('c'.repeat(32), agentProbes({ nodeId: 1, probes: {}, env: {} }));
    const answer: ReadinessFetch = async (url) => {
      const copy = JSON.parse(JSON.stringify({ ...honest, nonce: new URL(url).searchParams.get('nonce') }));
      delete copy.agent.capabilities;
      return { status: 200, body: copy };
    };
    const { nodeId, tunnels, service } = setup({ fetch: answer });
    announce(nodeId, honest.agent.version);
    tunnels.up.add(nodeId);
    const view = await service.verify(nodeId, AUDIT);
    expect(view?.state).toBe('not_ready');
    expect(view?.gates.at(-1)).toMatchObject({ id: 'contract', status: 'unknown' });
  });
});

describe('node readiness: why a tunnel is down', () => {
  it.each([
    ['enrollment_expired', /enrollment had expired/],
    ['enrollment_used', /already used or replaced/],
    ['credential_expired', /saved credential had expired/],
  ] as const)('names a refused Pilot (%s) instead of a generic disconnect, and says how to recover', async (reason, summary) => {
    const attempts = new PilotEnrollmentAttempts();
    const { nodeId, operationId } = setup();
    void operationId;
    const refused = new NodeReadinessService({ db, tunnels: new FakeTunnels(), fetch: vi.fn(), changed: vi.fn(), attempts });
    attempts.recordRefusal(nodeId, reason);
    const view = await refused.verify(nodeId, AUDIT);
    const gate = view?.gates.at(-1);
    expect(gate).toMatchObject({ id: 'tunnel', status: 'fail', summary: expect.stringMatching(summary) });
    expect(gate && gate.status !== 'pass' ? gate.remediation : '').toMatch(/Regenerate enrollment token/);
    expect(gate && gate.status !== 'pass' ? gate.remediation : '').not.toMatch(/Retry/);
  });

  it('reads the refusals the tunnel handler records, through the services\' default wiring', async () => {
    const { nodeId } = setup();
    // No `attempts` injected: the readiness service and the handler must share the hub's one record.
    const wired = new NodeReadinessService({ db, tunnels: new FakeTunnels(), fetch: vi.fn(), changed: vi.fn() });
    PilotEnrollmentAttempts.getInstance().recordRefusal(nodeId, 'enrollment_used');
    try {
      const view = await wired.verify(nodeId, AUDIT);
      expect(view?.gates.at(-1)).toMatchObject({ id: 'tunnel', summary: expect.stringMatching(/already used or replaced/) });
    } finally {
      PilotEnrollmentAttempts.getInstance().clear(nodeId);
    }
  });

  it('says it cannot tell why when nothing refused reached the hub, and where to look', async () => {
    const { nodeId, service } = setup();
    const view = await service.verify(nodeId, AUDIT);
    const gate = view?.gates.at(-1);
    expect(gate).toMatchObject({ id: 'tunnel', status: 'fail', summary: expect.stringMatching(/cannot tell why/) });
    expect(gate && gate.status !== 'pass' ? gate.remediation : '').toMatch(/docker logs sencho-agent/);
  });
});
