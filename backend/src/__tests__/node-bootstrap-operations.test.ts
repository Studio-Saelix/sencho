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
import { SshTransportError } from '../services/nodeBootstrap/sshProbeClient';
import { NodeBootstrapService as RealPreflightService } from '../services/nodeBootstrap/NodeBootstrapService';
import { EXEC_OUTPUT_TAIL_BYTES } from '../services/nodeBootstrap/sshExecClient';
import type { BootstrapExecTransport, ExecOptions, ExecResult, ExecSession } from '../services/nodeBootstrap/sshExecClient';
import type { BootstrapFacts, BootstrapPlan, BootstrapPreflightResult } from '../services/nodeBootstrap/types';
import type { NodeBootstrapService } from '../services/nodeBootstrap/NodeBootstrapService';
import { makeFacts } from './__helpers__/bootstrapFacts';
import crypto from 'crypto';
import { DOCKER_KEY_ASC } from './__helpers__/dockerRepoFixtures';
import { APT_POLICY_COMMAND } from '../services/nodeBootstrap/probes';
import { runPlanStep, type StepContext } from '../services/nodeBootstrap/stepRunner';

/** apt-cache policy output naming the official repository as each package's source. */
function officialPolicy(codename = 'noble', origin = 'https://download.docker.com/linux/ubuntu'): string {
  return ['docker-ce', 'docker-ce-cli', 'containerd.io', 'docker-buildx-plugin', 'docker-compose-plugin'].map((name) => [
    `${name}:`,
    '  Installed: (none)',
    '  Candidate: 1.0.0-1',
    '  Version table:',
    '     1.0.0-1 500',
    `        500 ${origin} ${codename}/stable amd64 Packages`,
  ].join('\n')).join('\n');
}

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

function planFrom(facts: BootstrapFacts, now = NOW, targetName = 'media-server', caPem: string | null = null): BootstrapPlan {
  return buildBootstrapPlan({ facts, targetName, hubUrl: HUB_URL, caPem, now });
}

const HUB_CA = '-----BEGIN CERTIFICATE-----\nMIIBhub-ca-for-tests\n-----END CERTIFICATE-----\n';

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

/** The output limits the real session applies: the tail by default, the head when asked. */
function capOutput(result: ExecResult, options: ExecOptions): ExecResult {
  const keep = options.keep ?? { mode: 'tail' as const, maxBytes: EXEC_OUTPUT_TAIL_BYTES };
  const cap = (text: string) => {
    const bytes = Buffer.from(text);
    if (bytes.length <= keep.maxBytes) return { text, cut: false };
    const kept = keep.mode === 'head' ? bytes.subarray(0, keep.maxBytes) : bytes.subarray(bytes.length - keep.maxBytes);
    return { text: kept.toString('utf8'), cut: true };
  };
  const stdout = cap(result.stdout);
  const stderr = cap(result.stderr);
  return { ...result, stdout: stdout.text, stderr: stderr.text, truncated: result.truncated || stdout.cut || stderr.cut };
}

/** A scripted host: a file and directory model plus fixed answers for the checks. */
class FakeHost {
  public readonly files = new Map<string, HostFile>();
  public readonly dirs = new Map<string, { mode: string; owner: string; group: string }>();
  public readonly commands: Array<{ command: string; stdin?: string }> = [];
  public override: ((command: string, options: ExecOptions) => ExecResult | Promise<ExecResult> | undefined) | null = null;
  public agentRunning = true;
  public opened = 0;
  public openedWith: Array<{ session: { host: string; address: string; port: number; username: string }; expectedFingerprint: string }> = [];
  public policy = officialPolicy();
  public codename = 'noble';
  /** When set, opening the session waits on this (a slow connect), honouring the abort signal. */
  public openGate: Promise<void> | null = null;

  public constructor() {
    // Directories every supported Ubuntu host already has, plus the existing stacks root the facts describe.
    this.dirs.set('/etc/apt', { mode: '0755', owner: 'root', group: 'root' });
    this.dirs.set('/opt', { mode: '0755', owner: 'root', group: 'root' });
    this.dirs.set('/etc/apt/sources.list.d', { mode: '0755', owner: 'root', group: 'root' });
    this.dirs.set('/opt/docker/sencho', { mode: '0755', owner: 'ubuntu', group: 'ubuntu' });
  }

  public transport(): BootstrapExecTransport {
    return {
      open: async (session, options) => {
        this.opened += 1;
        this.openedWith.push({
          session: { host: session.host, address: session.address, port: session.port, username: session.username },
          expectedFingerprint: options.expectedFingerprint,
        });
        if (this.openGate) {
          const gate = this.openGate;
          await new Promise<void>((resolve, reject) => {
            options.signal?.addEventListener('abort', () => reject(new SshTransportError('SSH_UNREACHABLE', 'The request was cancelled.')), { once: true });
            void gate.then(resolve);
          });
        }
        const exec: ExecSession = {
          closed: false,
          run: async (command, options) => {
            this.commands.push({ command, stdin: options.stdin });
            const custom = await this.override?.(command, options);
            return capOutput(custom ?? this.answer(command, options), options);
          },
          close: () => undefined,
        };
        return exec;
      },
    };
  }

  private answer(command: string, options: ExecOptions): ExecResult {
    const ok = (stdout = ''): ExecResult => ({ exitCode: 0, stdout, stderr: '', truncated: false, timedOut: false, error: null });
    const exit = (code: number, stderr = ''): ExecResult => ({ exitCode: code, stdout: '', stderr, truncated: false, timedOut: false, error: null });
    const write = /sencho-write '([^']*)' '([^']*)' '([^']*)' '([^']*)' '([^']*)' '([0-9a-f]*)' '([0-9a-f]{64})' '([^']*)'$/.exec(command);
    if (write) {
      const [, dir, name, mode, owner, group, replaces, sha256] = write;
      const target = `${dir}/${name}`;
      if (!this.dirs.has(dir)) return exit(20, `not a directory: ${dir}`);
      const present = this.files.get(target);
      if (replaces === '' && present) return exit(17, `already exists: ${target}`);
      if (replaces !== '' && present && crypto.createHash('sha256').update(present.content).digest('hex') !== replaces) return exit(17, `changed since it was inspected: ${target}`);
      if (crypto.createHash('sha256').update(options.stdin ?? '').digest('hex') !== sha256) return exit(22, `content incomplete: ${target}`);
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
    const makeDir = /sencho-mkdir '([^']*)' '([^']*)' '([^']*)' '([^']*)' '([01])' '([^']*)'$/.exec(command);
    if (makeDir) {
      const [, dir, mode, owner, group, allowExisting] = makeDir;
      if (this.dirs.has(dir) && allowExisting !== '1') return exit(17, `already exists: ${dir}`);
      // Missing parents are created like install -d did, owned by whoever creates them.
      for (let parent = dir.slice(0, dir.lastIndexOf('/')); parent && !this.dirs.has(parent); parent = parent.slice(0, parent.lastIndexOf('/'))) {
        this.dirs.set(parent, { mode: '0755', owner: 'root', group: 'root' });
      }
      this.dirs.set(dir, { mode, owner, group });
      return ok();
    }
    if (/(^| )curl -fsSL https:\/\/download.docker.com\/linux\/ubuntu\/gpg$/.test(command)) return ok(DOCKER_KEY_ASC);
    if (command === APT_POLICY_COMMAND) return ok(this.policy);
    if (command.includes('/etc/os-release')) return ok(`${this.codename}\n`);
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

/** Every row, held ones first, as the tests need to find a run by its host. */
function allOperations() {
  return [...db.listActiveNodeBootstrapOperations(10_000), ...db.listFinishedNodeBootstrapOperations(500)];
}

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
  caPem: string | null;
}

let hostCounter = 0;

function harness(options: { facts?: BootstrapFacts; enrollWaitMs?: number; connectOnStart?: boolean; caPem?: string | null; tokenTtlMs?: number; aptLockRetry?: { intervalMs: number; totalMs: number } } = {}): Harness {
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
    const plan = planFrom(facts.current, ctx.planNow ?? NOW, name, options.caPem ?? null);
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
      return { token: `eyJhbGciOiJIUzI1NiJ9.enroll-${nodeId}-${minted.length}.signature-material`, expiresAt: Date.now() + (options.tokenTtlMs ?? 15 * 60_000) };
    },
    enrollWaitMs: options.enrollWaitMs ?? 2_000,
    aptLockRetry: options.aptLockRetry ?? { intervalMs: 5, totalMs: 1_000 },
  });
  if (options.connectOnStart !== false) {
    host.override = (command) => {
      if (command.includes('up -d')) {
        const op = allOperations().find((row) => row.host === hostname);
        if (op?.node_id) setTimeout(() => tunnels.connect(op.node_id as number), 5);
      }
      return undefined;
    };
  }
  return { service, host, tunnels, preflight, facts, minted, name, caPem: options.caPem ?? null };
}

