import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import { setupTestDb, cleanupTestDb, TEST_USERNAME } from './helpers/setupTestDb';
import { DatabaseService } from '../services/DatabaseService';
import {
  NodeBootstrapOperationService,
  stablePlanDigest,
  type ExecuteRequest,
} from '../services/nodeBootstrap/NodeBootstrapOperationService';
import { buildBootstrapPlan } from '../services/nodeBootstrap/planBuilder';
import type { BootstrapExecTransport, ExecOptions, ExecResult, ExecSession } from '../services/nodeBootstrap/sshExecClient';
import type { BootstrapFacts, BootstrapPlan, BootstrapPreflightResult } from '../services/nodeBootstrap/types';
import type { NodeBootstrapService } from '../services/nodeBootstrap/NodeBootstrapService';
import { makeFacts } from './__helpers__/bootstrapFacts';
import { DOCKER_KEY_ASC } from './__helpers__/dockerRepoFixtures';

/**
 * The operation lifecycle against a scripted host: approval, the recheck that
 * guards every mutation, ordered execution of the plan's own commands, the
 * just-in-time enrollment, and every way a run can stop. The host is a small
 * in-memory model of files and directories, so writes, read-backs and
 * no-clobber refusals behave as they would over SSH.
 */

const PRIVATE_KEY = '-----BEGIN OPENSSH PRIVATE KEY-----\nAAAAprivate-key-material-for-tests\n-----END OPENSSH PRIVATE KEY-----';
const HUB_URL = 'https://sencho.example.com';
const NOW = 1_762_300_000_000;
const AUDIT = { username: TEST_USERNAME, ip: '127.0.0.1', method: 'POST', path: '/api/nodes/bootstrap/operations' };

function freshFacts(overrides: Parameters<typeof makeFacts>[0] = {}): BootstrapFacts {
  return makeFacts({
    docker: { cliInstalled: false, serverVersion: null, composeVersion: null, serviceActive: false, serviceEnabled: false, socketAccess: 'none' },
    repo: { dockerSourceConfigured: false, keyringPresent: false, sourceVerified: false, keyringVerified: false, candidateSourceVerified: null },
    packages: [
      { name: 'docker-ce', installedVersion: null, candidateVersion: null },
      { name: 'docker-ce-cli', installedVersion: null, candidateVersion: null },
      { name: 'containerd.io', installedVersion: null, candidateVersion: null },
      { name: 'docker-buildx-plugin', installedVersion: null, candidateVersion: null },
      { name: 'docker-compose-plugin', installedVersion: null, candidateVersion: null },
    ],
    ...overrides,
  });
}

function planFrom(facts: BootstrapFacts, now = NOW, targetName = 'media-server'): BootstrapPlan {
  return buildBootstrapPlan({ facts, targetName, hubUrl: HUB_URL, caPem: null, now });
}

function resultFor(plan: BootstrapPlan | null, facts: BootstrapFacts, blocked = false): BootstrapPreflightResult {
  return {
    inspection: {
      observedAt: NOW,
      target: facts.target,
      hostKey: facts.hostKey,
      paths: facts.paths,
      agent: facts.agent,
      dockerRoot: facts.dockerRoot,
      checks: blocked
        ? [{ id: 'agent_conflict', category: 'conflicts', label: 'Existing Pilot agent', status: 'blocked', summary: 'A sencho-agent container already exists on this host.', remediation: 'Remove it.' }]
        : [],
      blockers: blocked ? 1 : 0,
      warnings: 0,
    },
    plan,
    blocked,
  };
}

interface HostFile { content: string; mode: string; owner: string; group: string }

/** A scripted host: a file and directory model plus fixed answers for the checks. */
class FakeHost {
  public readonly files = new Map<string, HostFile>();
  public readonly dirs = new Map<string, { mode: string; owner: string; group: string }>();
  public readonly commands: Array<{ command: string; stdin?: string }> = [];
  public override: ((command: string, options: ExecOptions) => ExecResult | Promise<ExecResult> | undefined) | null = null;
  public agentRunning = true;
  public opened = 0;

  public constructor() {
    // Directories every supported Ubuntu host already has, plus the existing stacks root the facts describe.
    this.dirs.set('/etc/apt/sources.list.d', { mode: '0755', owner: 'root', group: 'root' });
    this.dirs.set('/opt/docker/sencho', { mode: '0755', owner: 'ubuntu', group: 'ubuntu' });
  }

  public transport(): BootstrapExecTransport {
    return {
      open: async () => {
        this.opened += 1;
        const session: ExecSession = {
          closed: false,
          run: async (command, options) => {
            this.commands.push({ command, stdin: options.stdin });
            const custom = this.override?.(command, options);
            if (custom) return custom;
            return this.answer(command, options);
          },
          close: () => undefined,
        };
        return session;
      },
    };
  }

  private answer(command: string, options: ExecOptions): ExecResult {
    const ok = (stdout = ''): ExecResult => ({ exitCode: 0, stdout, stderr: '', truncated: false, timedOut: false, error: null });
    const exit = (code: number, stderr = ''): ExecResult => ({ exitCode: code, stdout: '', stderr, truncated: false, timedOut: false, error: null });
    const write = /sencho-write '([^']*)' '([^']*)' '([^']*)' '([^']*)' '([^']*)' '([01])'$/.exec(command);
    if (write) {
      const [, dir, name, mode, owner, group, noClobber] = write;
      const target = `${dir}/${name}`;
      if (!this.dirs.has(dir)) return exit(20, `not a directory: ${dir}`);
      if (noClobber === '1' && this.files.has(target)) return exit(17, `already exists: ${target}`);
      this.files.set(target, { content: options.stdin ?? '', mode, owner, group });
      return ok();
    }
    const read = /sencho-read '([^']*)'$/.exec(command);
    if (read) {
      const file = this.files.get(read[1]);
      return file ? ok(Buffer.from(file.content).toString('base64')) : exit(3);
    }
    const stat = /stat -c '%a %U %G %F' -- '([^']*)'$/.exec(command);
    if (stat) {
      const file = this.files.get(stat[1]);
      if (file) return ok(`${Number.parseInt(file.mode, 8).toString(8)} ${file.owner} ${file.group} regular file`);
      const dir = this.dirs.get(stat[1]);
      if (dir) return ok(`${Number.parseInt(dir.mode, 8).toString(8)} ${dir.owner} ${dir.group} directory`);
      return exit(1, 'No such file or directory');
    }
    const installDir = /install -d -m (\d+) -o '([^']*)' -g '([^']*)' -- '([^']*)'$/.exec(command);
    if (installDir) {
      this.dirs.set(installDir[4], { mode: installDir[1], owner: installDir[2], group: installDir[3] });
      return ok();
    }
    if (command.includes('curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc')) {
      this.files.set('/etc/apt/keyrings/docker.asc', { content: DOCKER_KEY_ASC, mode: '0644', owner: 'root', group: 'root' });
      return ok();
    }
    if (command.includes("docker version --format '{{.Server.Version}}'")) return ok('27.3.1\n');
    if (command.includes('docker compose version --short')) return ok('2.29.7\n');
    if (command.includes('systemctl is-active docker; systemctl is-enabled docker')) return ok('active\nenabled\n');
    if (command.includes('docker inspect --type container')) {
      return this.agentRunning ? ok('running|sencho-agent|/opt/sencho-agent\n') : exit(1, 'No such container');
    }
    return ok();
  }

  /** Commands that came from the plan, in order, without the checks around them. */
  public planCommands(plan: BootstrapPlan): string[] {
    const planned = new Set(plan.stages.flatMap((stage) => stage.steps).map((step) => step.command).filter(Boolean));
    return this.commands.map((entry) => entry.command).filter((command) => planned.has(command));
  }
}

class FakeTunnels extends EventEmitter {
  public readonly active = new Set<number>();
  public readonly closed: number[] = [];
  public hasActiveTunnel(nodeId: number): boolean {
    return this.active.has(nodeId);
  }
  public closeTunnel(nodeId: number): void {
    this.closed.push(nodeId);
    this.active.delete(nodeId);
  }
  public connect(nodeId: number): void {
    this.active.add(nodeId);
    this.emit('tunnel-up', nodeId);
  }
}