function approve(h: Harness, operationId: string | null = null, actor = TEST_USERNAME): { request: ExecuteRequest; plan: BootstrapPlan } {
  const plan = planFrom(h.facts.current, Date.now(), h.name, h.caPem);
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
    expect(allOperations().filter((row) => row.id === op.id)).toHaveLength(1);
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

    // The session dials the approved address and accepts only the approved host key.
    expect(h.host.openedWith).toEqual([{
      session: { host: plan.target.host, address: plan.target.address, port: plan.target.port, username: plan.target.username },
      expectedFingerprint: plan.hostKeyFingerprint,
    }]);
    // Before installing, apt was asked where every package comes from.
    const policyAt = h.host.commands.findIndex((entry) => entry.command === APT_POLICY_COMMAND);
    const installAt = h.host.commands.findIndex((entry) => /apt-get (-o \S+ )?install /.test(entry.command));
    expect(policyAt).toBeGreaterThan(-1);
    expect(policyAt).toBeLessThan(installAt);

    // The service check runs with the service step's privilege: without D-Bus only root reaches systemd.
    expect(h.host.commands.map((entry) => entry.command)).toContain("sudo -n sh -c 'systemctl is-active docker; systemctl is-enabled docker'");

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
    h.host.override = (command) => (/apt-get (-o \S+ )?install /.test(command)
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
    h.host.override = (command) => (/apt-get (-o \S+ )?install /.test(command)
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
        return { exitCode: 0, stdout: '-----BEGIN PGP PUBLIC KEY BLOCK-----\n\nnot-docker\n-----END PGP PUBLIC KEY BLOCK-----\n', stderr: '', truncated: false, timedOut: false, error: null };
      }
      return undefined;
    };
    const op = h.service.start(request, context());
    await h.service.settled();
    expect(h.service.get(op.id)).toMatchObject({ state: 'partial', error: { code: 'KEY_NOT_VERIFIED' } });
    // The key is checked before anything is written for it, so neither the key nor the source exists.
    expect(h.host.files.has('/etc/apt/keyrings/docker.asc')).toBe(false);
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
    h.host.override = (command) => (/apt-get (-o \S+ )?update/.test(command)
      ? gate.then(() => ({ exitCode: 0, stdout: '', stderr: '', truncated: false, timedOut: false, error: null }))
      : undefined);
    const op = h.service.start(request, context());
    await vi.waitFor(() => expect(h.host.commands.some((entry) => /apt-get (-o \S+ )?update/.test(entry.command))).toBe(true), { timeout: 10_000 });
    const cancelling = h.service.cancel(op.id, AUDIT);
    expect(cancelling.cancelRequested).toBe(true);
    release();
    await h.service.settled();
    const detail = h.service.get(op.id);
    expect(detail.state).toBe('cancelled');
    expect(detail.error?.message).toMatch(/nothing was undone/);
    expect(detail.active).toBe(true);
    expect(h.host.commands.some((entry) => /apt-get (-o \S+ )?install /.test(entry.command))).toBe(false);
    h.service.release(op.id, AUDIT);
  });

  it('records a run that ended in a hub restart as interrupted', () => {
    const h = harness();
    const now = Date.now();
    const base = {
      target_key: 'restart.example.com:22', host: 'restart.example.com', port: 22, username: 'ubuntu', address: '192.168.1.60',
      target_name: 'restart', compose_dir: '/opt/docker/sencho', agent_dir: '/opt/sencho-agent', plan_json: '{}', plan_digest: 'd',
      approved_by: TEST_USERNAME, approved_at: now, attempt: 1, stage: null, step: null, node_id: null, agent_started: 0 as const, active: 1 as const,
      cancel_requested: 0 as const, error_code: null, error_message: null, enrollment_expires_at: null, created_at: now, updated_at: now, finished_at: null,
    };
    db.insertNodeBootstrapOperation({ ...base, id: '00000000-0000-4000-8000-000000000001', state: 'running', changes_made: 1 as const, host_key_fingerprint: 'SHA256:restart-a' });
    db.insertNodeBootstrapOperation({ ...base, id: '00000000-0000-4000-8000-000000000002', state: 'rechecking', changes_made: 0 as const, target_key: 'restart-b.example.com:22', host: 'restart-b.example.com', host_key_fingerprint: 'SHA256:restart-b' });
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
    expect(h.service.retryOwnership(op.id, h.facts.current.target.host, 22)).toEqual({ nodeId, agentStarted: true });
    const second = approve(h, op.id);
    expect(() => h.service.start(second.request, context())).toThrow(/different bootstrap/);
    const nodesBefore = db.getNodes().length;
    const retried = h.service.retry(op.id, second.request, context());
    expect(retried).toMatchObject({ state: 'rechecking', attempt: 2 });
    // The Pilot connects after the retry's enrollment wait ended, as in the first attempt: the stopped run is reconciled when it is read.
    await h.service.settled();
    expect(h.service.get(op.id)).toMatchObject({ state: 'partial', attempt: 2, error: { code: 'ENROLLMENT_NOT_CONNECTED' } });
    h.tunnels.connect(nodeId);

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
    expect(() => h.service.retryOwnership(op.id, request.host, 22)).toThrow(/cannot be retried/);
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

describe('bootstrap operations: failure paths found in review', () => {
  it('records a first step that fails cleanly as failed and releases the target', async () => {
    const h = harness({ facts: makeFacts() });
    const { request } = approve(h);
    h.host.override = (command) => (command.includes("sencho-mkdir '/opt/sencho-agent'")
      ? { exitCode: 1, stdout: '', stderr: 'install: cannot create directory', truncated: false, timedOut: false, error: null }
      : undefined);
    const op = h.service.start(request, context());
    await h.service.settled();
    expect(h.service.get(op.id)).toMatchObject({ state: 'failed', changesMade: false, active: false, error: { code: 'STEP_FAILED' } });
  });

  it('records a failed write on the first change as failed and releases the target', async () => {
    // Docker works and the agent directory exists, so writing the marker file is the first change.
    const h = harness({ facts: makeFacts({ agentDir: {
      exists: true, isDirectory: true, owner: 'ubuntu', group: 'ubuntu', mode: '0700',
      readableByUser: true, writableByUser: true, readableBySudo: true, writableBySudo: true, entries: [],
    } }) });
    h.host.dirs.set('/opt/sencho-agent', { mode: '0700', owner: 'ubuntu', group: 'ubuntu' });
    const { request, plan } = approve(h);
    expect(plan.stages[0]?.steps[0]?.file).toBeTruthy();
    h.host.override = (command) => (command.includes('sencho-write')
      ? { exitCode: 22, stdout: '', stderr: 'content incomplete', truncated: false, timedOut: false, error: null }
      : undefined);
    const op = h.service.start(request, context());
    await h.service.settled();
    expect(h.service.get(op.id)).toMatchObject({ state: 'failed', changesMade: false, active: false, error: { code: 'WRITE_INCOMPLETE' } });
    // A new plan for the same server is accepted: nothing holds it.
    const again = approve(h);
    const next = h.service.start(again.request, context());
    await h.service.settled();
    expect(h.service.get(next.id).state).toBe('failed');
  });

  it('marks a refused candidate check as changing nothing, so it never counts as a change by itself', async () => {
    // At the service level an install always follows a metadata refresh that already counts as a
    // change, so the flag is pinned on the step itself.
    const h = harness();
    h.host.policy = officialPolicy('noble', 'https://mirror.example.com/docker');
    const { request, plan } = approve(h);
    const install = plan.stages.flatMap((stage) => stage.steps).find((step) => step.effect === 'package-install');
    if (!install) throw new Error('The plan has no install step.');
    const session = await h.host.transport().open({ ...request, address: '192.0.2.10', port: 22 }, { expectedFingerprint: 'unused' });
    const ctx: StepContext = {
      session, secrets: [], signal: new AbortController().signal, note: () => undefined,
      composeWithToken: () => { throw new Error('not used'); },
    };
    await expect(runPlanStep(install, ctx, plan)).rejects.toMatchObject({ code: 'CANDIDATE_NOT_VERIFIED', changedNothing: true });
    expect(h.host.commands.some((entry) => /apt-get (-o \S+ )?install /.test(entry.command))).toBe(false);
  });

  it('installs nothing when a mirror also serves the candidate apt would install', async () => {
    const h = harness();
    // apt could fetch the candidate from either archive, so the official one beside it is not enough.
    h.host.policy = officialPolicy().split('noble/stable amd64 Packages').join('noble/stable amd64 Packages\n        500 https://mirror.example.com/docker noble/stable amd64 Packages');
    const { request } = approve(h);
    const op = h.service.start(request, context());
    await h.service.settled();
    expect(h.service.get(op.id).error).toMatchObject({ code: 'CANDIDATE_NOT_VERIFIED' });
    expect(h.host.commands.some((entry) => /apt-get (-o \S+ )?install /.test(entry.command))).toBe(false);
    h.service.release(op.id, AUDIT);
  });

  it('installs nothing when a package candidate does not come from the official repository', async () => {
    const h = harness();
    h.host.policy = officialPolicy('noble', 'https://mirror.example.com/docker');
    const { request } = approve(h);
    const op = h.service.start(request, context());
    await h.service.settled();
    const detail = h.service.get(op.id);
    expect(detail).toMatchObject({ state: 'partial', error: { code: 'CANDIDATE_NOT_VERIFIED' } });
    expect(detail.error?.message).toMatch(/docker-ce has no candidate from the official Docker repository/);
    expect(h.host.commands.some((entry) => /apt-get (-o \S+ )?install /.test(entry.command))).toBe(false);
    h.service.release(op.id, AUDIT);
  });

  it('refuses a file that did not arrive in full and never puts it in place', async () => {
    const h = harness({ facts: makeFacts() });
    const { request } = approve(h);
    h.host.override = (command) => (command.includes("'compose.yaml'") && command.includes('sencho-write')
      ? { exitCode: 22, stdout: '', stderr: 'content incomplete', truncated: false, timedOut: false, error: null }
      : undefined);
    const op = h.service.start(request, context());
    await h.service.settled();
    // Earlier steps had already changed the server, so the run stops partway and keeps it.
    expect(h.service.get(op.id)).toMatchObject({ state: 'partial', error: { code: 'WRITE_INCOMPLETE' }, active: true });
    expect(h.host.files.has('/opt/sencho-agent/compose.yaml')).toBe(false);
    h.service.release(op.id, AUDIT);
    const nodeId = h.service.get(op.id).nodeId;
    if (nodeId) db.deleteNode(nodeId);
  });

  it('writes the hub CA with its planned mode and mounts it in the compose file', async () => {
    const h = harness({ facts: makeFacts(), caPem: HUB_CA });
    const { request, plan } = approve(h);
    expect(plan.stages.flatMap((stage) => stage.steps).some((step) => step.id === 'agent-hub-ca')).toBe(true);
    const op = h.service.start(request, context());
    await h.service.settled();
    expect(h.service.get(op.id).state).toBe('enrolled');
    expect(h.host.files.get('/opt/sencho-agent/sencho-hub-ca.pem')).toMatchObject({ content: HUB_CA, mode: '0644' });
    expect(h.host.files.get('/opt/sencho-agent/compose.yaml')?.content).toContain('SENCHO_PILOT_CA_FILE');
    db.deleteNode(h.service.get(op.id).nodeId as number);
  });

  it.each([
    ['the agent container is not running', 'AGENT_NOT_RUNNING', (h: Harness) => { h.host.agentRunning = false; }],
    ['Compose does not answer', 'COMPOSE_NOT_READY', (h: Harness) => {
      h.host.override = (command) => (command.includes('docker compose version --short')
        ? { exitCode: 1, stdout: '', stderr: "docker: 'compose' is not a docker command.", truncated: false, timedOut: false, error: null }
        : undefined);
    }],
    ['a created directory has the wrong mode', 'VERIFY_FAILED', (h: Harness) => {
      h.host.override = (command) => (command.includes("stat -c '%a %U %G %F' -- '/opt/sencho-agent'")
        ? { exitCode: 0, stdout: '777 ubuntu ubuntu directory\n', stderr: '', truncated: false, timedOut: false, error: null }
        : undefined);
    }],
  ])('requires recovery when %s after its step', async (_label, code, arrange) => {
    const h = harness({ connectOnStart: false, enrollWaitMs: 20 });
    arrange(h);
    const { request } = approve(h);
    const op = h.service.start(request, context());
    await h.service.settled();
    expect(h.service.get(op.id)).toMatchObject({ state: 'recovery_required', error: { code }, active: true });
    h.service.release(op.id, AUDIT);
    const nodeId = h.service.get(op.id).nodeId;
    if (nodeId) db.deleteNode(nodeId);
  });

  it('cancels a run that is still connecting as cancelled, not as a connection failure', async () => {
    const h = harness();
    let open: () => void = () => undefined;
    h.host.openGate = new Promise<void>((resolve) => { open = resolve; });
    const { request } = approve(h);
    const op = h.service.start(request, context());
    await vi.waitFor(() => expect(h.host.opened).toBe(1), { timeout: 10_000 });
    h.service.cancel(op.id, AUDIT);
    await h.service.settled();
    open();
    expect(h.service.get(op.id)).toMatchObject({ state: 'cancelled', changesMade: false, active: false, cancelRequested: false });
  });

  it('cancels while waiting for the Pilot, keeps the target, and reconciles once the Pilot connects', async () => {
    const h = harness({ connectOnStart: false, enrollWaitMs: 60_000 });
    const { request } = approve(h);
    const op = h.service.start(request, context());
    await vi.waitFor(() => expect(h.service.get(op.id).state).toBe('enrolling'), { timeout: 10_000 });
    h.service.cancel(op.id, AUDIT);
    await h.service.settled();
    const cancelled = h.service.get(op.id);
    expect(cancelled).toMatchObject({ state: 'cancelled', active: true, cancelRequested: false });
    h.tunnels.connect(cancelled.nodeId as number);
    expect(h.service.get(op.id)).toMatchObject({ state: 'enrolled', active: false });
    db.deleteNode(cancelled.nodeId as number);
  });

  it('takes a tunnel that is already up, and ignores a tunnel for another node', async () => {
    const up = harness({ connectOnStart: false, enrollWaitMs: 60_000 });
    up.host.override = (command) => {
      if (command.includes('up -d')) {
        const row = allOperations().find((entry) => entry.host === up.facts.current.target.host);
        if (row?.node_id) up.tunnels.active.add(row.node_id);
      }
      return undefined;
    };
    const first = approve(up);
    const op = up.service.start(first.request, context());
    await up.service.settled();
    expect(up.service.get(op.id).state).toBe('enrolled');
    db.deleteNode(up.service.get(op.id).nodeId as number);

    const other = harness({ connectOnStart: false, enrollWaitMs: 50 });
    other.host.override = (command) => {
      if (command.includes('up -d')) setTimeout(() => other.tunnels.emit('tunnel-up', 987_654), 5);
      return undefined;
    };
    const second = approve(other);
    const op2 = other.service.start(second.request, context());
    await other.service.settled();
    expect(other.service.get(op2.id)).toMatchObject({ state: 'partial', error: { code: 'ENROLLMENT_NOT_CONNECTED' } });
    expect(other.tunnels.listenerCount('tunnel-up')).toBe(0);
    other.service.release(op2.id, AUDIT);
    db.deleteNode(other.service.get(op2.id).nodeId as number);
  });

  it('stops waiting when the enrollment expires before the wait does', async () => {
    const h = harness({ connectOnStart: false, enrollWaitMs: 60_000, tokenTtlMs: 40 });
    const { request } = approve(h);
    const started = Date.now();
    const op = h.service.start(request, context());
    await h.service.settled();
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(h.service.get(op.id)).toMatchObject({ state: 'partial', error: { code: 'ENROLLMENT_NOT_CONNECTED' } });
    h.service.release(op.id, AUDIT);
    db.deleteNode(h.service.get(op.id).nodeId as number);
  });

  it('refuses a preflight on a target while its run is in progress', async () => {
    const h = harness({ connectOnStart: false, enrollWaitMs: 60_000 });
    const { request } = approve(h);
    const op = h.service.start(request, context());
    expect(() => h.service.assertTargetIdle(request.host, 22)).toThrow(/A bootstrap is running on this host/);
    expect(() => h.service.assertTargetIdle(request.host.toUpperCase(), 22)).toThrow(/A bootstrap is running/);
    expect(() => h.service.assertTargetIdle('elsewhere.example.com', 22)).not.toThrow();
    h.service.cancel(op.id, AUDIT);
    await h.service.settled();
    expect(() => h.service.assertTargetIdle(request.host, 22)).not.toThrow();
    const nodeId = h.service.get(op.id).nodeId;
    if (h.service.get(op.id).active) h.service.release(op.id, AUDIT);
    if (nodeId) db.deleteNode(nodeId);
  });

  it('keeps the approval usable when the target is held, so release then approve works', async () => {
    const h = harness({ connectOnStart: false, enrollWaitMs: 20 });
    const first = approve(h);
    const op = h.service.start(first.request, context());
    await h.service.settled();
    const second = approve(h);
    expect(() => h.service.start(second.request, context())).toThrow(/Another bootstrap holds this server/);
    h.service.release(op.id, AUDIT);
    db.deleteNode(h.service.get(op.id).nodeId as number);
    const next = h.service.start(second.request, context());
    await h.service.settled();
    expect(h.service.get(next.id).attempt).toBe(1);
    h.service.release(next.id, AUDIT);
    const nodeId = h.service.get(next.id).nodeId;
    if (nodeId) db.deleteNode(nodeId);
  });

  it('records interrupted enrolling and retried runs with what is actually known', () => {
    const h = harness();
    const now = Date.now();
    const base = {
      port: 22, username: 'ubuntu', address: '192.168.1.61', compose_dir: '/opt/docker/sencho', agent_dir: '/opt/sencho-agent',
      plan_json: '{}', plan_digest: 'd', approved_by: TEST_USERNAME, approved_at: now, stage: null, step: null, node_id: null,
      agent_started: 1 as const, active: 1 as const, cancel_requested: 0 as const, error_code: null, error_message: null,
      enrollment_expires_at: null, created_at: now, updated_at: now, finished_at: null,
    };
    db.insertNodeBootstrapOperation({ ...base, id: '00000000-0000-4000-8000-000000000011', target_key: 'enrolling.example.com:22', host: 'enrolling.example.com', target_name: 'enrolling', host_key_fingerprint: 'SHA256:enrolling', attempt: 1, state: 'enrolling', changes_made: 1 });
    db.insertNodeBootstrapOperation({ ...base, id: '00000000-0000-4000-8000-000000000012', target_key: 'retried.example.com:22', host: 'retried.example.com', target_name: 'retried', host_key_fingerprint: 'SHA256:retried', attempt: 2, state: 'rechecking', changes_made: 1 });
    h.service.recoverOnStartup();
    expect(db.getNodeBootstrapOperation('00000000-0000-4000-8000-000000000011')).toMatchObject({ state: 'outcome_unknown', active: 1, error_message: expect.stringMatching(/Every step had run/) });
    // A retry that was still rechecking changed nothing this attempt, but earlier attempts did: the target stays held.
    expect(db.getNodeBootstrapOperation('00000000-0000-4000-8000-000000000012')).toMatchObject({ state: 'blocked', active: 1 });
    h.service.release('00000000-0000-4000-8000-000000000011', AUDIT);
    h.service.release('00000000-0000-4000-8000-000000000012', AUDIT);
  });

  it('keeps state and the target lock across a new service instance on the same database', async () => {
    const h = harness({ connectOnStart: false, enrollWaitMs: 20 });
    const { request } = approve(h);
    const op = h.service.start(request, context());
    await h.service.settled();
    const restarted = new NodeBootstrapOperationService({ db, preflight: { preflight: h.preflight } as unknown as Pick<NodeBootstrapService, 'preflight'>, exec: h.host.transport(), tunnels: h.tunnels });
    expect(restarted.get(op.id)).toMatchObject({ state: 'partial', approvedBy: TEST_USERNAME, hostKeyFingerprint: h.facts.current.hostKey.fingerprint, active: true });
    const again = approve(h);
    restarted.rememberPlan(resultFor(again.plan, h.facts.current), TEST_USERNAME, null);
    expect(() => restarted.start(again.request, context())).toThrow(/Another bootstrap holds this server/);
    h.service.release(op.id, AUDIT);
    db.deleteNode(h.service.get(op.id).nodeId as number);
  });

  it('lists operations without plan bodies, keys or tokens', async () => {
    const h = harness();
    const { request } = approve(h);
    const op = h.service.start(request, context());
    await h.service.settled();
    const row = h.service.list().operations.find((entry) => entry.id === op.id);
    expect(row).toBeDefined();
    expect(row).not.toHaveProperty('plan');
    expect(row).not.toHaveProperty('events');
    expect(JSON.stringify(row)).not.toMatch(/private-key-material|enroll-\d+-\d+/);
    db.deleteNode(h.service.get(op.id).nodeId as number);
  });

  it("ties a retry preflight to the operation's own target", async () => {
    const h = harness({ connectOnStart: false, enrollWaitMs: 20 });
    const { request } = approve(h);
    const op = h.service.start(request, context());
    await h.service.settled();
    expect(() => h.service.retryOwnership(op.id, 'other.example.com', 22)).toThrow(/same server/);
    expect(() => h.service.retryOwnership(op.id, request.host, 2222)).toThrow(/same server/);
    expect(h.service.retryOwnership(op.id, request.host.toUpperCase(), 22)).toMatchObject({ agentStarted: true });
    h.service.release(op.id, AUDIT);
    db.deleteNode(h.service.get(op.id).nodeId as number);
  });
});

describe('bootstrap operations: the node a retry enrolls', () => {
  async function stoppedAtEnrollment(h: Harness) {
    const { request } = approve(h);
    const op = h.service.start(request, context());
    await h.service.settled();
    const stopped = h.service.get(op.id);
    expect(stopped.state).toBe('partial');
    h.facts.current = makeFacts({
      target: h.facts.current.target,
      hostKey: h.facts.current.hostKey,
      agentDir: {
        exists: true, isDirectory: true, realPath: '/opt/sencho-agent', writableByUser: true, readableByUser: true,
        entries: ['compose.yaml', 'sencho-bootstrap.json'], hasMarker: true, hasComposeFile: true,
        markerProject: 'sencho-agent', markerComposeDir: '/opt/docker/sencho', markerAgentDir: '/opt/sencho-agent',
      },
    });
    return stopped;
  }

  async function retryToEnd(h: Harness, id: string) {
    const again = approve(h, id);
    h.service.retry(id, again.request, context());
    await h.service.settled();
    return h.service.get(id);
  }

  it('reuses the node by id even after it was renamed', async () => {
    const h = harness({ connectOnStart: false, enrollWaitMs: 20 });
    const stopped = await stoppedAtEnrollment(h);
    db.updateNode(stopped.nodeId as number, { name: `${h.name}-renamed` });
    const nodes = db.getNodes().length;
    const after = await retryToEnd(h, stopped.id);
    expect(after.nodeId).toBe(stopped.nodeId);
    expect(db.getNodes()).toHaveLength(nodes);
    h.service.release(stopped.id, AUDIT);
    db.deleteNode(stopped.nodeId as number);
  });

  it('registers a new node when the earlier one was deleted', async () => {
    const h = harness({ connectOnStart: false, enrollWaitMs: 20 });
    const stopped = await stoppedAtEnrollment(h);
    db.deleteNode(stopped.nodeId as number);
    const after = await retryToEnd(h, stopped.id);
    expect(after.nodeId).not.toBeNull();
    expect(after.nodeId).not.toBe(stopped.nodeId);
    expect(db.getNode(after.nodeId as number)?.name).toBe(h.name);
    h.service.release(stopped.id, AUDIT);
    db.deleteNode(after.nodeId as number);
  });

  it('refuses to register a second node under a name another node took meanwhile', async () => {
    const h = harness({ connectOnStart: false, enrollWaitMs: 20 });
    const stopped = await stoppedAtEnrollment(h);
    db.deleteNode(stopped.nodeId as number);
    const squatter = db.addNode({ name: h.name, type: 'remote', compose_dir: '/opt/docker/sencho', is_default: false, api_url: 'http://192.168.1.99:1852', api_token: 't', mode: 'proxy' });
    const after = await retryToEnd(h, stopped.id);
    expect(after).toMatchObject({ error: { code: 'NODE_NAME_TAKEN' } });
    expect(db.getNodes().filter((node) => node.name === h.name)).toHaveLength(1);
    h.service.release(stopped.id, AUDIT);
    db.deleteNode(squatter);
  });
});

describe('bootstrap recheck: the address pin', () => {
  it('refuses before any SSH work when the host no longer resolves to the approved address', async () => {
    const runCommands = vi.fn();
    const service = new RealPreflightService({
      db,
      transport: { captureHostKey: vi.fn(), runCommands },
      resolveAddresses: async () => ['192.168.1.77'],
      caPem: () => null,
    });
    await expect(service.preflight({
      host: 'pinned.example.com',
      username: 'ubuntu',
      privateKey: PRIVATE_KEY,
      expectedFingerprint: 'SHA256:pinned',
      targetName: 'pinned',
    }, {
      hubUrl: HUB_URL,
      audit: AUDIT,
      pinnedAddress: '192.168.1.76',
    })).rejects.toMatchObject({ code: 'TARGET_CHANGED' });
    expect(runCommands).not.toHaveBeenCalled();
  });
});

describe('bootstrap operations: round two review cases', () => {
  /** A host whose official Docker source is configured and verified, with Docker not yet installed. */
  const repoReadyFacts = () => freshFacts({
    repo: { dockerSourceConfigured: true, keyringPresent: true, sourceVerified: true, keyringVerified: true, candidateSourceVerified: true, sourceLocations: 'default' },
  });

  it('reads a policy far longer than the command output tail and installs from it', async () => {
    const h = harness();
    // Real hosts list every version the repository serves: about 32 KB for the five packages.
    const versions = Array.from({ length: 400 }, (_, index) => `     1.0.${index}-1 500\n        500 https://download.docker.com/linux/ubuntu noble/stable amd64 Packages`).join('\n');
    h.host.policy = officialPolicy().split('\n  Version table:\n').join(`\n  Version table:\n${versions}\n`);
    expect(h.host.policy.length).toBeGreaterThan(16 * 1024);
    const { request } = approve(h);
    const op = h.service.start(request, context());
    await h.service.settled();
    expect(h.service.get(op.id).state).toBe('enrolled');
    db.deleteNode(h.service.get(op.id).nodeId as number);
  });

  it.each([
    ['the archives serve another release', (h: Harness) => { h.host.codename = 'jammy'; }, /no candidate from the official Docker repository/],
    ['apt cannot answer', (h: Harness) => {
      h.host.override = (command) => (command === APT_POLICY_COMMAND ? { exitCode: 100, stdout: '', stderr: 'E: broken sources', truncated: false, timedOut: false, error: null } : undefined);
    }, /apt could not report/],
    ['the host release cannot be read', (h: Harness) => {
      h.host.override = (command) => (command.includes('/etc/os-release') ? { exitCode: 1, stdout: '', stderr: 'No such file', truncated: false, timedOut: false, error: null } : undefined);
    }, /host release could not be read/],
  ])('installs nothing when %s', async (_label, arrange, message) => {
    const h = harness();
    arrange(h);
    const { request } = approve(h);
    const op = h.service.start(request, context());
    await h.service.settled();
    const detail = h.service.get(op.id);
    expect(detail).toMatchObject({ state: 'partial', error: { code: 'CANDIDATE_NOT_VERIFIED' } });
    expect(detail.error?.message).toMatch(message);
    expect(h.host.commands.some((entry) => /apt-get (-o \S+ )?install /.test(entry.command))).toBe(false);
    h.service.release(op.id, AUDIT);
  });

  it('installs nothing when a pinned version is no longer the candidate', async () => {
    const pinned = freshFacts({
      repo: { dockerSourceConfigured: true, keyringPresent: true, sourceVerified: true, keyringVerified: true, candidateSourceVerified: true, sourceLocations: 'default' },
      packages: ['docker-ce', 'docker-ce-cli', 'containerd.io', 'docker-buildx-plugin', 'docker-compose-plugin'].map((name) => ({
        name: name as 'docker-ce', installedVersion: null, candidateVersion: '0.9.0-1',
        candidateSources: [{ uri: 'https://download.docker.com/linux/ubuntu' as const, official: true }],
      })),
    });
    const h = harness({ facts: pinned });
    const { request, plan } = approve(h);
    expect(plan.stages.flatMap((stage) => stage.steps).find((step) => step.id === 'install-docker-packages')?.command).toContain('docker-ce=0.9.0-1');
    const op = h.service.start(request, context());
    await h.service.settled();
    expect(h.service.get(op.id).error?.message).toMatch(/docker-ce would install 1\.0\.0-1, not 0\.9\.0-1/);
    if (h.service.get(op.id).active) h.service.release(op.id, AUDIT);
  });

  it('retries the metadata refresh while another apt job holds the lists lock, within a bound', async () => {
    const locked = { exitCode: 100, stdout: '', stderr: 'E: Could not get lock /var/lib/apt/lists/lock. It is held by process 812 (apt-get)', truncated: false, timedOut: false, error: null };
    const waits = harness();
    let held = 2;
    const connect = waits.host.override;
    waits.host.override = (command, options) => (/apt-get (-o \S+ )?update/.test(command) && held-- > 0 ? locked : connect?.(command, options));
    const first = approve(waits);
    const op = waits.service.start(first.request, context());
    await waits.service.settled();
    expect(waits.service.get(op.id).error).toBeNull();
    expect(waits.service.get(op.id).state).toBe('enrolled');
    expect(waits.host.commands.filter((entry) => /apt-get (-o \S+ )?update/.test(entry.command))).toHaveLength(3);
    // The wait is noted once, not once per retry.
    expect(waits.service.get(op.id).events.filter((event) => /holds the package lists/.test(event.message))).toHaveLength(1);
    db.deleteNode(waits.service.get(op.id).nodeId as number);

    const never = harness();
    never.host.override = (command) => (/apt-get (-o \S+ )?update/.test(command) ? locked : undefined);
    const second = approve(never);
    const op2 = never.service.start(second.request, context());
    await never.service.settled();
    expect(never.service.get(op2.id)).toMatchObject({ state: 'partial', error: { code: 'STEP_FAILED' } });
    const attempts = never.host.commands.filter((entry) => /apt-get (-o \S+ )?update/.test(entry.command)).length;
    // Retried, then given up once the bound ran out instead of waiting forever.
    expect(attempts).toBeGreaterThan(2);
    expect(attempts).toBeLessThanOrEqual(1_000 / 5 + 1);
    never.service.release(op2.id, AUDIT);
  });

  it('stops waiting for the lists lock when the operator cancels, and says it is waiting', async () => {
    const locked = { exitCode: 100, stdout: '', stderr: 'E: Could not get lock /var/lib/apt/lists/lock. It is held by process 812 (apt-get)', truncated: false, timedOut: false, error: null };
    const h = harness({ facts: repoReadyFacts(), aptLockRetry: { intervalMs: 60_000, totalMs: 300_000 } });
    h.host.override = (command) => (/apt-get (-o \S+ )?update/.test(command) ? locked : undefined);
    const { request, plan } = approve(h);
    // The Docker source is already in place, so the refresh is the run's first step.
    expect(plan.stages[0]?.steps[0]?.id).toBe('apt-update');
    const op = h.service.start(request, context());
    await vi.waitFor(() => expect(h.service.get(op.id).events.some((event) => /holds the package lists/.test(event.message))).toBe(true), { timeout: 10_000 });
    const cancelledAt = Date.now();
    h.service.cancel(op.id, AUDIT);
    await h.service.settled();
    // The wait is a minute long; the cancel ends it at once.
    expect(Date.now() - cancelledAt).toBeLessThan(5_000);
    // The refused refresh changed nothing, so the cancel leaves the server free.
    expect(h.service.get(op.id)).toMatchObject({
      state: 'cancelled', changesMade: false, active: false,
      error: { code: 'CANCELLED', message: 'Cancelled before anything was changed.' },
    });
    expect(h.host.commands.filter((entry) => /apt-get (-o \S+ )?update/.test(entry.command))).toHaveLength(1);
  });

  it('does not start the lists-lock wait when the cancel lands while the refresh runs', async () => {
    const locked = { exitCode: 100, stdout: '', stderr: 'E: Could not get lock /var/lib/apt/lists/lock. It is held by process 812 (apt-get)', truncated: false, timedOut: false, error: null };
    const h = harness({ facts: repoReadyFacts(), aptLockRetry: { intervalMs: 60_000, totalMs: 300_000 } });
    let answer: () => void = () => undefined;
    let running = false;
    h.host.override = (command) => {
      if (!/apt-get (-o \S+ )?update/.test(command)) return undefined;
      running = true;
      return new Promise((resolve) => { answer = () => resolve(locked); });
    };
    const { request, plan } = approve(h);
    // The Docker source is already in place, so the refresh is the run's first step.
    expect(plan.stages[0]?.steps[0]?.id).toBe('apt-update');
    const op = h.service.start(request, context());
    await vi.waitFor(() => expect(running).toBe(true), { timeout: 10_000 });
    const cancelledAt = Date.now();
    h.service.cancel(op.id, AUDIT);
    answer();
    await h.service.settled();
    expect(Date.now() - cancelledAt).toBeLessThan(5_000);
    expect(h.service.get(op.id)).toMatchObject({ state: 'cancelled', changesMade: false, active: false });
    expect(h.service.get(op.id).events.some((event) => /holds the package lists/.test(event.message))).toBe(false);
    expect(h.host.commands.filter((entry) => /apt-get (-o \S+ )?update/.test(entry.command))).toHaveLength(1);
  });

  it('keeps a step failure that lands after a cancel request instead of calling it cancelled', async () => {
    const h = harness({ facts: makeFacts() });
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    h.host.override = (command) => (command.includes('up -d')
      ? gate.then(() => ({ exitCode: null, stdout: '', stderr: '', truncated: false, timedOut: false, error: 'CONNECTION_LOST' as const }))
      : undefined);
    const { request } = approve(h);
    const op = h.service.start(request, context());
    await vi.waitFor(() => expect(h.host.commands.some((entry) => entry.command.includes('up -d'))).toBe(true), { timeout: 10_000 });
    h.service.cancel(op.id, AUDIT);
    release();
    await h.service.settled();
    expect(h.service.get(op.id)).toMatchObject({ state: 'outcome_unknown', error: { code: 'SSH_CONNECTION_LOST' }, active: true });
    h.service.release(op.id, AUDIT);
    const nodeId = h.service.get(op.id).nodeId;
    if (nodeId) db.deleteNode(nodeId);
  });

  it('audits how each attempt ended', async () => {
    const h = harness({ facts: makeFacts(), connectOnStart: false, enrollWaitMs: 20 });
    const { request } = approve(h);
    const op = h.service.start(request, context());
    await h.service.settled();
    const rows = db.getAuditLogs({ limit: 500, search: op.id }).entries.map((row) => ({ summary: row.summary, status: row.status_code }));
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ summary: expect.stringMatching(/^bootstrap\.execute\.approved: operation=/), status: 200 }),
      expect.objectContaining({ summary: expect.stringMatching(/^bootstrap\.execute\.finished: .*state=partial .*code=ENROLLMENT_NOT_CONNECTED/), status: 500 }),
    ]));
    h.service.release(op.id, AUDIT);
    db.deleteNode(h.service.get(op.id).nodeId as number);
  });

  it('checks the compose file before registering a node or minting anything', async () => {
    const h = harness({ facts: makeFacts() });
    const tampered = (plan: BootstrapPlan): BootstrapPlan => ({
      ...plan,
      stages: plan.stages.map((stage) => ({
        ...stage,
        steps: stage.steps.map((step) => (step.id === 'agent-compose-file' && step.file
          ? { ...step, file: { ...step.file, content: `${step.file.content}# changed\n` } }
          : step)),
      })),
    });
    h.preflight.mockImplementation(async (_input: unknown, ctx: { planNow?: number }) => resultFor(tampered(planFrom(h.facts.current, ctx.planNow ?? NOW, h.name)), h.facts.current));
    const plan = tampered(planFrom(h.facts.current, Date.now(), h.name));
    h.service.rememberPlan(resultFor(plan, h.facts.current), TEST_USERNAME, null);
    const nodes = db.getNodes().length;
    const op = h.service.start({
      host: plan.target.host, port: plan.target.port, username: plan.target.username, privateKey: PRIVATE_KEY, passphrase: null,
      expectedFingerprint: plan.hostKeyFingerprint, targetName: plan.targetName, composeDir: plan.paths.composeDir.input,
      agentDir: plan.paths.agentDir.input, planDigest: plan.digest,
    }, context());
    await h.service.settled();
    const detail = h.service.get(op.id);
    expect(detail.error?.code).toBe('PLAN_INVALID');
    expect(detail.nodeId).toBeNull();
    expect(h.minted).toEqual([]);
    expect(db.getNodes()).toHaveLength(nodes);
    if (detail.active) h.service.release(op.id, AUDIT);
  });

  it('holds the target once a node is registered, even when the compose write then fails cleanly', async () => {
    // A leftover marker means nothing before the compose file changes the host.
    const h = harness({
      facts: makeFacts({
        agentDir: {
          exists: true, isDirectory: true, realPath: '/opt/sencho-agent', writableByUser: true, readableByUser: true,
          entries: ['sencho-bootstrap.json'], hasMarker: true, markerProject: 'sencho-agent',
          markerComposeDir: '/opt/docker/sencho', markerAgentDir: '/opt/sencho-agent',
        },
      }),
    });
    h.host.dirs.set('/opt/sencho-agent', { mode: '0700', owner: 'ubuntu', group: 'ubuntu' });
    h.host.files.set('/opt/sencho-agent/sencho-bootstrap.json', {
      content: JSON.stringify({ project: 'sencho-agent', composeDir: '/opt/docker/sencho', agentDir: '/opt/sencho-agent' }),
      mode: '0600', owner: 'ubuntu', group: 'ubuntu',
    });
    h.host.override = (command) => (command.includes("'compose.yaml'") && command.includes('sencho-write')
      ? { exitCode: 1, stdout: '', stderr: 'mktemp: failed', truncated: false, timedOut: false, error: null }
      : undefined);
    const { request } = approve(h);
    const op = h.service.start(request, context());
    await h.service.settled();
    const detail = h.service.get(op.id);
    expect(detail.nodeId).not.toBeNull();
    expect(detail).toMatchObject({ state: 'partial', active: true, actions: { retry: true } });
    h.service.release(op.id, AUDIT);
    db.deleteNode(detail.nodeId as number);
  });

  it('consumes a retry approval only once and clears the previous enrollment expiry', async () => {
    const h = harness({ connectOnStart: false, enrollWaitMs: 20 });
    const first = approve(h);
    const op = h.service.start(first.request, context());
    await h.service.settled();
    expect(h.service.get(op.id).enrollmentExpiresAt).not.toBeNull();
    let release: () => void = () => undefined;
    h.host.openGate = new Promise<void>((resolve) => { release = resolve; });
    const again = approve(h, op.id);
    const retried = h.service.retry(op.id, again.request, context());
    expect(retried.enrollmentExpiresAt).toBeNull();
    h.service.cancel(op.id, AUDIT);
    release();
    await h.service.settled();
    expect(() => h.service.retry(op.id, again.request, context())).toThrow(/no longer current/);
    if (h.service.get(op.id).active) h.service.release(op.id, AUDIT);
    db.deleteNode(h.service.get(op.id).nodeId as number);
  });

  it('refuses to release a run in progress or one already released', async () => {
    const h = harness({ connectOnStart: false, enrollWaitMs: 60_000 });
    const { request } = approve(h);
    const op = h.service.start(request, context());
    expect(() => h.service.release(op.id, AUDIT)).toThrow(/Only a stopped bootstrap/);
    await vi.waitFor(() => expect(h.service.get(op.id).state).toBe('enrolling'), { timeout: 10_000 });
    h.service.cancel(op.id, AUDIT);
    await h.service.settled();
    expect(h.service.get(op.id).active).toBe(true);
    h.service.release(op.id, AUDIT);
    expect(() => h.service.release(op.id, AUDIT)).toThrow(/Only a stopped bootstrap/);
    db.deleteNode(h.service.get(op.id).nodeId as number);
  });

  it('refuses an update naming a column outside the operation table', () => {
    expect(() => db.updateNodeBootstrapOperation('x', { ['state; DROP TABLE nodes' as 'stage']: 'x' }, Date.now())).toThrow(/Unknown bootstrap operation column/);
  });

  it('recovers every interrupted row even when one cannot be written', () => {
    const h = harness();
    const now = Date.now();
    const base = {
      port: 22, username: 'ubuntu', address: '192.168.1.62', compose_dir: '/opt/docker/sencho', agent_dir: '/opt/sencho-agent',
      plan_json: '{}', plan_digest: 'd', approved_by: TEST_USERNAME, approved_at: now, stage: null, step: null, node_id: null,
      agent_started: 0 as const, active: 1 as const, cancel_requested: 0 as const, error_code: null, error_message: null,
      enrollment_expires_at: null, created_at: now, updated_at: now, finished_at: null, attempt: 1, state: 'running' as const, changes_made: 1 as const,
    };
    db.insertNodeBootstrapOperation({ ...base, id: '00000000-0000-4000-8000-000000000021', target_key: 'a.example.com:22', host: 'a.example.com', target_name: 'a', host_key_fingerprint: 'SHA256:a' });
    db.insertNodeBootstrapOperation({ ...base, id: '00000000-0000-4000-8000-000000000022', target_key: 'b.example.com:22', host: 'b.example.com', target_name: 'b', host_key_fingerprint: 'SHA256:b' });
    const real = db.transitionNodeBootstrapOperation.bind(db);
    const spy = vi.spyOn(db, 'transitionNodeBootstrapOperation').mockImplementationOnce(() => { throw new Error('SQLITE_BUSY'); }).mockImplementation(real);
    h.service.recoverOnStartup();
    spy.mockRestore();
    const states = ['00000000-0000-4000-8000-000000000021', '00000000-0000-4000-8000-000000000022'].map((id) => db.getNodeBootstrapOperation(id)?.state);
    expect(states.filter((state) => state === 'outcome_unknown')).toHaveLength(1);
    expect(states.filter((state) => state === 'running')).toHaveLength(1);
    // The row that could not be written is recovered on the next start.
    h.service.recoverOnStartup();
    expect(states.length).toBe(2);
    for (const id of ['00000000-0000-4000-8000-000000000021', '00000000-0000-4000-8000-000000000022']) {
      expect(db.getNodeBootstrapOperation(id)?.state).toBe('outcome_unknown');
      h.service.release(id, AUDIT);
    }
  });

  it('marks a run whose own error path failed as stopped on an internal error, not as a restart', async () => {
    const h = harness({ facts: makeFacts() });
    h.host.override = (command) => (command.includes("sencho-mkdir '/opt/sencho-agent'")
      ? { exitCode: 1, stdout: '', stderr: 'denied', truncated: false, timedOut: false, error: null }
      : undefined);
    // The run's own finish (a compare-and-set out of the running states) fails once.
    const real = db.transitionNodeBootstrapOperation.bind(db);
    let failed = false;
    const spy = vi.spyOn(db, 'transitionNodeBootstrapOperation').mockImplementation((id, from, updates, now) => {
      if (!failed && from.length === 3 && updates.state === 'failed') {
        failed = true;
        throw new Error('SQLITE_BUSY');
      }
      return real(id, from, updates, now);
    });
    const { request } = approve(h);
    const op = h.service.start(request, context());
    await h.service.settled();
    spy.mockRestore();
    expect(db.getNodeBootstrapOperation(op.id)).toMatchObject({ error_code: 'RUN_ABORTED', error_message: expect.stringMatching(/internal error/) });
    if (db.getNodeBootstrapOperation(op.id)?.active === 1) h.service.release(op.id, AUDIT);
  });
});

describe('bootstrap operations: S1 a failed setup does not strand the operation', () => {
  const disk = () => new Error('SQLITE_FULL: database or disk is full');

  function rowFor(host: string) {
    return allOperations().find((row) => row.host === host);
  }

  it('stops a start whose first event cannot be written, and lets the server be started again', async () => {
    const h = harness();
    const { request } = approve(h);
    const spy = vi.spyOn(db, 'appendNodeBootstrapEvent').mockImplementationOnce(() => { throw disk(); });
    expect(() => h.service.start(request, context())).toThrow(/SQLITE_FULL/);
    spy.mockRestore();
    const row = rowFor(request.host);
    expect(row).toMatchObject({ state: 'blocked', active: 0, changes_made: 0, error_code: 'RUN_ABORTED' });
    expect(h.host.commands).toEqual([]);
    // The database is writable again: nothing needs a restart, and the server is free to start.
    const again = approve(h);
    const op = h.service.start(again.request, context());
    await h.service.settled();
    expect(h.service.get(op.id).state).toBe('enrolled');
    db.deleteNode(h.service.get(op.id).nodeId as number);
  });

  it('keeps an earlier attempt\'s changes and hold when a retry cannot record its first event, and the retry works afterwards', async () => {
    const h = harness({ connectOnStart: false, enrollWaitMs: 20 });
    const first = approve(h);
    const op = h.service.start(first.request, context());
    await h.service.settled();
    const stopped = h.service.get(op.id);
    expect(stopped).toMatchObject({ state: 'partial', active: true, changesMade: true });
    const nodeId = stopped.nodeId as number;
    h.facts.current = makeFacts({
      target: h.facts.current.target,
      hostKey: h.facts.current.hostKey,
      agentDir: {
        exists: true, isDirectory: true, realPath: '/opt/sencho-agent', writableByUser: true, readableByUser: true,
        entries: ['compose.yaml', 'sencho-bootstrap.json'], hasMarker: true, hasComposeFile: true,
        markerProject: 'sencho-agent', markerComposeDir: '/opt/docker/sencho', markerAgentDir: '/opt/sencho-agent',
      },
    });
    const second = approve(h, op.id);
    const spy = vi.spyOn(db, 'appendNodeBootstrapEvent').mockImplementationOnce(() => { throw disk(); });
    expect(() => h.service.retry(op.id, second.request, context())).toThrow(/SQLITE_FULL/);
    spy.mockRestore();

    const stranded = h.service.get(op.id);
    expect(stranded).toMatchObject({ state: 'blocked', active: true, changesMade: true, attempt: 2, nodeId, actions: { retry: true, release: true, cancel: false } });
    const third = approve(h, op.id);
    h.service.retry(op.id, third.request, context());
    await h.service.settled();
    expect(h.service.get(op.id)).toMatchObject({ state: 'partial', nodeId, attempt: 3, error: { code: 'ENROLLMENT_NOT_CONNECTED' } });
    h.tunnels.connect(nodeId);
    expect(h.service.get(op.id)).toMatchObject({ state: 'enrolled', active: false, nodeId, attempt: 3 });
    db.deleteNode(nodeId);
  });

  it('settles a row nothing could write back, on the next read, so no action stays refused', async () => {
    const h = harness();
    const { request } = approve(h);
    const real = db.transitionNodeBootstrapOperation.bind(db);
    const events = vi.spyOn(db, 'appendNodeBootstrapEvent').mockImplementationOnce(() => { throw disk(); });
    // The database refuses the cleanup too.
    const transitions = vi.spyOn(db, 'transitionNodeBootstrapOperation').mockImplementationOnce(() => { throw disk(); }).mockImplementation(real);
    expect(() => h.service.start(request, context())).toThrow(/SQLITE_FULL/);
    events.mockRestore();
    transitions.mockRestore();
    expect(rowFor(request.host)).toMatchObject({ state: 'rechecking', active: 1 });

    // A new preflight for the server is not refused as busy, and the list and the row settle it.
    expect(() => h.service.assertTargetIdle(request.host, request.port as number)).not.toThrow();
    const row = rowFor(request.host);
    expect(row).toMatchObject({ state: 'blocked', active: 0 });
    const listed = h.service.list().operations.find((entry) => entry.id === row?.id);
    expect(listed).toMatchObject({ state: 'blocked', active: false });
  });

  it('settles a stranded row that holds earlier changes into one that can be retried or released', () => {
    const h = harness();
    const now = Date.now();
    db.insertNodeBootstrapOperation({
      id: '00000000-0000-4000-8000-0000000000a1', target_key: 'stranded.example.com:22', host: 'stranded.example.com', port: 22, username: 'ubuntu',
      address: '192.168.1.70', target_name: 'stranded', host_key_fingerprint: 'SHA256:stranded', compose_dir: '/opt/docker/sencho', agent_dir: '/opt/sencho-agent',
      plan_json: '{}', plan_digest: 'd', approved_by: TEST_USERNAME, approved_at: now, attempt: 2, state: 'rechecking', stage: null, step: null, node_id: null,
      changes_made: 1, agent_started: 0, active: 1, cancel_requested: 0, error_code: null, error_message: null, enrollment_expires_at: null,
      created_at: now, updated_at: now, finished_at: null,
    });
    const view = h.service.get('00000000-0000-4000-8000-0000000000a1');
    expect(view).toMatchObject({ state: 'blocked', active: true, changesMade: true, actions: { retry: true, release: true } });
    h.service.release(view.id, AUDIT);
  });
});