let tmpDir: string;
let db: DatabaseService;

beforeAll(async () => {
  tmpDir = await setupTestDb();
  db = DatabaseService.getInstance();
});

afterAll(() => cleanupTestDb(tmpDir));

interface Harness {
  service: NodeBootstrapOperationService;
  host: FakeHost;
  tunnels: FakeTunnels;
  preflight: ReturnType<typeof vi.fn>;
  facts: { current: BootstrapFacts };
  minted: number[];
  name: string;
}

let hostCounter = 0;

function harness(options: { facts?: BootstrapFacts; enrollWaitMs?: number; connectOnStart?: boolean } = {}): Harness {
  hostCounter += 1;
  const hostname = `server-${hostCounter}.example.com`;
  const base = options.facts ?? freshFacts();
  const facts = {
    current: {
      ...base,
      target: { ...base.target, host: hostname },
      hostKey: { ...base.hostKey, fingerprint: `SHA256:host-key-${hostCounter}` },
    },
  };
  const host = new FakeHost();
  const tunnels = new FakeTunnels();
  const minted: number[] = [];
  const name = `node-${hostCounter}`;
  const preflight = vi.fn(async (_input: unknown, ctx: { planNow?: number; ownership?: unknown }) => {
    const plan = planFrom(facts.current, ctx.planNow ?? NOW, name);
    return resultFor(plan, facts.current);
  });
  const service = new NodeBootstrapOperationService({
    db,
    preflight: { preflight } as unknown as Pick<NodeBootstrapService, 'preflight'>,
    exec: host.transport(),
    tunnels,
    now: () => Date.now(),
    mintToken: (nodeId) => {
      minted.push(nodeId);
      return { token: `eyJhbGciOiJIUzI1NiJ9.enroll-${nodeId}-${minted.length}.signature-material`, expiresAt: Date.now() + 15 * 60_000 };
    },
    enrollWaitMs: options.enrollWaitMs ?? 2_000,
  });
  if (options.connectOnStart !== false) {
    host.override = (command) => {
      if (command.includes('up -d')) {
        const op = db.listNodeBootstrapOperations(50).find((row) => row.host === hostname);
        if (op?.node_id) setTimeout(() => tunnels.connect(op.node_id as number), 5);
      }
      return undefined;
    };
  }
  return { service, host, tunnels, preflight, facts, minted, name };
}

function approve(h: Harness, operationId: string | null = null, actor = TEST_USERNAME): { request: ExecuteRequest; plan: BootstrapPlan } {
  const plan = planFrom(h.facts.current, Date.now(), h.name);
  h.service.rememberPlan(resultFor(plan, h.facts.current), actor, operationId);
  const request: ExecuteRequest = {
    host: plan.target.host,
    port: plan.target.port,
    username: plan.target.username,
    privateKey: PRIVATE_KEY,
    passphrase: null,
    expectedFingerprint: plan.hostKeyFingerprint,
    targetName: plan.targetName,
    composeDir: plan.paths.composeDir.input,
    agentDir: plan.paths.agentDir.input,
    planDigest: plan.digest,
  };
  return { request, plan };
}

function context() {
  return { hubUrl: HUB_URL, audit: AUDIT };
}

function auditText(): string {
  return db.getAuditLogs({ limit: 500 }).entries.map((row) => row.summary).join('\n');
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('bootstrap operations: approval', () => {
  it('refuses a digest that was never shown, and a replayed approval', async () => {
    const h = harness();
    const { request } = approve(h);
    expect(() => h.service.start({ ...request, planDigest: 'f'.repeat(64) }, context())).toThrow(/no longer current/);
    const op = h.service.start(request, context());
    await h.service.settled();
    expect(() => h.service.start(request, context())).toThrow(/no longer current/);
    expect(db.listNodeBootstrapOperations(50).filter((row) => row.id === op.id)).toHaveLength(1);
  });

  it('binds the approval to the operator, the target, the directories and the host key', () => {
    const h = harness();
    const other = approve(h, null, 'someone-else');
    expect(() => h.service.start(other.request, context())).toThrow(/another administrator/);
    const mine = approve(h);
    expect(() => h.service.start({ ...mine.request, agentDir: '/srv/other-agent' }, context())).toThrow(/does not match the reviewed plan/);
    expect(() => h.service.start({ ...mine.request, expectedFingerprint: 'SHA256:other' }, context())).toThrow(/does not match the reviewed plan/);
    expect(() => h.service.start({ ...mine.request, username: 'root' }, context())).toThrow(/does not match the reviewed plan/);
    expect(h.host.opened).toBe(0);
  });

  it('refuses an approval older than ten minutes', () => {
    const h = harness();
    const realNow = Date.now;
    const { request } = approve(h);
    const later = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + 11 * 60_000);
    expect(() => h.service.start(request, context())).toThrow(/no longer current/);
    later.mockRestore();
  });
});