describe('bootstrap operations: a stranded row is settled by the action that meets it', () => {
  it('releases a stranded row that holds earlier changes on the first request', () => {
    const h = harness();
    const now = Date.now();
    const id = '00000000-0000-4000-8000-0000000000b1';
    db.insertNodeBootstrapOperation({
      id, target_key: 'stranded-release.example.com:22', host: 'stranded-release.example.com', port: 22, username: 'ubuntu',
      address: '192.168.1.71', target_name: 'stranded-release', host_key_fingerprint: 'SHA256:stranded-release', compose_dir: '/opt/docker/sencho', agent_dir: '/opt/sencho-agent',
      plan_json: '{}', plan_digest: 'd', approved_by: TEST_USERNAME, approved_at: now, attempt: 2, state: 'rechecking', stage: null, step: null, node_id: null,
      changes_made: 1, agent_started: 0, active: 1, cancel_requested: 0, error_code: null, error_message: null, enrollment_expires_at: null,
      created_at: now, updated_at: now, finished_at: null,
    });
    expect(h.service.release(id, AUDIT)).toMatchObject({ active: false });
  });

  it('retries a stranded row on the first request, keeping its node', async () => {
    const h = harness({ connectOnStart: false, enrollWaitMs: 20 });
    const first = approve(h);
    const op = h.service.start(first.request, context());
    await h.service.settled();
    const nodeId = h.service.get(op.id).nodeId as number;
    // The state a failed retry setup leaves behind when the database also refused the cleanup.
    expect(db.transitionNodeBootstrapOperation(op.id, ['partial'], { state: 'rechecking', attempt: 2 }, Date.now())).toBe(true);
    h.facts.current = makeFacts({
      target: h.facts.current.target,
      hostKey: h.facts.current.hostKey,
      agentDir: {
        exists: true, isDirectory: true, realPath: '/opt/sencho-agent', writableByUser: true, readableByUser: true,
        entries: ['compose.yaml', 'sencho-bootstrap.json'], hasMarker: true, hasComposeFile: true,
        markerProject: 'sencho-agent', markerComposeDir: '/opt/docker/sencho', markerAgentDir: '/opt/sencho-agent',
      },
    });
    const second = approve(h, op.id);
    expect(() => h.service.retry(op.id, second.request, context())).not.toThrow();
    // The retry ran to the end of its enrollment wait (the Pilot never connects here), so it was not stranded.
    await h.service.settled();
    expect(h.service.get(op.id)).toMatchObject({ state: 'partial', nodeId, attempt: 3, error: { code: 'ENROLLMENT_NOT_CONNECTED' } });
    h.tunnels.connect(nodeId);
    expect(h.service.get(op.id)).toMatchObject({ state: 'enrolled', nodeId });
    db.deleteNode(nodeId);
  });
});