describe('bootstrap operations: a clean run', () => {
  it('runs the plan commands in order, writes the files, enrolls the node and releases the target', async () => {
    const h = harness();
    const { request, plan } = approve(h);
    const started = h.service.start(request, context());
    expect(started.state).toBe('rechecking');
    await h.service.settled();

    const op = h.service.get(started.id);
    expect(op.state).toBe('enrolled');
    expect(op.active).toBe(false);
    expect(op.nodeId).not.toBeNull();

    // Exactly the plan's commands, in the plan's order.
    const expected = plan.stages.flatMap((stage) => stage.steps).map((step) => step.command).filter(Boolean);
    expect(h.host.planCommands(plan)).toEqual(expected);

    // The recheck rebuilt the plan as of the approved generation time, pinned to the approved address.
    expect(h.preflight).toHaveBeenCalledWith(
      expect.objectContaining({ expectedFingerprint: plan.hostKeyFingerprint, replacePinnedFingerprint: null }),
      expect.objectContaining({ planNow: plan.generatedAt, pinnedAddress: plan.target.address }),
    );

    // Files land with the planned mode and owner; the compose file carries the real token.
    const compose = h.host.files.get('/opt/sencho-agent/compose.yaml');
    expect(compose).toMatchObject({ mode: '0600', owner: 'ubuntu', group: 'ubuntu' });
    expect(compose?.content).toContain(`SENCHO_ENROLL_TOKEN: "eyJhbGciOiJIUzI1NiJ9.enroll-${op.nodeId}-1.signature-material"`);
    expect(compose?.content).toContain('name: sencho-agent');
    expect(h.host.files.get('/etc/apt/sources.list.d/docker.list')?.content).toContain('https://download.docker.com/linux/ubuntu noble stable');

    const node = db.getNode(op.nodeId as number);
    expect(node).toMatchObject({ name: h.name, type: 'remote', mode: 'pilot_agent', compose_dir: '/opt/docker/sencho' });
    expect(h.minted).toEqual([op.nodeId]);
    expect(op.events.at(-1)?.message).toMatch(/readiness has not been verified/);
    db.deleteNode(op.nodeId as number);
  });

  it('mints the enrollment only after every Docker step has run', async () => {
    const h = harness();
    const { request } = approve(h);
    let mintedAtCommand = -1;
    const original = h.host.override;
    h.host.override = (command, options) => {
      if (mintedAtCommand === -1 && h.minted.length > 0) mintedAtCommand = h.host.commands.length - 1;
      return original?.(command, options);
    };
    const op = h.service.start(request, context());
    await h.service.settled();
    const commands = h.host.commands.map((entry) => entry.command);
    const lastDocker = commands.reduce((last, command, index) => (/apt-get|systemctl enable/.test(command) ? index : last), -1);
    expect(lastDocker).toBeGreaterThan(-1);
    expect(mintedAtCommand).toBeGreaterThan(lastDocker);
    db.deleteNode(h.service.get(op.id).nodeId as number);
  });

  it('keeps the key and token out of every command, event and audit row', async () => {
    const h = harness();
    const { request } = approve(h);
    const op = h.service.start(request, context());
    await h.service.settled();
    const detail = h.service.get(op.id);
    const token = `enroll-${detail.nodeId}-1`;
    for (const entry of h.host.commands) {
      expect(entry.command).not.toContain(token);
      expect(entry.command).not.toContain('private-key-material');
    }
    // The token travels only on standard input, to the compose file write.
    const carriers = h.host.commands.filter((entry) => entry.stdin?.includes(token));
    expect(carriers).toHaveLength(1);
    expect(carriers[0].command).toContain("'/opt/sencho-agent' 'compose.yaml'");
    const recorded = JSON.stringify(detail) + auditText();
    expect(recorded).not.toContain(token);
    expect(recorded).not.toContain('private-key-material');
    db.deleteNode(detail.nodeId as number);
  });

  it('skips the Docker stages on a host where Docker already works', async () => {
    const h = harness({ facts: makeFacts() });
    const { request, plan } = approve(h);
    const op = h.service.start(request, context());
    await h.service.settled();
    expect(plan.stages.map((stage) => stage.id)).not.toContain('docker_packages');
    expect(h.host.commands.some((entry) => entry.command.includes('apt-get'))).toBe(false);
    expect(h.service.get(op.id).state).toBe('enrolled');
    db.deleteNode(h.service.get(op.id).nodeId as number);
  });
});