describe('bootstrap operations: S2 every held run stays discoverable', () => {
  // The page counts below need a list that holds only what each test inserts, whatever an earlier test left held.
  beforeEach(() => {
    for (const row of db.listActiveNodeBootstrapOperations(10_000)) db.transitionNodeBootstrapOperation(row.id, [row.state], { active: 0 }, Date.now());
  });

  /** `index` orders the rows (a higher one is newer); the name is unique across the tests, since released rows keep their ids. */
  let heldSerial = 0;
  function insertHeld(index: number, state: 'partial' | 'blocked' = 'partial', at?: number) {
    const now = at ?? Date.now() + index;
    heldSerial += 1;
    const id = `00000000-0000-4000-8000-${String(1000 + heldSerial).padStart(12, '0')}`;
    db.insertNodeBootstrapOperation({
      id, target_key: `held-${heldSerial}.example.com:22`, host: `held-${heldSerial}.example.com`, port: 22, username: 'ubuntu', address: '192.168.1.80',
      target_name: `held-${heldSerial}`, host_key_fingerprint: `SHA256:held-${heldSerial}`, compose_dir: '/opt/docker/sencho', agent_dir: '/opt/sencho-agent',
      plan_json: '{}', plan_digest: 'd', approved_by: TEST_USERNAME, approved_at: now, attempt: 1, state, stage: null, step: null, node_id: null,
      changes_made: 1, agent_started: 0, active: 1, cancel_requested: 0, error_code: null, error_message: null, enrollment_expires_at: null,
      created_at: now, updated_at: now, finished_at: now,
    });
    return id;
  }

  /** Every hold the pages return, following the cursor to the end. */
  function traverse(h: ReturnType<typeof harness>, between: (page: number, cursor: string | null) => void = () => undefined): { ids: string[]; pages: number[] } {
    const ids: string[] = [];
    const pages: number[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 50; page += 1) {
      const result = h.service.list(cursor);
      const holds = result.operations.filter((entry) => entry.active).map((entry) => entry.id);
      ids.push(...holds);
      pages.push(holds.length);
      cursor = result.nextCursor;
      if (cursor === null) return { ids, pages };
      between(page, cursor);
    }
    throw new Error('the pages never ended');
  }

  it('pages through twenty-five held runs, the oldest included, and opens each one with its recovery actions', () => {
    const h = harness();
    const ids = Array.from({ length: 25 }, (_, index) => insertHeld(index));
    const first = h.service.list();
    // One page is bounded, and says where the rest begins.
    expect(first.operations.filter((entry) => entry.active)).toHaveLength(20);
    expect(first.nextCursor).not.toBeNull();
    const { ids: seen, pages } = traverse(h);
    expect(pages).toEqual([20, 5]);
    expect([...seen].sort()).toEqual([...ids].sort());
    expect(new Set(seen).size).toBe(seen.length);
    // The newest holds come first, so the oldest is on the last page and still opens.
    expect(seen[seen.length - 1]).toBe(ids[0]);
    expect(h.service.get(ids[0])).toMatchObject({ active: true, actions: { release: true } });
    for (const id of ids) h.service.release(id, AUDIT);
  });

  it('does only a bounded read and reconcile per page however many holds have piled up', () => {
    const h = harness();
    const ids = Array.from({ length: 45 }, (_, index) => insertHeld(index));
    const reads = vi.spyOn(db, 'listActiveNodeBootstrapOperations');
    const { pages } = traverse(h);
    expect(pages).toEqual([20, 20, 5]);
    for (const [limit] of reads.mock.calls) expect(limit).toBeLessThanOrEqual(21);
    reads.mockRestore();
    for (const id of ids) h.service.release(id, AUDIT);
  });

  it('keeps every hold reachable when runs settle, are released or start while the pages are read', () => {
    const h = harness();
    const ids = Array.from({ length: 50 }, (_, index) => insertHeld(index));
    // ids[49] is the newest. Page one holds ids[49..30]; the cursor sits on ids[30].
    const lateId = { value: '' };
    const { ids: seen } = traverse(h, (page) => {
      if (page !== 0) return;
      // The run the cursor stands on is released, one not yet read settles, and a new one starts.
      h.service.release(ids[30], AUDIT);
      h.service.release(ids[10], AUDIT);
      lateId.value = insertHeld(100);
    });
    // Nothing still held was skipped, and nothing was returned twice.
    const stillHeld = ids.filter((id) => id !== ids[30] && id !== ids[10]);
    for (const id of stillHeld) expect(seen).toContain(id);
    expect(seen).not.toContain(ids[10]);
    expect(new Set(seen).size).toBe(seen.length);
    // The run that started meanwhile is newer than the cursor: the next read of the first page shows it.
    expect(seen).not.toContain(lateId.value);
    expect(h.service.list().operations.filter((entry) => entry.active).map((entry) => entry.id)).toContain(lateId.value);
    for (const id of [...stillHeld, lateId.value]) h.service.release(id, AUDIT);
  });

  it('keeps every hold that was created in the same millisecond reachable across a page boundary', () => {
    const h = harness();
    const at = Date.now() + 5_000;
    const ids = Array.from({ length: 25 }, (_, index) => insertHeld(index, 'partial', at));
    const { ids: seen, pages } = traverse(h);
    expect(pages).toEqual([20, 5]);
    expect([...seen].sort()).toEqual([...ids].sort());
    expect(new Set(seen).size).toBe(25);
    for (const id of ids) h.service.release(id, AUDIT);
  });

  it('reads each page of holds from an index in the order it returns them, so the cost follows the page', () => {
    const raw = (db as unknown as { db: { prepare: (sql: string) => { all: (...args: unknown[]) => Array<{ detail: string }> } } }).db;
    const plan = (sql: string, ...args: unknown[]) => raw.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args).map((row) => row.detail).join(' | ');
    const first = plan('SELECT * FROM node_bootstrap_operations WHERE active = 1 ORDER BY created_at DESC, id DESC LIMIT ?', 21);
    const later = plan(`SELECT * FROM node_bootstrap_operations WHERE active = 1 AND (created_at < ? OR (created_at = ? AND id < ?)) ORDER BY created_at DESC, id DESC LIMIT ?`, 1, 1, 'x', 21);
    for (const detail of [first, later]) {
      expect(detail).toContain('idx_node_bootstrap_ops_active_page');
      expect(detail).not.toContain('TEMP B-TREE');
    }
  });

  it('does not bring a released run back when a retry races the release', () => {
    const held = insertHeld(0);
    db.transitionNodeBootstrapOperation(held, ['partial'], { active: 0 }, Date.now());
    const states = ['blocked', 'failed', 'partial', 'cancelled', 'outcome_unknown', 'recovery_required'] as const;
    // The retry's compare-and-set arrives after the release: it must lose, not make the row hold its server again.
    expect(db.transitionNodeBootstrapOperation(held, states, { state: 'rechecking', active: 1 }, Date.now(), { stillActive: true })).toBe(false);
    expect(db.getNodeBootstrapOperation(held)).toMatchObject({ state: 'partial', active: 0 });
  });

  it('puts the finished history on the first page only and refuses a cursor that is not one of its own', () => {
    const h = harness();
    const ids = Array.from({ length: 22 }, (_, index) => insertHeld(200 + index));
    h.service.release(insertHeld(300, 'blocked'), AUDIT);
    const first = h.service.list();
    expect(first.operations.some((entry) => !entry.active)).toBe(true);
    const second = h.service.list(first.nextCursor);
    expect(second.operations.every((entry) => entry.active)).toBe(true);
    for (const cursor of ['', 'not-a-cursor', Buffer.from('{"a":1}').toString('base64url'), Buffer.from(JSON.stringify(['x', 'y'])).toString('base64url')]) {
      expect(() => h.service.list(cursor)).toThrow(expect.objectContaining({ status: 400, code: 'INVALID_CURSOR' }));
    }
    for (const id of ids) h.service.release(id, AUDIT);
  });

  it('caps the finished history, and the holds are paged on their own', () => {
    const h = harness();
    // Newer than anything an earlier test left behind, so the newest finished runs are this test's own.
    const base = Date.now() + 1_000_000;
    const held = insertHeld(40, 'partial', base + 40);
    const finished = Array.from({ length: 23 }, (_, index) => {
      const id = insertHeld(50 + index, 'blocked', base + 50 + index);
      h.service.release(id, AUDIT);
      return id;
    });
    const listed = h.service.list().operations;
    expect(listed.filter((entry) => !entry.active)).toHaveLength(20);
    expect(listed.map((entry) => entry.id)).toContain(held);
    // The newest finished runs are the ones kept.
    expect(listed.map((entry) => entry.id)).toContain(finished[22]);
    expect(listed.map((entry) => entry.id)).not.toContain(finished[0]);
    h.service.release(held, AUDIT);
  });
});