describe('bootstrap operations: nothing changes unless the host still matches', () => {
  it('blocks a stale plan before opening an execution session', async () => {
    const h = harness();
    const { request } = approve(h);
    h.facts.current = { ...h.facts.current, paths: { ...h.facts.current.paths, composeDir: { ...h.facts.current.paths.composeDir, stackCount: 4 } } };
    const op = h.service.start(request, context());
    await h.service.settled();
    const detail = h.service.get(op.id);
    expect(detail.state).toBe('blocked');
    expect(detail.error?.code).toBe('PLAN_STALE');
    expect(detail.active).toBe(false);
    expect(detail.changesMade).toBe(false);
    expect(h.host.opened).toBe(0);
  });

  it('blocks when the fresh preflight is blocked', async () => {
    const h = harness();
    const { request } = approve(h);
    h.preflight.mockImplementationOnce(async () => resultFor(null, h.facts.current, true));
    const op = h.service.start(request, context());
    await h.service.settled();
    const detail = h.service.get(op.id);
    expect(detail.state).toBe('blocked');
    expect(detail.error?.code).toBe('PRECONDITION_CHANGED');
    expect(detail.error?.message).toContain('sencho-agent container already exists');
    expect(h.host.opened).toBe(0);
  });

  it('blocks when the recheck cannot reach the host', async () => {
    const h = harness();
    const { request } = approve(h);
    h.preflight.mockImplementationOnce(async () => { throw new Error('connect ECONNREFUSED'); });
    const op = h.service.start(request, context());
    await h.service.settled();
    expect(h.service.get(op.id)).toMatchObject({ state: 'blocked', error: { code: 'RECHECK_FAILED' }, active: false });
  });

  it('holds one active operation per target and per host key', async () => {
    const h = harness({ connectOnStart: false, enrollWaitMs: 60_000 });
    const first = approve(h);
    const op = h.service.start(first.request, context());
    const second = approve(h);
    expect(() => h.service.start(second.request, context())).toThrow(/Another bootstrap holds this server/);
    // The same server reached under another name is the same host key.
    const alias = { ...second.plan, target: { ...second.plan.target, host: 'alias.example.com' }, digest: 'a'.repeat(64) };
    h.service.rememberPlan(resultFor(alias, h.facts.current), TEST_USERNAME, null);
    expect(() => h.service.start({ ...second.request, host: 'alias.example.com', planDigest: alias.digest }, context())).toThrow(/Another bootstrap holds this server/);
    h.service.cancel(op.id, AUDIT);
    await h.service.settled();
  });
});

describe('bootstrap operations: stopping honestly', () => {
  it('records a failed package step as partial, keeps the target and mints nothing', async () => {
    const h = harness();
    const { request } = approve(h);
    h.host.override = (command) => (command.includes('apt-get install')
      ? { exitCode: 100, stdout: 'Reading package lists...', stderr: 'E: Could not get lock /var/lib/dpkg/lock-frontend', truncated: false, timedOut: false, error: null }
      : undefined);
    const op = h.service.start(request, context());
    await h.service.settled();
    const detail = h.service.get(op.id);
    expect(detail.state).toBe('partial');
    expect(detail.active).toBe(true);
    expect(detail.step).toBe('install-docker-packages');
    expect(detail.actions).toEqual({ cancel: false, retry: true, release: true });
    expect(detail.events.at(-1)?.detail).toContain('Could not get lock');
    expect(h.minted).toEqual([]);
    expect(detail.nodeId).toBeNull();
    expect(h.host.commands.some((entry) => entry.command.includes('up -d'))).toBe(false);
    h.service.release(op.id, AUDIT);
  });

  it('reports a dropped connection as an unknown outcome', async () => {
    const h = harness();
    const { request } = approve(h);
    h.host.override = (command) => (command.includes('apt-get install')
      ? { exitCode: null, stdout: '', stderr: '', truncated: false, timedOut: false, error: 'CONNECTION_LOST' }
      : undefined);
    const op = h.service.start(request, context());
    await h.service.settled();
    expect(h.service.get(op.id)).toMatchObject({ state: 'outcome_unknown', active: true, error: { code: 'SSH_CONNECTION_LOST' } });
    h.service.release(op.id, AUDIT);
  });

  it('reports a step that outlived its deadline as an unknown outcome', async () => {
    const h = harness();
    const { request } = approve(h);
    h.host.override = (command) => (command.includes('systemctl enable --now docker')
      ? { exitCode: null, stdout: '', stderr: '', truncated: false, timedOut: true, error: null }
      : undefined);
    const op = h.service.start(request, context());
    await h.service.settled();
    expect(h.service.get(op.id)).toMatchObject({ state: 'outcome_unknown', error: { code: 'STEP_TIMEOUT' } });
    h.service.release(op.id, AUDIT);
  });

  it('stops before the repository is written when the downloaded key is not Docker\'s', async () => {
    const h = harness();
    const { request } = approve(h);
    h.host.override = (command) => {
      if (command.includes('curl -fsSL')) {
        h.host.files.set('/etc/apt/keyrings/docker.asc', { content: '-----BEGIN PGP PUBLIC KEY BLOCK-----\n\nnot-docker\n-----END PGP PUBLIC KEY BLOCK-----\n', mode: '0644', owner: 'root', group: 'root' });
        return { exitCode: 0, stdout: '', stderr: '', truncated: false, timedOut: false, error: null };
      }
      return undefined;
    };
    const op = h.service.start(request, context());
    await h.service.settled();
    expect(h.service.get(op.id)).toMatchObject({ state: 'partial', error: { code: 'KEY_NOT_VERIFIED' } });
    expect(h.host.files.has('/etc/apt/sources.list.d/docker.list')).toBe(false);
    h.service.release(op.id, AUDIT);
  });

  it('requires recovery when Docker does not answer after it was prepared', async () => {
    const h = harness();
    const { request } = approve(h);
    h.host.override = (command) => (command.includes("docker version --format")
      ? { exitCode: 1, stdout: '', stderr: 'Cannot connect to the Docker daemon', truncated: false, timedOut: false, error: null }
      : undefined);
    const op = h.service.start(request, context());
    await h.service.settled();
    expect(h.service.get(op.id)).toMatchObject({ state: 'recovery_required', error: { code: 'DOCKER_NOT_READY' } });
    expect(h.minted).toEqual([]);
    h.service.release(op.id, AUDIT);
  });

  it('never overwrites a compose file it did not write', async () => {
    const h = harness({
      facts: makeFacts({
        agentDir: {
          exists: true, isDirectory: true, realPath: '/opt/sencho-agent', writableByUser: true, readableByUser: true,
          entries: ['compose.yaml', 'sencho-bootstrap.json'], hasMarker: true, hasComposeFile: true,
          markerProject: 'sencho-agent', markerComposeDir: '/opt/docker/sencho', markerAgentDir: '/opt/sencho-agent',
        },
      }),
    });
    h.host.dirs.set('/opt/sencho-agent', { mode: '0700', owner: 'ubuntu', group: 'ubuntu' });
    h.host.files.set('/opt/sencho-agent/sencho-bootstrap.json', {
      content: JSON.stringify({ schemaVersion: 1, project: 'sencho-agent', composeDir: '/opt/docker/sencho', agentDir: '/opt/sencho-agent', createdAt: 1 }),
      mode: '0600', owner: 'ubuntu', group: 'ubuntu',
    });
    h.host.files.set('/opt/sencho-agent/compose.yaml', { content: 'services:\n  something-else:\n    image: nginx\n', mode: '0600', owner: 'ubuntu', group: 'ubuntu' });
    const { request } = approve(h);
    const op = h.service.start(request, context());
    await h.service.settled();
    expect(h.service.get(op.id)).toMatchObject({ state: 'recovery_required', error: { code: 'FILE_CONFLICT' } });
    expect(h.host.files.get('/opt/sencho-agent/compose.yaml')?.content).toContain('something-else');
    h.service.release(op.id, AUDIT);
    const nodeId = h.service.get(op.id).nodeId;
    if (nodeId) db.deleteNode(nodeId);
  });

  it('cancels at the next step boundary and undoes nothing', async () => {
    const h = harness();
    const { request } = approve(h);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    h.host.override = (command) => (command.includes('apt-get update')
      ? gate.then(() => ({ exitCode: 0, stdout: '', stderr: '', truncated: false, timedOut: false, error: null }))
      : undefined);
    const op = h.service.start(request, context());
    await vi.waitFor(() => expect(h.host.commands.some((entry) => entry.command.includes('apt-get update'))).toBe(true));
    const cancelling = h.service.cancel(op.id, AUDIT);
    expect(cancelling.cancelRequested).toBe(true);
    release();
    await h.service.settled();
    const detail = h.service.get(op.id);
    expect(detail.state).toBe('cancelled');
    expect(detail.error?.message).toMatch(/nothing was undone/);
    expect(detail.active).toBe(true);
    expect(h.host.commands.some((entry) => entry.command.includes('apt-get install'))).toBe(false);
    h.service.release(op.id, AUDIT);
  });

  it('records a run that ended in a hub restart as interrupted', () => {
    const h = harness();
    const now = Date.now();
    const base = {
      target_key: 'restart.example.com:22', host: 'restart.example.com', port: 22, username: 'ubuntu', address: '192.168.1.60',
      target_name: 'restart', compose_dir: '/opt/docker/sencho', agent_dir: '/opt/sencho-agent', plan_json: '{}', plan_digest: 'd',
      approved_by: TEST_USERNAME, approved_at: now, attempt: 1, stage: null, step: null, node_id: null, agent_started: 0, active: 1,
      cancel_requested: 0, error_code: null, error_message: null, enrollment_expires_at: null, created_at: now, updated_at: now, finished_at: null,
    };
    db.insertNodeBootstrapOperation({ ...base, id: '00000000-0000-4000-8000-000000000001', state: 'running', changes_made: 1, host_key_fingerprint: 'SHA256:restart-a' });
    db.insertNodeBootstrapOperation({ ...base, id: '00000000-0000-4000-8000-000000000002', state: 'rechecking', changes_made: 0, target_key: 'restart-b.example.com:22', host: 'restart-b.example.com', host_key_fingerprint: 'SHA256:restart-b' });
    h.service.recoverOnStartup();
    expect(db.getNodeBootstrapOperation('00000000-0000-4000-8000-000000000001')).toMatchObject({ state: 'outcome_unknown', active: 1, error_code: 'HUB_RESTARTED' });
    expect(db.getNodeBootstrapOperation('00000000-0000-4000-8000-000000000002')).toMatchObject({ state: 'blocked', active: 0, error_code: 'HUB_RESTARTED' });
    h.service.release('00000000-0000-4000-8000-000000000001', AUDIT);
  });
});