describe('bootstrap operations: B2 a failed read of the previous compose file records nothing of it', () => {
  it.each([
    ['the connection drops', { exitCode: null, error: 'CONNECTION_LOST' as const }],
    ['the read times out', { exitCode: null, timedOut: true }],
    ['the channel fails', { exitCode: null, error: 'COMMAND_ERROR' as const }],
    ['the read exits non-zero', { exitCode: 5 }],
  ])('keeps both credentials out of every event, response and audit row when %s', async (_label, failure) => {
    const h = harness({ connectOnStart: false, enrollWaitMs: 20 });
    const first = approve(h);
    const op = h.service.start(first.request, context());
    await h.service.settled();
    const nodeId = h.service.get(op.id).nodeId as number;
    const previousCompose = h.host.files.get('/opt/sencho-agent/compose.yaml')?.content ?? '';
    const previousToken = /SENCHO_ENROLL_TOKEN: "([^"]+)"/.exec(previousCompose)?.[1] ?? '';
    expect(previousToken).toMatch(/^eyJ/);

    h.facts.current = makeFacts({
      target: h.facts.current.target,
      hostKey: h.facts.current.hostKey,
      agentDir: {
        exists: true, isDirectory: true, realPath: '/opt/sencho-agent', writableByUser: true, readableByUser: true,
        entries: ['compose.yaml', 'sencho-bootstrap.json'], hasMarker: true, hasComposeFile: true,
        markerProject: 'sencho-agent', markerComposeDir: '/opt/docker/sencho', markerAgentDir: '/opt/sencho-agent',
      },
    });
    // The host sends the old file's content, then the read ends the way the case says.
    h.host.override = (command) => (command.includes("sencho-read '/opt/sencho-agent/compose.yaml'")
      ? { stdout: Buffer.from(previousCompose).toString('base64'), stderr: '', truncated: false, timedOut: false, error: null, ...failure }
      : undefined);
    const second = approve(h, op.id);
    h.service.retry(op.id, second.request, context());
    await h.service.settled();

    const detail = h.service.get(op.id);
    expect(detail.state).not.toBe('enrolled');
    const everything = JSON.stringify([detail, db.listNodeBootstrapEvents(op.id), auditText()]);
    const encodedOld = Buffer.from(previousCompose).toString('base64');
    const newToken = /enroll-\d+-\d+/.exec(everything)?.[0] ?? null;
    expect(everything).not.toContain(previousToken);
    expect(everything).not.toContain(encodedOld.slice(0, 60));
    expect(everything).not.toContain(Buffer.from(previousToken).toString('base64'));
    expect(newToken).toBeNull();
    if (h.service.get(op.id).active) h.service.release(op.id, AUDIT);
    db.deleteNode(nodeId);
  });
});