describe('bootstrap operations: enrollment and retry', () => {
  it('records a Pilot that never connects as partial, then reconciles once it does', async () => {
    const h = harness({ connectOnStart: false, enrollWaitMs: 20 });
    const { request } = approve(h);
    const op = h.service.start(request, context());
    await h.service.settled();
    const stopped = h.service.get(op.id);
    expect(stopped).toMatchObject({ state: 'partial', active: true, error: { code: 'ENROLLMENT_NOT_CONNECTED' } });
    h.tunnels.connect(stopped.nodeId as number);
    const reconciled = h.service.get(op.id);
    expect(reconciled).toMatchObject({ state: 'enrolled', active: false });
    db.deleteNode(stopped.nodeId as number);
  });

  it('retries on the same node with a new enrollment and replaces only its own compose file', async () => {
    const h = harness({ connectOnStart: false, enrollWaitMs: 20 });
    const first = approve(h);
    const op = h.service.start(first.request, context());
    await h.service.settled();
    const stopped = h.service.get(op.id);
    expect(stopped.state).toBe('partial');
    const nodeId = stopped.nodeId as number;

    // The retry preflight sees this operation's own agent directory and container.
    h.facts.current = makeFacts({
      target: h.facts.current.target,
      hostKey: h.facts.current.hostKey,
      agentDir: {
        exists: true, isDirectory: true, realPath: '/opt/sencho-agent', writableByUser: true, readableByUser: true,
        entries: ['compose.yaml', 'sencho-bootstrap.json'], hasMarker: true, hasComposeFile: true,
        markerProject: 'sencho-agent', markerComposeDir: '/opt/docker/sencho', markerAgentDir: '/opt/sencho-agent',
      },
    });
    expect(h.service.retryOwnership(op.id)).toEqual({ nodeId, agentStarted: true });
    const second = approve(h, op.id);
    expect(() => h.service.start(second.request, context())).toThrow(/different bootstrap/);
    const nodesBefore = db.getNodes().length;
    const retried = h.service.retry(op.id, second.request, context());
    expect(retried).toMatchObject({ state: 'rechecking', attempt: 2 });
    await vi.waitFor(() => expect(h.service.get(op.id).state).toBe('enrolling'));
    h.tunnels.connect(nodeId);
    await h.service.settled();

    const done = h.service.get(op.id);
    expect(done).toMatchObject({ state: 'enrolled', nodeId, attempt: 2, active: false });
    expect(db.getNodes()).toHaveLength(nodesBefore);
    expect(h.minted).toEqual([nodeId, nodeId]);
    expect(h.tunnels.closed).toContain(nodeId);
    expect(h.host.files.get('/opt/sencho-agent/compose.yaml')?.content).toContain(`enroll-${nodeId}-2`);
    db.deleteNode(nodeId);
  });

  it('refuses a retry while running, after enrolling, or for another operation\'s plan', async () => {
    const h = harness();
    const { request } = approve(h);
    const op = h.service.start(request, context());
    expect(() => h.service.retryOwnership(op.id)).toThrow(/cannot be retried/);
    await h.service.settled();
    expect(h.service.get(op.id).state).toBe('enrolled');
    const again = approve(h, op.id);
    expect(() => h.service.retry(op.id, again.request, context())).toThrow(/cannot be retried|nothing to retry/);
    db.deleteNode(h.service.get(op.id).nodeId as number);
  });

  it('releases the target without touching the host or the node record', async () => {
    const h = harness({ connectOnStart: false, enrollWaitMs: 20 });
    const { request } = approve(h);
    const op = h.service.start(request, context());
    await h.service.settled();
    const before = h.host.commands.length;
    const released = h.service.release(op.id, AUDIT);
    expect(released.active).toBe(false);
    expect(h.host.commands.length).toBe(before);
    expect(db.getNode(released.nodeId as number)).toBeDefined();
    expect(released.events.at(-1)?.message).toMatch(/node record stays/);
    // The target is free again.
    const next = approve(h);
    expect(() => h.service.start(next.request, context())).not.toThrow();
    await h.service.settled();
    db.deleteNode(released.nodeId as number);
  });
});

describe('stablePlanDigest', () => {
  it('ignores the generation time and evidence digest, and nothing else', () => {
    const facts = freshFacts();
    const a = planFrom(facts, NOW);
    const b = { ...planFrom({ ...facts, clockSkewMs: 1234 }, NOW), generatedAt: NOW + 5 };
    expect(b.evidenceDigest).not.toBe(a.evidenceDigest);
    expect(stablePlanDigest(b)).toBe(stablePlanDigest(a));
    expect(stablePlanDigest(planFrom(facts, NOW + 1))).not.toBe(stablePlanDigest(a));
  });
});
