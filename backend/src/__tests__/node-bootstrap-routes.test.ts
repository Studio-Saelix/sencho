import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { setupTestDb, cleanupTestDb, TEST_USERNAME, TEST_JWT_SECRET } from './helpers/setupTestDb';
import { DatabaseService } from '../services/DatabaseService';
import {
  BootstrapError,
  NodeBootstrapService,
  type BootstrapPreflightRequest,
} from '../services/nodeBootstrap/NodeBootstrapService';
import {
  SshTransportError,
  sshProbeClient,
  type BootstrapTransport,
  type SshCommand,
  type SshCommandResult,
} from '../services/nodeBootstrap/sshProbeClient';
import { DEFAULT_SOURCE_LOCATIONS, DOCKER_ASC_PATH, dockerAscBlock } from './__helpers__/dockerRepoFixtures';

/** Creates a manually controllable clock for testing time-dependent logic. */
function createManualClock(startMs: number): { now: () => number; advance: (ms: number) => void } {
  let current = startMs;
  return {
    now: () => current,
    advance: (ms: number) => { current += ms; },
  };
}

const PATH_COMPOSE_OUTPUT = [
  'P_INPUT=/opt/docker/sencho',
  'P_EXISTS=1',
  'P_ISDIR=1',
  'P_FINAL_LINK=0',
  'P_REAL=/opt/docker/sencho',
  'P_ANCESTOR_LINK=0',
  'P_OWNER=ubuntu',
  'P_GROUP=ubuntu',
  'P_MODE=755',
  'P_USER_R=1',
  'P_USER_W=1',
  'P_SUDO_R=1',
  'P_SUDO_W=1',
  'P_NEAREST=/opt/docker/sencho',
  'P_PARENT_W=1',
  'P_FSTYPE=ext4',
  'P_FSSOURCE=/dev/sda1',
  'P_FSTARGET=/',
  'P_DF=/dev/sda1 1 1 104857600 1% /',
].join('\n');

const PATH_AGENT_OUTPUT = [
  'P_INPUT=/opt/sencho-agent',
  'P_EXISTS=0',
  'P_ISDIR=0',
  'P_FINAL_LINK=0',
  'P_REAL=/opt/sencho-agent',
  'P_ANCESTOR_LINK=0',
  'P_NEAREST=/opt',
  'P_PARENT_W=1',
  'P_FSTYPE=ext4',
  'P_FSSOURCE=/dev/sda1',
  'P_FSTARGET=/',
  'P_DF=/dev/sda1 1 1 104857600 1% /',
].join('\n');

function probeOutputs(): Record<string, string> {
  return {
    os_release: 'ID=ubuntu\nVERSION_ID="24.04"\nVERSION_CODENAME=noble\nPRETTY_NAME="Ubuntu 24.04.1 LTS"',
    uname: 'x86_64\n6.8.0-45-generic',
    user: 'ubuntu\n1000\nubuntu',
    sudo: '',
    docker_cli: '/usr/bin/docker',
    docker_info: '27.3.1|/var/lib/docker',
    compose_version: '2.29.7',
    docker_service_active: 'active',
    docker_service_enabled: 'enabled',
    docker_repo: 'list\nkeyring',
    apt_policy: 'docker-ce:\n  Installed: 1\n  Candidate: 1',
    containers: '',
    agent_volume: '',
    clock: '1762300000',
    hub_health: '200',
    path_compose: PATH_COMPOSE_OUTPUT,
    path_agent: PATH_AGENT_OUTPUT,
    compose_inventory: '',
    agent_inventory: '',
    agent_marker: '',
    default_agent_path: 'no',
    docker_root_disk: 'D_SOURCE=daemon\nD_ROOT=/var/lib/docker\nD_DF=/dev/sda1 1 1 104857600 1% /',
    fstab: 'UUID=abc / ext4 defaults 0 1',
  };
}

class FakeTransport implements BootstrapTransport {
  public readonly commands: SshCommand[] = [];
  public hostKeyCalls = 0;
  public constructor(
    private readonly outputs: Record<string, string> = probeOutputs(),
    private readonly fingerprint = 'SHA256:fixturefingerprint000000000000000000000000',
    private readonly downAddresses: string[] = [],
  ) {}

  public async captureHostKey() {
    this.hostKeyCalls += 1;
    return {
      algorithm: 'ssh-ed25519',
      fingerprint: this.fingerprint,
      knownHostsLine: `server.example.com ssh-ed25519 AAAA`,
    };
  }

  public async runCommands(
    session: { address?: string },
    commands: SshCommand[],
    options?: { onHostKey?: (observation: { algorithm: string; fingerprint: string; knownHostsLine: string }) => void },
  ): Promise<SshCommandResult[]> {
    if (session.address && this.downAddresses.includes(session.address)) {
      throw new SshTransportError('SSH_UNREACHABLE', 'fixture address down');
    }
    this.commands.push(...commands);
    options?.onHostKey?.({
      algorithm: 'ssh-ed25519',
      fingerprint: this.fingerprint,
      knownHostsLine: 'server.example.com ssh-ed25519 AAAA',
    });
    return commands.map((command) => ({
      id: command.id,
      stdout: this.outputs[command.id] ?? '',
      stderr: '',
      exitCode: 0,
      truncated: false,
      timedOut: false,
      error: null,
    }));
  }
}

let tmpDir: string;
let app: import('express').Express;
let adminAuth: string;
let viewerAuth: string;
let machineAuth: string;

function adminToken(): string {
  return `Bearer ${jwt.sign({ username: TEST_USERNAME }, TEST_JWT_SECRET, { expiresIn: '1m' })}`;
}

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ app } = await import('../index'));
  const db = DatabaseService.getInstance();
  db.addUser({ username: 'bootstrap-viewer', password_hash: 'x', role: 'viewer' });
  adminAuth = adminToken();
  viewerAuth = `Bearer ${jwt.sign({ username: 'bootstrap-viewer' }, TEST_JWT_SECRET, { expiresIn: '1m' })}`;
  machineAuth = `Bearer ${jwt.sign({ scope: 'node_proxy' }, TEST_JWT_SECRET, { expiresIn: '1m' })}`;
});

afterAll(() => cleanupTestDb(tmpDir));

afterEach(() => {
  vi.restoreAllMocks();
});

describe('bootstrap routes: authorization', () => {
  it('requires authentication', async () => {
    const res = await request(app).get('/api/nodes/bootstrap/capabilities');
    expect(res.status).toBe(401);
  });

  it('rejects a non-admin session and a machine credential', async () => {
    const viewer = await request(app).get('/api/nodes/bootstrap/capabilities').set('Authorization', viewerAuth);
    expect(viewer.status).toBe(403);
    expect(viewer.body.code).toBe('ADMIN_REQUIRED');

    const machine = await request(app).get('/api/nodes/bootstrap/capabilities').set('Authorization', machineAuth);
    expect(machine.status).toBe(403);
    expect(machine.body.code).toBe('SESSION_REQUIRED');
  });

  it('returns the capabilities document to an admin', async () => {
    const res = await request(app).get('/api/nodes/bootstrap/capabilities').set('Authorization', adminAuth);
    expect(res.status).toBe(200);
    expect(res.body.defaults).toEqual({ composeDir: '/opt/docker/sencho', agentDir: '/opt/sencho-agent' });
    expect(res.body.fixed).toMatchObject({ projectName: 'sencho-agent', dataVolume: 'sencho-agent-data' });
    expect(res.body.pathPolicy.reservedPrefixes).toContain('/etc');
  });

  it('serves locally even when a remote node is named', async () => {
    const db = DatabaseService.getInstance();
    const remoteId = db.addNode({
      name: 'bootstrap-remote',
      type: 'remote',
      compose_dir: '/app/compose',
      is_default: false,
      api_url: 'http://192.168.1.90:1852',
      api_token: 'tok',
      mode: 'proxy',
    } as Parameters<typeof db.addNode>[0]);
    const res = await request(app)
      .get('/api/nodes/bootstrap/capabilities')
      .set('Authorization', adminAuth)
      .set('x-node-id', String(remoteId));
    expect(res.status).toBe(403);
  });
});

describe('bootstrap routes: host key', () => {
  it('validates the host before dialing', async () => {
    const res = await request(app)
      .post('/api/nodes/bootstrap/host-key')
      .set('Authorization', adminAuth)
      .send({ host: 'bad host name' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_TARGET');
    expect(res.body.field).toBe('host');
  });

  it('returns the fingerprint and trust state', async () => {
    vi.spyOn(NodeBootstrapService.getInstance(), 'captureHostKey').mockResolvedValue({
      host: 'server.example.com',
      port: 22,
      address: '192.168.1.50',
      algorithm: 'ssh-ed25519',
      fingerprint: 'SHA256:abc',
      knownHostsLine: 'server.example.com ssh-ed25519 AAAA',
      trust: 'unknown',
      pinnedFingerprint: null,
    });
    const res = await request(app)
      .post('/api/nodes/bootstrap/host-key')
      .set('Authorization', adminAuth)
      .send({ host: 'server.example.com' });
    expect(res.status).toBe(200);
    expect(res.body.fingerprint).toBe('SHA256:abc');
    expect(res.body.trust).toBe('unknown');
  });
});

describe('bootstrap routes: the hub as a target in a Docker or NAT deployment', () => {
  const PUBLIC_IP = '8.8.4.4';
  const preflightBody = {
    host: PUBLIC_IP,
    username: 'ubuntu',
    privateKey: 'key',
    targetName: 'self',
    expectedFingerprint: 'SHA256:x',
  };

  beforeEach(() => {
    // Inside a container the only non-loopback interface is the bridge.
    vi.spyOn(os, 'networkInterfaces').mockReturnValue({
      eth0: [{ address: '172.17.0.2', netmask: '255.255.0.0', family: 'IPv4', mac: '00:00:00:00:00:00', internal: false, cidr: '172.17.0.2/16' }],
    });
  });

  afterEach(() => {
    delete process.env.SENCHO_PUBLIC_URL;
  });

  it('refuses the address the operator reached the hub on, for the host key check and the preflight', async () => {
    const captureSpy = vi.spyOn(sshProbeClient, 'captureHostKey');
    const runSpy = vi.spyOn(sshProbeClient, 'runCommands');
    const hostKey = await request(app)
      .post('/api/nodes/bootstrap/host-key')
      .set('Authorization', adminAuth)
      .set('Host', `${PUBLIC_IP}:1852`)
      .send({ host: PUBLIC_IP });
    expect(hostKey.status).toBe(400);
    expect(hostKey.body.code).toBe('INVALID_TARGET');
    const preflight = await request(app)
      .post('/api/nodes/bootstrap/preflight')
      .set('Authorization', adminAuth)
      .set('Host', `${PUBLIC_IP}:1852`)
      .send(preflightBody);
    expect(preflight.status).toBe(400);
    expect(preflight.body.code).toBe('INVALID_TARGET');
    expect(captureSpy).not.toHaveBeenCalled();
    expect(runSpy).not.toHaveBeenCalled();
  });

  it('refuses the address in SENCHO_PUBLIC_URL when the request arrives on another host', async () => {
    process.env.SENCHO_PUBLIC_URL = `https://${PUBLIC_IP}`;
    const captureSpy = vi.spyOn(sshProbeClient, 'captureHostKey');
    const res = await request(app)
      .post('/api/nodes/bootstrap/host-key')
      .set('Authorization', adminAuth)
      .set('Host', 'localhost:1852')
      .send({ host: PUBLIC_IP });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_TARGET');
    expect(captureSpy).not.toHaveBeenCalled();
  });

  it('does not refuse an unrelated target in the preflight either', async () => {
    const runSpy = vi.spyOn(sshProbeClient, 'runCommands').mockRejectedValue(new SshTransportError('SSH_UNREACHABLE', 'fixture target down'));
    const res = await request(app)
      .post('/api/nodes/bootstrap/preflight')
      .set('Authorization', adminAuth)
      .set('Host', `${PUBLIC_IP}:1852`)
      .send({ ...preflightBody, host: '8.8.8.8' });
    // Past the own-address guard the fixture transport is reached and fails.
    expect(res.body.code).toBe('SSH_UNREACHABLE');
    expect(runSpy).toHaveBeenCalled();
  });

  it('does not refuse an unrelated target', async () => {
    const captureSpy = vi.spyOn(sshProbeClient, 'captureHostKey').mockResolvedValue({
      algorithm: 'ssh-ed25519', fingerprint: 'SHA256:other', knownHostsLine: '8.8.8.8 ssh-ed25519 AAAA',
    });
    const res = await request(app)
      .post('/api/nodes/bootstrap/host-key')
      .set('Authorization', adminAuth)
      .set('Host', `${PUBLIC_IP}:1852`)
      .send({ host: '8.8.8.8' });
    expect(res.status).toBe(200);
    expect(captureSpy).toHaveBeenCalledTimes(1);
  });
});

describe('bootstrap routes: preflight', () => {
  it('rejects an unsafe path with the field that owns it', async () => {
    const service = NodeBootstrapService.getInstance();
    const spy = vi.spyOn(service, 'preflight');
    const res = await request(app)
      .post('/api/nodes/bootstrap/preflight')
      .set('Authorization', adminAuth)
      .send({
        host: 'server.example.com',
        username: 'ubuntu',
        privateKey: 'key',
        targetName: 'media-server',
        composeDir: '/etc/stacks',
        agentDir: '/opt/sencho-agent',
      });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_PATH');
    expect(res.body.field).toBe('composeDir');
    expect(spy).not.toHaveBeenCalled();
  });

  it.each([
    ['only the new key', { replacePinnedFingerprint: 'SHA256:new' }],
    ['only the reviewed pin', { reviewedPinnedFingerprint: 'SHA256:old' }],
  ])('rejects a replacement that sends %s', async (_label, half) => {
    const spy = vi.spyOn(NodeBootstrapService.getInstance(), 'preflight');
    const res = await request(app)
      .post('/api/nodes/bootstrap/preflight')
      .set('Authorization', adminAuth)
      .send({
        host: 'server.example.com',
        username: 'ubuntu',
        privateKey: 'key',
        targetName: 'media-server',
        expectedFingerprint: 'SHA256:new',
        ...half,
      });
    expect(res.status).toBe(400);
    expect(spy).not.toHaveBeenCalled();
  });

  it('rejects nested directories', async () => {
    const res = await request(app)
      .post('/api/nodes/bootstrap/preflight')
      .set('Authorization', adminAuth)
      .send({
        host: 'server.example.com',
        username: 'ubuntu',
        privateKey: 'key',
        targetName: 'media-server',
        composeDir: '/opt/docker/sencho',
        agentDir: '/opt/docker/sencho/agent',
      });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_PATH');
    expect(res.body.field).toBe('agentDir');
  });

  it('maps host-key and in-progress conflicts to 409 with their codes', async () => {
    const spy = vi.spyOn(NodeBootstrapService.getInstance(), 'preflight');
    spy.mockRejectedValueOnce(new BootstrapError(409, 'HOST_KEY_MISMATCH', 'changed', {
      details: { pinnedFingerprint: 'SHA256:old', expectedFingerprint: 'SHA256:new' },
    }));
    const mismatch = await request(app)
      .post('/api/nodes/bootstrap/preflight')
      .set('Authorization', adminAuth)
      .send({ host: 'server.example.com', username: 'ubuntu', privateKey: 'key', targetName: 'media-server' });
    expect(mismatch.status).toBe(409);
    expect(mismatch.body.code).toBe('HOST_KEY_MISMATCH');
    expect(mismatch.body.pinnedFingerprint).toBe('SHA256:old');

    spy.mockRejectedValueOnce(new BootstrapError(409, 'BOOTSTRAP_IN_PROGRESS', 'running'));
    const inProgress = await request(app)
      .post('/api/nodes/bootstrap/preflight')
      .set('Authorization', adminAuth)
      .send({ host: 'server.example.com', username: 'ubuntu', privateKey: 'key', targetName: 'media-server' });
    expect(inProgress.status).toBe(409);
    expect(inProgress.body.code).toBe('BOOTSTRAP_IN_PROGRESS');
  });

  it('returns a blocked inspection with no plan at 200', async () => {
    vi.spyOn(NodeBootstrapService.getInstance(), 'preflight').mockResolvedValue({
      inspection: {
        observedAt: Date.now(),
        target: { host: 'server.example.com', port: 22, username: 'ubuntu', address: '192.168.1.50' },
        hostKey: { algorithm: 'ssh-ed25519', fingerprint: 'SHA256:abc', knownHostsLine: 'line' },
        paths: {} as never,
        agent: { projectContainers: [], dataVolumeExists: false, dataVolumeNames: [], defaultDirHasComposeFile: false, defaultDirRealPath: null },
        dockerRoot: { path: '/var/lib/docker', freeBytes: 1, filesystemType: 'ext4' },
        checks: [{
          id: 'agent_dir',
          category: 'paths',
          label: 'Pilot Agent installation directory',
          status: 'blocked',
          summary: 'not empty',
          remediation: 'choose an empty directory',
        }],
        blockers: 1,
        warnings: 0,
      },
      plan: null,
      blocked: true,
    });
    const res = await request(app)
      .post('/api/nodes/bootstrap/preflight')
      .set('Authorization', adminAuth)
      .send({ host: 'server.example.com', username: 'ubuntu', privateKey: 'key', targetName: 'media-server' });
    expect(res.status).toBe(200);
    expect(res.body.blocked).toBe(true);
    expect(res.body.plan).toBeNull();
  });

  it('applies the defaults when the directory fields are omitted', async () => {
    const spy = vi.spyOn(NodeBootstrapService.getInstance(), 'preflight').mockResolvedValue({
      inspection: {
        observedAt: Date.now(),
        target: { host: 'server.example.com', port: 22, username: 'ubuntu', address: '192.168.1.50' },
        hostKey: { algorithm: 'ssh-ed25519', fingerprint: 'SHA256:abc', knownHostsLine: 'line' },
        paths: {} as never,
        agent: { projectContainers: [], dataVolumeExists: false, dataVolumeNames: [], defaultDirHasComposeFile: false, defaultDirRealPath: null },
        dockerRoot: { path: null, freeBytes: null, filesystemType: null },
        checks: [],
        blockers: 0,
        warnings: 0,
      },
      plan: null,
      blocked: false,
    });
    await request(app)
      .post('/api/nodes/bootstrap/preflight')
      .set('Authorization', adminAuth)
      .send({ host: 'server.example.com', username: 'ubuntu', privateKey: 'key', targetName: 'media-server' });
    expect(spy).toHaveBeenCalledTimes(1);
    const [requestArg, contextArg] = spy.mock.calls[0];
    expect(requestArg.host).toBe('server.example.com');
    expect(requestArg.composeDir).toBeUndefined();
    expect(requestArg.agentDir).toBeUndefined();
    expect(contextArg.hubUrl).toEqual(expect.any(String));
  });

  it('forwards the reviewed pin with the replacement confirmation instead of stripping it', async () => {
    const spy = vi.spyOn(NodeBootstrapService.getInstance(), 'preflight').mockRejectedValue(
      new BootstrapError(409, 'HOST_KEY_MISMATCH', 'mismatch', { details: { pinnedFingerprint: 'SHA256:current' } }),
    );
    const res = await request(app)
      .post('/api/nodes/bootstrap/preflight')
      .set('Authorization', adminAuth)
      .send({
        host: 'server.example.com',
        username: 'ubuntu',
        privateKey: 'key',
        targetName: 'media-server',
        expectedFingerprint: 'SHA256:live',
        replacePinnedFingerprint: 'SHA256:live',
        reviewedPinnedFingerprint: 'SHA256:reviewed',
      });
    expect(spy.mock.calls[0][0]).toMatchObject({
      expectedFingerprint: 'SHA256:live',
      replacePinnedFingerprint: 'SHA256:live',
      reviewedPinnedFingerprint: 'SHA256:reviewed',
    });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'HOST_KEY_MISMATCH', pinnedFingerprint: 'SHA256:current' });
  });
});

describe('bootstrap service orchestration', () => {
  function service(transport: FakeTransport) {
    return new NodeBootstrapService({
      transport,
      db: DatabaseService.getInstance(),
      now: () => 1_762_300_000_000,
      resolveAddresses: async () => ['192.168.1.50'],
      caPem: () => null,
    });
  }

  const request: BootstrapPreflightRequest = {
    host: 'server.example.com',
    port: 22,
    username: 'ubuntu',
    privateKey: '-----BEGIN OPENSSH PRIVATE KEY-----\nnot-a-real-key\n-----END OPENSSH PRIVATE KEY-----',
    expectedFingerprint: 'SHA256:fixturefingerprint000000000000000000000000',
    targetName: 'media-server',
    composeDir: '/opt/docker/sencho',
    agentDir: '/opt/sencho-agent',
  };

  const audit = { username: 'admin', ip: '127.0.0.1', method: 'POST', path: '/api/nodes/bootstrap/preflight' };

  it('pins the key once, returns a plan and writes an audit row with both paths', async () => {
    const transport = new FakeTransport();
    const result = await service(transport).preflight(request, { hubUrl: 'https://sencho.example.com', audit });
    expect(result.blocked).toBe(false);
    expect(result.plan?.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(transport.commands.length).toBeGreaterThan(20);

    const db = DatabaseService.getInstance();
    expect(db.getNodeBootstrapTrust('server.example.com', 22)?.fingerprint).toBe(request.expectedFingerprint);
    const { entries } = db.getAuditLogs({ search: 'bootstrap.preflight', limit: 20 });
    const row = entries.find((entry) => entry.summary.includes('bootstrap.preflight'));
    expect(row).toBeDefined();
    expect(row?.summary).toContain('composeDir=/opt/docker/sencho');
    expect(row?.summary).toContain('agentDir=/opt/sencho-agent');
    expect(row?.summary).toContain('digest=');
    expect(row?.summary).not.toContain('not-a-real-key');
  });

  it('rejects a preflight when the pinned key differs and no replacement was confirmed', async () => {
    const db = DatabaseService.getInstance();
    db.upsertNodeBootstrapTrust({
      host: 'pinned.example.com',
      port: 22,
      fingerprint: 'SHA256:pinned',
      algorithm: 'ssh-ed25519',
      approved_by: 'admin',
      approved_at: 1,
      last_seen_at: 1,
    });
    const transport = new FakeTransport();
    await expect(service(transport).preflight(
      { ...request, host: 'pinned.example.com', expectedFingerprint: 'SHA256:other' },
      { hubUrl: 'https://sencho.example.com', audit },
    )).rejects.toMatchObject({ code: 'HOST_KEY_MISMATCH' });
    expect(transport.commands).toHaveLength(0);
  });

  it('replaces a pin only when the replacement fingerprint is confirmed', async () => {
    const db = DatabaseService.getInstance();
    db.upsertNodeBootstrapTrust({
      host: 'replace.example.com',
      port: 22,
      fingerprint: 'SHA256:pinned',
      algorithm: 'ssh-ed25519',
      approved_by: 'admin',
      approved_at: 1,
      last_seen_at: 1,
    });
    const transport = new FakeTransport();
    const result = await service(transport).preflight(
      {
        ...request,
        host: 'replace.example.com',
        expectedFingerprint: 'SHA256:fixturefingerprint000000000000000000000000',
        replacePinnedFingerprint: 'SHA256:fixturefingerprint000000000000000000000000',
        reviewedPinnedFingerprint: 'SHA256:pinned',
      },
      { hubUrl: 'https://sencho.example.com', audit },
    );
    expect(result.blocked).toBe(false);
    expect(db.getNodeBootstrapTrust('replace.example.com', 22)?.fingerprint).toBe('SHA256:fixturefingerprint000000000000000000000000');
  });

  it('refuses a replacement that does not name the pin the operator reviewed', async () => {
    const db = DatabaseService.getInstance();
    const host = 'unreviewed.example.com';
    db.upsertNodeBootstrapTrust({
      host, port: 22, fingerprint: 'SHA256:pinned', algorithm: 'ssh-ed25519', approved_by: 'admin', approved_at: 1, last_seen_at: 1,
    });
    const transport = new FakeTransport();
    await expect(service(transport).preflight(
      {
        ...request,
        host,
        expectedFingerprint: 'SHA256:fixturefingerprint000000000000000000000000',
        replacePinnedFingerprint: 'SHA256:fixturefingerprint000000000000000000000000',
      },
      { hubUrl: 'https://sencho.example.com', audit },
    )).rejects.toMatchObject({ code: 'HOST_KEY_MISMATCH' });
    expect(transport.commands).toHaveLength(0);
    expect(db.getNodeBootstrapTrust(host, 22)?.fingerprint).toBe('SHA256:pinned');
  });

  it('does not fall through to a second address when one host key is rejected', async () => {
    const attempts: string[] = [];
    const transport: BootstrapTransport = {
      captureHostKey: async ({ address }) => {
        attempts.push(address);
        if (address === '10.0.0.1') throw new SshTransportError('HOST_KEY_UNTRUSTED', 'changed');
        return {
          algorithm: 'ssh-ed25519',
          fingerprint: 'SHA256:other',
          knownHostsLine: 'server.example.com ssh-ed25519 AAAA',
        };
      },
      runCommands: vi.fn(async () => []),
    };
    const svc = new NodeBootstrapService({
      transport,
      db: DatabaseService.getInstance(),
      now: () => 1_762_300_000_000,
      resolveAddresses: async () => ['10.0.0.1', '10.0.0.2'],
      caPem: () => null,
    });
    await expect(svc.captureHostKey({ host: 'multi.example.com', port: 22 }))
      .rejects.toMatchObject({ code: 'HOST_KEY_UNTRUSTED' });
    expect(attempts).toEqual(['10.0.0.1']);
  });

  it('records the address that actually answered', async () => {
    const transport = new FakeTransport(probeOutputs(), 'SHA256:fixturefingerprint000000000000000000000000', ['10.0.0.1']);
    const svc = new NodeBootstrapService({
      transport,
      db: DatabaseService.getInstance(),
      now: () => 1_762_300_000_000,
      resolveAddresses: async () => ['10.0.0.1', '10.0.0.2'],
      caPem: () => null,
    });
    const result = await svc.preflight(
      { ...request, host: 'multi.example.com' },
      { hubUrl: 'https://sencho.example.com', audit },
    );
    expect(result.inspection.target.address).toBe('10.0.0.2');
  });

  it('refuses a hub URL that carries credentials before dialing', async () => {
    const transport = new FakeTransport();
    await expect(service(transport).preflight(request, {
      hubUrl: 'https://user:secret@sencho.example.com',
      audit,
    })).rejects.toMatchObject({ code: 'INVALID_TARGET' });
    expect(transport.commands).toHaveLength(0);
  });

  it('writes a 409 audit row for a host key mismatch', async () => {
    const db = DatabaseService.getInstance();
    db.upsertNodeBootstrapTrust({
      host: 'audit-mismatch.example.com',
      port: 22,
      fingerprint: 'SHA256:pinned',
      algorithm: 'ssh-ed25519',
      approved_by: 'admin',
      approved_at: 1,
      last_seen_at: 1,
    });
    const transport = new FakeTransport();
    await expect(service(transport).preflight(
      { ...request, host: 'audit-mismatch.example.com', expectedFingerprint: 'SHA256:other' },
      { hubUrl: 'https://sencho.example.com', audit },
    )).rejects.toMatchObject({ code: 'HOST_KEY_MISMATCH' });
    const { entries } = db.getAuditLogs({ search: 'bootstrap.trust.mismatch', limit: 50 });
    const row = entries.find((entry) => entry.summary.split(' ').includes('host=audit-mismatch.example.com'));
    expect(row?.status_code).toBe(409);
  });

  it('returns a blocked inspection and no plan for a non-empty agent directory', async () => {
    const existingAgentPath = [
      'P_INPUT=/opt/sencho-agent',
      'P_EXISTS=1',
      'P_ISDIR=1',
      'P_FINAL_LINK=0',
      'P_REAL=/opt/sencho-agent',
      'P_ANCESTOR_LINK=0',
      'P_OWNER=ubuntu',
      'P_GROUP=ubuntu',
      'P_MODE=700',
      'P_USER_R=1',
      'P_USER_W=1',
      'P_NEAREST=/opt/sencho-agent',
      'P_PARENT_W=1',
      'P_FSTYPE=ext4',
      'P_FSSOURCE=/dev/sda1',
      'P_FSTARGET=/',
      'P_DF=/dev/sda1 1 1 104857600 1% /',
    ].join('\n');
    const transport = new FakeTransport({
      ...probeOutputs(),
      path_agent: existingAgentPath,
      agent_inventory: 'notes.txt\0',
    });
    const result = await service(transport).preflight(request, { hubUrl: 'https://sencho.example.com', audit });
    expect(result.blocked).toBe(true);
    expect(result.plan).toBeNull();
    const agentCheck = result.inspection.checks.find((entry) => entry.id === 'agent_dir');
    expect(agentCheck?.status).toBe('blocked');
    expect(agentCheck && 'remediation' in agentCheck ? agentCheck.remediation : null).toBeTruthy();
  });

  it('never surfaces the private key in the response, plan or audit row', async () => {
    const transport = new FakeTransport();
    const result = await service(transport).preflight(request, { hubUrl: 'https://sencho.example.com', audit });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('not-a-real-key');
    expect(serialized).not.toContain(request.privateKey);
  });
});

describe('bootstrap service trust serialization', () => {
  const audit = { username: 'admin', ip: '127.0.0.1', method: 'POST', path: '/api/nodes/bootstrap/preflight' };
  const baseRequest: BootstrapPreflightRequest = {
    host: 'race.example.com',
    port: 22,
    username: 'ubuntu',
    privateKey: '-----BEGIN OPENSSH PRIVATE KEY-----\nnot-a-real-key\n-----END OPENSSH PRIVATE KEY-----',
    expectedFingerprint: 'SHA256:fixturefingerprint000000000000000000000000',
    targetName: 'race-server',
    composeDir: '/opt/docker/sencho',
    agentDir: '/opt/sencho-agent',
  };

  it('serializes pin validation with DNS and the probe run', async () => {
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    const resolver = async (): Promise<string[]> => {
      calls += 1;
      if (calls === 1) await gate;
      return ['192.168.1.50'];
    };
    const svc = new NodeBootstrapService({
      transport: new FakeTransport(),
      db: DatabaseService.getInstance(),
      now: () => 1_762_300_000_000,
      resolveAddresses: resolver,
      caPem: () => null,
    });

    const first = svc.preflight(
      { ...baseRequest, expectedFingerprint: 'SHA256:fixturefingerprint000000000000000000000000' },
      { hubUrl: 'https://sencho.example.com', audit },
    );
    await new Promise((resolve) => setImmediate(resolve));
    await expect(svc.preflight(
      { ...baseRequest, expectedFingerprint: 'SHA256:secondfingerprint00000000000000000000000000' },
      { hubUrl: 'https://sencho.example.com', audit },
    )).rejects.toMatchObject({ code: 'BOOTSTRAP_IN_PROGRESS' });

    release!();
    await first;
    const db = DatabaseService.getInstance();
    expect(db.getNodeBootstrapTrust('race.example.com', 22)?.fingerprint)
      .toBe('SHA256:fixturefingerprint000000000000000000000000');

    // The first pin is preserved: the second request never observed an empty
    // store and cannot replace it without an explicit replacement confirmation.
    await expect(svc.preflight(
      { ...baseRequest, expectedFingerprint: 'SHA256:secondfingerprint00000000000000000000000000' },
      { hubUrl: 'https://sencho.example.com', audit },
    )).rejects.toMatchObject({ code: 'HOST_KEY_MISMATCH' });
    expect(db.getNodeBootstrapTrust('race.example.com', 22)?.fingerprint)
      .toBe('SHA256:fixturefingerprint000000000000000000000000');
  });

  it('refuses to overwrite a pin that changed while the probe was running', async () => {
    const db = DatabaseService.getInstance();
    const host = 'cas.example.com';
    const observed = 'SHA256:observed000000000000000000000000000000000';
    const interposed = 'SHA256:interposed000000000000000000000000000000';
    const transport: BootstrapTransport = {
      captureHostKey: async () => ({
        algorithm: 'ssh-ed25519',
        fingerprint: observed,
        knownHostsLine: 'line',
      }),
      runCommands: async (session, commands, options) => {
        options?.onHostKey?.({
          algorithm: 'ssh-ed25519',
          fingerprint: observed,
          knownHostsLine: `${host} ssh-ed25519 AAAA`,
        });
        db.upsertNodeBootstrapTrust({
          host,
          port: 22,
          fingerprint: interposed,
          algorithm: 'ssh-ed25519',
          approved_by: 'other',
          approved_at: 1,
          last_seen_at: 1,
        });
        return commands.map((command) => ({
          id: command.id,
          stdout: '',
          stderr: '',
          exitCode: 0,
          truncated: false,
          timedOut: false,
          error: null,
        }));
      },
    };
    const svc = new NodeBootstrapService({
      transport,
      db,
      now: () => 1_762_300_000_000,
      resolveAddresses: async () => ['192.168.1.50'],
      caPem: () => null,
    });

    await expect(svc.preflight(
      { ...baseRequest, host, expectedFingerprint: observed },
      { hubUrl: 'https://sencho.example.com', audit },
    )).rejects.toMatchObject({ code: 'HOST_KEY_MISMATCH' });
    expect(db.getNodeBootstrapTrust(host, 22)?.fingerprint).toBe(interposed);
    const { entries } = db.getAuditLogs({ search: 'bootstrap.trust.mismatch', limit: 50 });
    expect(entries.some((entry) => entry.summary.includes(`observed=${observed}`))).toBe(true);
  });

  it('records an explicit live mismatch audit with the pinned and observed keys', async () => {
    const db = DatabaseService.getInstance();
    const host = 'live-mismatch.example.com';
    const pinned = 'SHA256:pinnedfingerprint000000000000000000000000';
    const observed = 'SHA256:livefingerprint00000000000000000000000000';
    db.upsertNodeBootstrapTrust({
      host,
      port: 22,
      fingerprint: pinned,
      algorithm: 'ssh-ed25519',
      approved_by: 'admin',
      approved_at: 1,
      last_seen_at: 1,
    });
    let executed = 0;
    const transport: BootstrapTransport = {
      captureHostKey: async () => ({ algorithm: 'ssh-ed25519', fingerprint: pinned, knownHostsLine: 'line' }),
      runCommands: async (session, _commands, options) => {
        executed += 1;
        options?.onHostKey?.({
          algorithm: 'ssh-ed25519',
          fingerprint: observed,
          knownHostsLine: `${host} ssh-ed25519 AAAA`,
        });
        throw new SshTransportError('HOST_KEY_UNTRUSTED', 'The host key changed before the preflight connected.');
      },
    };
    const svc = new NodeBootstrapService({
      transport,
      db,
      now: () => 1_762_300_000_000,
      resolveAddresses: async () => ['192.168.1.50'],
      caPem: () => null,
    });

    await expect(svc.preflight(
      { ...baseRequest, host, expectedFingerprint: pinned },
      { hubUrl: 'https://sencho.example.com', audit },
    )).rejects.toMatchObject({
      code: 'HOST_KEY_UNTRUSTED',
      details: { pinnedFingerprint: pinned, expectedFingerprint: pinned, observedFingerprint: observed },
    });
    expect(executed).toBe(1);
    expect(db.getNodeBootstrapTrust(host, 22)?.fingerprint).toBe(pinned);
    const { entries } = db.getAuditLogs({ search: 'bootstrap.trust.mismatch', limit: 50 });
    const row = entries.find((entry) => entry.summary.includes(`host=${host}`));
    expect(row?.summary).toContain(`pinned=${pinned}`);
    expect(row?.summary).toContain(`expected=${pinned}`);
    expect(row?.summary).toContain(`observed=${observed}`);
    expect(row?.status_code).toBe(409);
  });

  it('fails a request whose DNS does not answer inside the request budget', async () => {
    const svc = new NodeBootstrapService({
      transport: new FakeTransport(),
      db: DatabaseService.getInstance(),
      now: () => 1_762_300_000_000,
      resolveAddresses: async () => {
        await new Promise((resolve) => setTimeout(resolve, 500));
        return ['192.168.1.50'];
      },
      caPem: () => null,
      requestBudgetMs: 40,
    });
    const started = Date.now();
    await expect(svc.preflight(
      { ...baseRequest, host: 'slow-dns.example.com' },
      { hubUrl: 'https://sencho.example.com', audit },
    )).rejects.toMatchObject({ code: 'PREFLIGHT_TIMEOUT' });
    expect(Date.now() - started).toBeLessThan(400);
  });

  it('gives each address attempt only the remaining request budget', async () => {
    const seenTotals: number[] = [];
    const transport: BootstrapTransport = {
      captureHostKey: async () => ({ algorithm: 'ssh-ed25519', fingerprint: 'SHA256:x', knownHostsLine: 'line' }),
      runCommands: async (session, commands, options) => {
        seenTotals.push(options?.totalMs ?? -1);
        options?.onHostKey?.({ algorithm: 'ssh-ed25519', fingerprint: 'SHA256:fixturefingerprint000000000000000000000000', knownHostsLine: 'line' });
        if (session.address === '192.168.1.10') {
          clock.advance(40);
          throw new SshTransportError('SSH_UNREACHABLE', 'first address down');
        }
        return commands.map((command) => ({
          id: command.id, stdout: '', stderr: '', exitCode: 0, truncated: false, timedOut: false, error: null,
        }));
      },
    };
    const clock = createManualClock(1_762_300_000_000);
    const svc = new NodeBootstrapService({
      transport,
      db: DatabaseService.getInstance(),
      now: clock.now,
      resolveAddresses: async () => ['192.168.1.10', '192.168.1.20'],
      caPem: () => null,
      requestBudgetMs: 300,
    });
    await svc.preflight(
      { ...baseRequest, host: 'fallback.example.com' },
      { hubUrl: 'https://sencho.example.com', audit },
    );
    expect(seenTotals).toHaveLength(2);
    expect(seenTotals[0]).toBeLessThanOrEqual(300);
    expect(seenTotals[1]).toBeLessThan(seenTotals[0]);
    expect(seenTotals[1]).toBeGreaterThan(0);
  });

  it('releases the target lock after a bounded transport timeout', async () => {
    let timedOut = true;
    const transport: BootstrapTransport = {
      captureHostKey: async () => ({ algorithm: 'ssh-ed25519', fingerprint: 'SHA256:t', knownHostsLine: 'line' }),
      runCommands: async (session, commands, options) => {
        options?.onHostKey?.({ algorithm: 'ssh-ed25519', fingerprint: 'SHA256:t', knownHostsLine: 'line' });
        if (timedOut) {
          return commands.map((command) => ({
            id: command.id, stdout: '', stderr: '', exitCode: null, truncated: false, timedOut: true, error: 'PREFLIGHT_TIMEOUT',
          }));
        }
        return commands.map((command) => ({
          id: command.id, stdout: '', stderr: '', exitCode: 0, truncated: false, timedOut: false, error: null,
        }));
      },
    };
    const svc = new NodeBootstrapService({
      transport,
      db: DatabaseService.getInstance(),
      now: () => 1_762_300_000_000,
      resolveAddresses: async () => ['192.168.1.50'],
      caPem: () => null,
    });
    const host = 'timeout-lock.example.com';
    await expect(svc.preflight(
      { ...baseRequest, host, expectedFingerprint: 'SHA256:t' },
      { hubUrl: 'https://sencho.example.com', audit },
    )).rejects.toMatchObject({ code: 'PREFLIGHT_TIMEOUT' });

    timedOut = false;
    await expect(svc.preflight(
      { ...baseRequest, host, expectedFingerprint: 'SHA256:t' },
      { hubUrl: 'https://sencho.example.com', audit },
    )).resolves.toBeDefined();
  });

  it('rejects a blocked address before invoking the transport from either entry point', async () => {
    const transport: BootstrapTransport = {
      captureHostKey: vi.fn(async () => ({ algorithm: 'ssh-ed25519', fingerprint: 'SHA256:x', knownHostsLine: 'line' })),
      runCommands: vi.fn(async () => []),
    };
    const { resolveTargetAddresses } = await import('../services/nodeBootstrap/targetPolicy');
    const svc = new NodeBootstrapService({
      transport,
      db: DatabaseService.getInstance(),
      now: () => 1_762_300_000_000,
      resolveAddresses: (host) => resolveTargetAddresses(host, async () => [{ address: '127.0.0.1', family: 4 }]),
      caPem: () => null,
    });
    await expect(svc.captureHostKey({ host: 'blocked.example.com' }))
      .rejects.toMatchObject({ code: 'INVALID_TARGET' });
    await expect(svc.preflight(
      { ...baseRequest, host: 'blocked.example.com', expectedFingerprint: 'SHA256:x' },
      { hubUrl: 'https://sencho.example.com', audit },
    )).rejects.toMatchObject({ code: 'INVALID_TARGET' });
    expect(transport.captureHostKey).not.toHaveBeenCalled();
    expect(transport.runCommands).not.toHaveBeenCalled();
  });
});

describe('bootstrap service failure handling', () => {
  const audit = { username: 'admin', ip: '127.0.0.1', method: 'POST', path: '/api/nodes/bootstrap/preflight' };
  const hub = 'https://sencho.example.com';
  const key = '-----BEGIN OPENSSH PRIVATE KEY-----\nnot-a-real-key\n-----END OPENSSH PRIVATE KEY-----';
  const base = (host: string, extra: Partial<BootstrapPreflightRequest> = {}): BootstrapPreflightRequest => ({
    host,
    port: 22,
    username: 'ubuntu',
    privateKey: key,
    expectedFingerprint: 'SHA256:fixturefingerprint000000000000000000000000',
    targetName: 'failure-server',
    composeDir: '/opt/docker/sencho',
    agentDir: '/opt/sencho-agent',
    ...extra,
  });
  const ok = (id: string, stdout = ''): SshCommandResult => ({
    id, stdout, stderr: '', exitCode: 0, truncated: false, timedOut: false, error: null,
  });
  const makeService = (transport: BootstrapTransport, extra: Partial<ConstructorParameters<typeof NodeBootstrapService>[0]> = {}) => (
    new NodeBootstrapService({
      transport,
      db: DatabaseService.getInstance(),
      now: () => 1_762_300_000_000,
      resolveAddresses: async () => ['192.168.1.50'],
      caPem: () => null,
      ...extra,
    })
  );
  const pin = (host: string, fingerprint: string) => DatabaseService.getInstance().upsertNodeBootstrapTrust({
    host, port: 22, fingerprint, algorithm: 'ssh-ed25519', approved_by: 'admin', approved_at: 1, last_seen_at: 1,
  });

  it('keeps a pin that changed mid-run even when the request confirms a replacement', async () => {
    const db = DatabaseService.getInstance();
    const host = 'cas-replace.example.com';
    const observed = 'SHA256:observed000000000000000000000000000000000';
    pin(host, 'SHA256:original0000000000000000000000000000000');
    const transport: BootstrapTransport = {
      captureHostKey: async () => ({ algorithm: 'ssh-ed25519', fingerprint: observed, knownHostsLine: 'line' }),
      runCommands: async (_session, commands, options) => {
        options?.onHostKey?.({ algorithm: 'ssh-ed25519', fingerprint: observed, knownHostsLine: 'line' });
        pin(host, 'SHA256:interposed000000000000000000000000000000');
        return commands.map((command) => ok(command.id));
      },
    };
    await expect(makeService(transport).preflight(
      base(host, {
        expectedFingerprint: observed,
        replacePinnedFingerprint: observed,
        reviewedPinnedFingerprint: 'SHA256:original0000000000000000000000000000000',
      }),
      { hubUrl: hub, audit },
    )).rejects.toMatchObject({ code: 'HOST_KEY_MISMATCH' });
    expect(db.getNodeBootstrapTrust(host, 22)?.fingerprint).toBe('SHA256:interposed000000000000000000000000000000');
    const { entries } = db.getAuditLogs({ search: host, limit: 50 });
    expect(entries.some((entry) => entry.summary.startsWith('bootstrap.trust.replaced'))).toBe(false);
  });

  it.each([
    ['a pin that appeared during the run where there was none', null],
    ['a pin that changed during the run to the key now observed', 'SHA256:original0000000000000000000000000000000'],
  ])('refuses %s', async (_label, original) => {
    // The interposed pin equals the observed key, so only the compare-and-swap
    // on the pin read at the start of the run can refuse it.
    const db = DatabaseService.getInstance();
    const host = original ? 'cas-observed-replace.example.com' : 'cas-observed-new.example.com';
    const observed = 'SHA256:observed000000000000000000000000000000000';
    if (original) pin(host, original);
    const transport: BootstrapTransport = {
      captureHostKey: async () => ({ algorithm: 'ssh-ed25519', fingerprint: observed, knownHostsLine: 'line' }),
      runCommands: async (_session, commands, options) => {
        options?.onHostKey?.({ algorithm: 'ssh-ed25519', fingerprint: observed, knownHostsLine: 'line' });
        pin(host, observed);
        return commands.map((command) => ok(command.id));
      },
    };
    await expect(makeService(transport).preflight(
      base(host, original
        ? { expectedFingerprint: observed, replacePinnedFingerprint: observed, reviewedPinnedFingerprint: original }
        : { expectedFingerprint: observed }),
      { hubUrl: hub, audit },
    )).rejects.toMatchObject({ code: 'HOST_KEY_MISMATCH' });
    const { entries } = db.getAuditLogs({ search: host, limit: 50 });
    expect(entries.some((entry) => entry.summary.startsWith('bootstrap.trust.mismatch'))).toBe(true);
    expect(entries.some((entry) => entry.summary.startsWith('bootstrap.trust.replaced') || entry.summary.startsWith('bootstrap.trust.pinned'))).toBe(false);
  });

  it('rejects a stale replacement when the pin changed after the scan and before the preflight', async () => {
    // Scan showed A (pinned) and B (live). Another preflight then re-pinned C.
    // The operator's confirmation is "B replaces A", which says nothing about C.
    const db = DatabaseService.getInstance();
    const host = 'stale-confirm.example.com';
    const reviewedPin = 'SHA256:pinnedA00000000000000000000000000000000';
    const newerPin = 'SHA256:pinnedC00000000000000000000000000000000';
    const live = 'SHA256:observedB0000000000000000000000000000000';
    pin(host, newerPin);
    const transport = new FakeTransport(probeOutputs(), live);
    await expect(makeService(transport).preflight(
      base(host, { expectedFingerprint: live, replacePinnedFingerprint: live, reviewedPinnedFingerprint: reviewedPin }),
      { hubUrl: hub, audit },
    )).rejects.toMatchObject({
      status: 409,
      code: 'HOST_KEY_MISMATCH',
      details: { pinnedFingerprint: newerPin, expectedFingerprint: live },
    });
    expect(transport.commands).toHaveLength(0);
    expect(db.getNodeBootstrapTrust(host, 22)?.fingerprint).toBe(newerPin);
    const { entries } = db.getAuditLogs({ search: host, limit: 50 });
    expect(entries.some((entry) => entry.summary.startsWith('bootstrap.trust.mismatch') && entry.summary.includes(`pinned=${newerPin}`))).toBe(true);
    expect(entries.some((entry) => entry.summary.startsWith('bootstrap.trust.replaced'))).toBe(false);
  });

  it('tells a stale confirmation apart from a missing one, in the message and the audit row', async () => {
    const db = DatabaseService.getInstance();
    const stale = 'stale-message.example.com';
    const missing = 'missing-message.example.com';
    const current = 'SHA256:pinnedC00000000000000000000000000000000';
    const live = 'SHA256:observedB0000000000000000000000000000000';
    pin(stale, current);
    pin(missing, current);
    await expect(makeService(new FakeTransport(probeOutputs(), live)).preflight(
      base(stale, { expectedFingerprint: live, replacePinnedFingerprint: live, reviewedPinnedFingerprint: 'SHA256:old' }),
      { hubUrl: hub, audit },
    )).rejects.toThrow(/changed since you reviewed it/);
    await expect(makeService(new FakeTransport(probeOutputs(), live)).preflight(
      base(missing, { expectedFingerprint: live }),
      { hubUrl: hub, audit },
    )).rejects.toThrow(/Confirm the replacement to continue/);
    const staleRow = db.getAuditLogs({ search: stale, limit: 20 }).entries.find((entry) => entry.summary.startsWith('bootstrap.trust.mismatch'));
    const missingRow = db.getAuditLogs({ search: missing, limit: 20 }).entries.find((entry) => entry.summary.startsWith('bootstrap.trust.mismatch'));
    expect(staleRow?.summary).toContain('reviewed=SHA256:old');
    expect(missingRow?.summary).not.toContain('reviewed=');
  });

  it('treats a reviewed pin without a replacement fingerprint, and the reverse, as no confirmation', async () => {
    const db = DatabaseService.getInstance();
    const host = 'half-confirm.example.com';
    const current = 'SHA256:pinnedA00000000000000000000000000000000';
    const live = 'SHA256:observedB0000000000000000000000000000000';
    pin(host, current);
    for (const extra of [
      { reviewedPinnedFingerprint: current },
      { replacePinnedFingerprint: live },
      { replacePinnedFingerprint: live, reviewedPinnedFingerprint: '  ' },
    ]) {
      await expect(makeService(new FakeTransport(probeOutputs(), live)).preflight(
        base(host, { expectedFingerprint: live, ...extra }),
        { hubUrl: hub, audit },
      )).rejects.toMatchObject({ code: 'HOST_KEY_MISMATCH' });
    }
    expect(db.getNodeBootstrapTrust(host, 22)?.fingerprint).toBe(current);
  });

  it('replaces the pin when the confirmation names the current pin, and audits the replacement', async () => {
    const db = DatabaseService.getInstance();
    const host = 'current-confirm.example.com';
    const current = 'SHA256:pinnedA00000000000000000000000000000000';
    const live = 'SHA256:observedB0000000000000000000000000000000';
    pin(host, current);
    const result = await makeService(new FakeTransport(probeOutputs(), live)).preflight(
      base(host, { expectedFingerprint: live, replacePinnedFingerprint: live, reviewedPinnedFingerprint: current }),
      { hubUrl: hub, audit },
    );
    expect(result.blocked).toBe(false);
    expect(db.getNodeBootstrapTrust(host, 22)?.fingerprint).toBe(live);
    const { entries } = db.getAuditLogs({ search: host, limit: 50 });
    expect(entries.some((entry) => entry.summary.startsWith('bootstrap.trust.replaced') && entry.summary.includes(`previous=${current}`))).toBe(true);
  });

  it('ignores a reviewed pin when no replacement fingerprint was confirmed', async () => {
    const db = DatabaseService.getInstance();
    const host = 'reviewed-only.example.com';
    const current = 'SHA256:pinnedA00000000000000000000000000000000';
    pin(host, current);
    await expect(makeService(new FakeTransport()).preflight(
      base(host, { reviewedPinnedFingerprint: current }),
      { hubUrl: hub, audit },
    )).rejects.toMatchObject({ code: 'HOST_KEY_MISMATCH' });
    expect(db.getNodeBootstrapTrust(host, 22)?.fingerprint).toBe(current);
  });

  it('refuses a replacement that confirms a different key than the one expected', async () => {
    const db = DatabaseService.getInstance();
    const host = 'mismatched-confirm.example.com';
    const current = 'SHA256:pinnedA00000000000000000000000000000000';
    pin(host, current);
    await expect(makeService(new FakeTransport()).preflight(
      base(host, { replacePinnedFingerprint: 'SHA256:somethingelse000000000000000000000000000', reviewedPinnedFingerprint: current }),
      { hubUrl: hub, audit },
    )).rejects.toMatchObject({ code: 'HOST_KEY_MISMATCH' });
    expect(db.getNodeBootstrapTrust(host, 22)?.fingerprint).toBe(current);
  });

  it('blocks and issues no plan when inventories and the Docker CLI probe fail', async () => {
    const outputs = probeOutputs();
    const transport: BootstrapTransport = {
      captureHostKey: async () => ({ algorithm: 'ssh-ed25519', fingerprint: 'SHA256:x', knownHostsLine: 'line' }),
      runCommands: async (_session, commands, options) => {
        options?.onHostKey?.({ algorithm: 'ssh-ed25519', fingerprint: base('x').expectedFingerprint as string, knownHostsLine: 'line' });
        return commands.map((command) => {
          if (['compose_inventory', 'compose_inventory_sudo', 'containers', 'containers_sudo'].includes(command.id)) {
            return { ...ok(command.id), exitCode: 1 };
          }
          if (command.id === 'docker_info') return { ...ok(command.id, '|\n'), exitCode: 1 };
          if (command.id === 'docker_cli') return { ...ok(command.id), error: 'COMMAND_ERROR', exitCode: null };
          return ok(command.id, outputs[command.id] ?? '');
        });
      },
    };
    const result = await makeService(transport).preflight(base('failed-probes.example.com'), { hubUrl: hub, audit });
    expect(result.blocked).toBe(true);
    expect(result.plan).toBeNull();
    const unknown = result.inspection.checks.filter((entry) => entry.status === 'unknown').map((entry) => entry.id);
    expect(unknown).toEqual(expect.arrayContaining(['docker_cli', 'agent_conflict']));
  });

  describe('issues no plan when a safety fact is unknown or contradicted', () => {
    async function preflightWith(
      overrides: Record<string, string>,
      failing: Record<string, number> = {},
      extra: Partial<BootstrapPreflightRequest> = {},
    ) {
      const outputs = { ...probeOutputs(), ...overrides };
      const transport: BootstrapTransport = {
        captureHostKey: async () => ({ algorithm: 'ssh-ed25519', fingerprint: 'SHA256:x', knownHostsLine: 'line' }),
        runCommands: async (_session, commands, options) => {
          options?.onHostKey?.({ algorithm: 'ssh-ed25519', fingerprint: base('x').expectedFingerprint as string, knownHostsLine: 'line' });
          return commands.map((command) => (
            command.id in failing
              ? { ...ok(command.id, outputs[command.id] ?? ''), exitCode: failing[command.id] }
              : ok(command.id, outputs[command.id] ?? '')
          ));
        },
      };
      return makeService(transport).preflight(base(`safety-${Math.random().toString(36).slice(2)}.example.com`, extra), { hubUrl: hub, audit });
    }
    const statusOf = (result: Awaited<ReturnType<typeof preflightWith>>, id: string) => (
      result.inspection.checks.find((entry) => entry.id === id)?.status
    );

    it('for a custom Docker root whose capacity could not be read', async () => {
      const result = await preflightWith({ docker_info: '27.3.1|/data/docker', docker_root_disk: 'D_SOURCE=unavailable' });
      expect(statusOf(result, 'disk_space')).toBe('unknown');
      expect(result.blocked).toBe(true);
      expect(result.plan).toBeNull();
    });

    it('for the default root measured as if it were a custom root', async () => {
      const result = await preflightWith({
        docker_info: '27.3.1|/data/docker',
        docker_root_disk: 'D_SOURCE=daemon\nD_ROOT=/var/lib/docker\nD_DF=/dev/sda1 1 1 104857600 1% /',
      });
      expect(result.inspection.dockerRoot).toMatchObject({ path: '/data/docker', freeBytes: null });
      expect(result.plan).toBeNull();
    });

    it('for a default Pilot directory that could not be inspected', async () => {
      const result = await preflightWith({ default_agent_path: 'error\n' }, { default_agent_path_sudo: 1 });
      expect(statusOf(result, 'agent_conflict')).toBe('unknown');
      expect(result.plan).toBeNull();
    });

    it('for an earlier installation found through sudo beside an existing empty chosen directory', async () => {
      const emptyAlternate = [
        'P_INPUT=/srv/agent', 'P_EXISTS=1', 'P_ISDIR=1', 'P_FINAL_LINK=0', 'P_REAL=/srv/agent', 'P_ANCESTOR_LINK=0',
        'P_OWNER=ubuntu', 'P_GROUP=ubuntu', 'P_MODE=700', 'P_USER_R=1', 'P_USER_W=1', 'P_NEAREST=/srv/agent',
        'P_PARENT_W=1', 'P_FSTYPE=ext4', 'P_FSSOURCE=/dev/sda1', 'P_FSTARGET=/', 'P_DF=/dev/sda1 1 1 104857600 1% /',
      ].join('\n');
      const result = await preflightWith(
        { path_agent: emptyAlternate, default_agent_path: 'error\n', default_agent_path_sudo: 'yes\n' },
        {},
        { agentDir: '/srv/agent' },
      );
      expect(statusOf(result, 'agent_conflict')).toBe('blocked');
      expect(result.plan).toBeNull();
    });

    it('for a working distribution Docker that only lacks Compose', async () => {
      const result = await preflightWith({
        compose_version: '',
        docker_repo: '',
        apt_policy: 'docker-ce:\n  Installed: (none)\n  Candidate: (none)',
        containers: 'web\tnginx\tweb\t/srv/web\tUp',
      }, { compose_version: 1, compose_version_sudo: 1 });
      expect(statusOf(result, 'compose_plugin')).toBe('blocked');
      expect(result.plan).toBeNull();
    });

    describe('for a capacity the shared Compose and Agent filesystem did not report in full', () => {
      const withoutDf = PATH_AGENT_OUTPUT.split('\n').filter((line) => !line.startsWith('P_DF=')).join('\n');
      const withDf = (df: string) => PATH_AGENT_OUTPUT.replace(/^P_DF=.*$/m, `P_DF=${df}`);

      it('whose Agent reading is missing', async () => {
        const result = await preflightWith({ path_agent: withoutDf });
        expect(statusOf(result, 'disk_space')).toBe('unknown');
        expect(result.blocked).toBe(true);
        expect(result.plan).toBeNull();
      });

      it('whose Agent reading is under the hard floor', async () => {
        const result = await preflightWith({ path_agent: withDf('/dev/sda1 1 1 102400 99% /') });
        expect(statusOf(result, 'disk_space')).toBe('blocked');
        expect(result.plan).toBeNull();
      });

      it('whose Compose reading is missing beside a healthy Agent reading', async () => {
        const result = await preflightWith({ path_compose: PATH_COMPOSE_OUTPUT.replace(/^P_DF=.*$/m, 'P_DF=') });
        expect(statusOf(result, 'disk_space')).toBe('unknown');
        expect(result.plan).toBeNull();
      });
    });

    describe('for apt sources the preflight could not tie to the apt configuration', () => {
      const freshHostFailures = { docker_cli: 1, docker_info: 1, docker_info_sudo: 1, compose_version: 1, compose_version_sudo: 1 };
      const freshHost = {
        docker_info: '',
        docker_cli: '',
        compose_version: '',
        apt_policy: '',
        docker_root_disk: 'D_SOURCE=default\nD_ROOT=/var/lib/docker\nD_DF=/dev/sda1 1 1 104857600 1% /',
      };
      const customLocations = (main: string, parts: string) => `SOURCE_LOCATIONS_MAIN=${main}\nSOURCE_LOCATIONS_PARTS=${parts}`;

      it.each([
        ['the main source list', customLocations('/srv/apt/sources.list', '/etc/apt/sources.list.d')],
        ['the source directory', customLocations('/etc/apt/sources.list', '/srv/apt/sources.list.d')],
        ['both', customLocations('/srv/apt/sources.list', '/srv/apt/sources.list.d')],
        ['neither, because apt did not say', ''],
      ])('on a fresh host where %s is not the default and holds no Docker source', async (_name, docker_repo) => {
        const result = await preflightWith({ ...freshHost, docker_repo }, freshHostFailures);
        expect(statusOf(result, 'apt_source')).toBe('unknown');
        expect(result.blocked).toBe(true);
        expect(result.plan).toBeNull();
      });

      it('on a fresh host whose default locations are confirmed, the plan adds the source', async () => {
        const result = await preflightWith({ ...freshHost, docker_repo: DEFAULT_SOURCE_LOCATIONS }, freshHostFailures);
        expect(statusOf(result, 'apt_source')).toBe('warn');
        expect(result.plan).not.toBeNull();
      });

      it('on a fresh host where a custom list holds an active Docker source that apt would reject beside the plan', async () => {
        const result = await preflightWith({
          ...freshHost,
          docker_repo: [
            customLocations('/srv/apt/sources.list', '/etc/apt/sources.list.d'),
            'SOURCE_BEGIN=/srv/apt/sources.list',
            `deb [arch=arm64 trusted=yes signed-by=${DOCKER_ASC_PATH}] https://download.docker.com/linux/ubuntu noble stable`,
            'SOURCE_END=/srv/apt/sources.list',
            dockerAscBlock(),
          ].join('\n'),
        }, freshHostFailures);
        expect(statusOf(result, 'apt_source')).toBe('blocked');
        expect(result.plan).toBeNull();
      });

      it('on a working installation, the existing Docker is preserved whatever the locations', async () => {
        const result = await preflightWith({ docker_repo: customLocations('/srv/apt/sources.list', '/srv/apt/sources.list.d') });
        expect(statusOf(result, 'apt_source')).toBe('warn');
        expect(result.blocked).toBe(false);
      });
    });

    describe('for a deb822 source whose Types apt does not know', () => {
      const debSource = (types: string) => [
        DEFAULT_SOURCE_LOCATIONS,
        'SOURCE_BEGIN=/etc/apt/sources.list.d/docker.sources',
        `Types: ${types}`,
        'URIs: https://download.docker.com/linux/ubuntu',
        'Suites: noble',
        'Components: stable',
        `Signed-By: ${DOCKER_ASC_PATH}`,
        'SOURCE_END=/etc/apt/sources.list.d/docker.sources',
        dockerAscBlock(),
      ].join('\n');
      const failedPolicy = { apt_policy: '' };
      const OFFICIAL_ARCHIVE_POLICY = [
        'docker-ce:', '  Installed: 1', '  Candidate: 1', '  Version table:',
        ' *** 1 500', '        500 https://download.docker.com/linux/ubuntu noble/stable amd64 Packages',
      ].join('\n');

      it.each(['deb nonsense', 'nonsense', 'DEB', 'deb,deb-src'])('is never verified on a working installation (%s)', async (types) => {
        const result = await preflightWith({ docker_repo: debSource(types), ...failedPolicy }, { apt_policy: 100 });
        expect(statusOf(result, 'apt_source')).not.toBe('pass');
        expect(result.blocked).toBe(false);
        expect(result.plan).not.toBeNull();
      });

      it.each(['deb nonsense', 'nonsense', 'DEB', 'deb,deb-src'])('withholds the plan on a fresh host (%s)', async (types) => {
        const result = await preflightWith({
          docker_info: '', docker_cli: '', compose_version: '', apt_policy: '', docker_repo: debSource(types),
        }, { docker_cli: 1, docker_info: 1, docker_info_sudo: 1, compose_version: 1, compose_version_sudo: 1, apt_policy: 100 });
        expect(result.plan).toBeNull();
      });

      it.each(['deb', 'deb deb-src', 'deb-src deb'])('still verifies the valid types (%s)', async (types) => {
        const result = await preflightWith({ docker_repo: debSource(types), apt_policy: OFFICIAL_ARCHIVE_POLICY });
        expect(statusOf(result, 'apt_source')).toBe('pass');
      });
    });

    it('for a Docker source that weakens signature checking', async () => {
      const result = await preflightWith({
        docker_info: '',
        docker_cli: '',
        docker_repo: [
          'SOURCE_BEGIN=/etc/apt/sources.list.d/docker.list',
          `deb [arch=amd64 trusted=yes signed-by=${DOCKER_ASC_PATH}] https://download.docker.com/linux/ubuntu noble stable`,
          'SOURCE_END=/etc/apt/sources.list.d/docker.list',
          dockerAscBlock(),
        ].join('\n'),
      }, { docker_cli: 1, docker_info: 1, docker_info_sudo: 1, compose_version: 1, compose_version_sudo: 1 });
      expect(statusOf(result, 'apt_source')).toBe('blocked');
      expect(result.plan).toBeNull();
    });

    describe('for a repository credential in a source file', () => {
      const SECRETS = ['AUDIT_FAKE_REPO_PASSWORD', 'AUDIT_FAKE_QUERY_TOKEN', 'AUDIT_FAKE_PATH_TOKEN'];
      const credentialed = 'https://operator:AUDIT_FAKE_REPO_PASSWORD@private.example/AUDIT_FAKE_PATH_TOKEN/r?token=AUDIT_FAKE_QUERY_TOKEN';
      const good = `deb [signed-by=${DOCKER_ASC_PATH}] https://download.docker.com/linux/ubuntu noble stable`;
      const repo = (file: string, content: string) => [
        DEFAULT_SOURCE_LOCATIONS,
        `SOURCE_BEGIN=${file}`,
        content,
        `SOURCE_END=${file}`,
        dockerAscBlock(),
      ].join('\n');
      const failedPolicy = { apt_policy: '' };
      const freshFailures = { docker_cli: 1, docker_info: 1, docker_info_sudo: 1, compose_version: 1, compose_version_sudo: 1, apt_policy: 100 };
      const sources: Array<[string, string]> = [
        ['a malformed line in docker.list', repo('/etc/apt/sources.list.d/docker.list', `${good}\ndeb ${credentialed} noble`)],
        ['a malformed line in an arbitrary .list', repo('/etc/apt/sources.list.d/other.list', `${good}\ndeb ${credentialed} noble`)],
        ['a malformed line in the main list', repo('/etc/apt/sources.list', `${good}\ndeb ${credentialed} noble`)],
        ['a wrong repository in docker.list', repo('/etc/apt/sources.list.d/docker.list', `deb [signed-by=${DOCKER_ASC_PATH}] ${credentialed} noble stable`)],
        ['an unknown type in docker.sources', repo('/etc/apt/sources.list.d/docker.sources', `Types: deb ${credentialed}\nURIs: https://download.docker.com/linux/ubuntu\nSuites: noble\nComponents: stable`)],
        ['an unparsable line in an arbitrary .sources', repo('/etc/apt/sources.list.d/other.sources', `Types: deb\nURIs: https://download.docker.com/linux/ubuntu\nSuites: noble\nComponents: stable\n\n${credentialed.replace(/:/g, ' ')}`)],
        ['a suite that is a token in an arbitrary .list', repo('/etc/apt/sources.list.d/other.list', `deb [signed-by=${DOCKER_ASC_PATH}] https://download.docker.com/linux/ubuntu AUDIT_FAKE_PATH_TOKEN stable`)],
        ['a credentialed Docker host with a trailing dot in an arbitrary .list', repo('/etc/apt/sources.list.d/other.list', `deb [signed-by=${DOCKER_ASC_PATH}] https://operator:AUDIT_FAKE_REPO_PASSWORD@download.docker.com./linux/ubuntu?token=AUDIT_FAKE_QUERY_TOKEN noble stable`)],
        ['a hash in the userinfo in docker.list', repo('/etc/apt/sources.list.d/docker.list', `deb [signed-by=${DOCKER_ASC_PATH}] https://AUDIT_FAKE_REPO_PASSWORD#x@private.example/r noble stable`)],
        ['two files that disagree on the keyring', [
          DEFAULT_SOURCE_LOCATIONS,
          'SOURCE_BEGIN=/etc/apt/sources.list.d/docker.list',
          `deb [arch=amd64 signed-by=${DOCKER_ASC_PATH}] https://operator:AUDIT_FAKE_REPO_PASSWORD@download.docker.com/linux/ubuntu?token=AUDIT_FAKE_QUERY_TOKEN noble stable`,
          'SOURCE_END=/etc/apt/sources.list.d/docker.list',
          'SOURCE_BEGIN=/etc/apt/sources.list.d/other.sources',
          `Types: deb\nURIs: https://operator:AUDIT_FAKE_REPO_PASSWORD@download.docker.com/linux/ubuntu?token=AUDIT_FAKE_QUERY_TOKEN\nSuites: noble\nComponents: stable\nSigned-By: /etc/apt/keyrings/other.asc`,
          'SOURCE_END=/etc/apt/sources.list.d/other.sources',
          dockerAscBlock(),
        ].join('\n')],
      ];

      it.each(sources)('keeps it out of the response for %s on a working installation', async (_label, docker_repo) => {
        const result = await preflightWith({ docker_repo, ...failedPolicy }, { apt_policy: 100 });
        expect(statusOf(result, 'apt_source')).toBe('warn');
        for (const secret of SECRETS) expect(JSON.stringify(result)).not.toContain(secret);
      });

      it.each(sources)('keeps it out of the response for %s on a fresh host', async (_label, docker_repo) => {
        const result = await preflightWith({ docker_info: '', docker_cli: '', compose_version: '', apt_policy: '', docker_repo }, freshFailures);
        expect(result.plan).toBeNull();
        for (const secret of SECRETS) expect(JSON.stringify(result)).not.toContain(secret);
      });
    });
  });

  it('reports the mount as unknown when /etc/fstab could not be read', async () => {
    const outputs = probeOutputs();
    const transport: BootstrapTransport = {
      captureHostKey: async () => ({ algorithm: 'ssh-ed25519', fingerprint: 'SHA256:x', knownHostsLine: 'line' }),
      runCommands: async (_session, commands, options) => {
        options?.onHostKey?.({ algorithm: 'ssh-ed25519', fingerprint: base('x').expectedFingerprint as string, knownHostsLine: 'line' });
        return commands.map((command) => (
          command.id === 'fstab'
            ? { ...ok('fstab'), exitCode: null, timedOut: true, error: 'COMMAND_TIMEOUT' }
            : ok(command.id, outputs[command.id] ?? '')
        ));
      },
    };
    const result = await makeService(transport).preflight(base('fstab-fail.example.com'), { hubUrl: hub, audit });
    expect(result.inspection.paths.composeDir.mountInFstab).toBeNull();
  });

  it('does not dial a second address after the first rejected the live host key', async () => {
    const dialed: string[] = [];
    const transport: BootstrapTransport = {
      captureHostKey: async () => ({ algorithm: 'ssh-ed25519', fingerprint: 'SHA256:x', knownHostsLine: 'line' }),
      runCommands: async (session, _commands, options) => {
        dialed.push(session.address);
        options?.onHostKey?.({ algorithm: 'ssh-ed25519', fingerprint: 'SHA256:live', knownHostsLine: 'line' });
        throw new SshTransportError('HOST_KEY_UNTRUSTED', 'changed');
      },
    };
    await expect(makeService(transport, { resolveAddresses: async () => ['10.0.0.1', '10.0.0.2'] }).preflight(
      base('two-address-mismatch.example.com'),
      { hubUrl: hub, audit },
    )).rejects.toMatchObject({ code: 'HOST_KEY_UNTRUSTED' });
    expect(dialed).toEqual(['10.0.0.1']);
  });

  it.each(['SSH_AUTH_FAILED', 'SSH_KEY_INVALID', 'SSH_KEY_PASSPHRASE_REQUIRED', 'SSH_KEY_PASSPHRASE_INVALID'] as const)(
    'reports %s without trying the next address',
    async (code) => {
      const dialed: string[] = [];
      const transport: BootstrapTransport = {
        captureHostKey: async () => ({ algorithm: 'ssh-ed25519', fingerprint: 'SHA256:x', knownHostsLine: 'line' }),
        runCommands: async (session) => {
          dialed.push(session.address);
          throw new SshTransportError(code, 'rejected');
        },
      };
      await expect(makeService(transport, { resolveAddresses: async () => ['10.0.0.1', '10.0.0.2'] }).preflight(
        base(`auth-${code.toLowerCase().replace(/_/g, "-")}.example.com`),
        { hubUrl: hub, audit },
      )).rejects.toMatchObject({ code });
      expect(dialed).toEqual(['10.0.0.1']);
    },
  );

  it('does not let a refused first address hide an authentication failure on the second', async () => {
    const transport: BootstrapTransport = {
      captureHostKey: async () => ({ algorithm: 'ssh-ed25519', fingerprint: 'SHA256:x', knownHostsLine: 'line' }),
      runCommands: async (session) => {
        throw new SshTransportError(session.address === '10.0.0.1' ? 'SSH_UNREACHABLE' : 'SSH_AUTH_FAILED', 'x');
      },
    };
    await expect(makeService(transport, { resolveAddresses: async () => ['10.0.0.1', '10.0.0.2'] }).preflight(
      base('refused-then-auth.example.com'),
      { hubUrl: hub, audit },
    )).rejects.toMatchObject({ code: 'SSH_AUTH_FAILED' });
  });

  it('shares one deadline across host-key capture attempts and stops dialing once it is spent', async () => {
    const timeouts: number[] = [];
    const dialed: string[] = [];
    const clock = createManualClock(1_762_300_000_000);
    const transport: BootstrapTransport = {
      captureHostKey: async ({ address }, options) => {
        dialed.push(address);
        timeouts.push(options?.timeoutMs ?? -1);
        clock.advance(80);
        throw new SshTransportError('SSH_UNREACHABLE', 'down');
      },
      runCommands: async () => [],
    };
    await expect(makeService(transport, {
      resolveAddresses: async () => ['10.0.0.1', '10.0.0.2', '10.0.0.3'],
      requestBudgetMs: 120,
      now: clock.now,
    }).captureHostKey({ host: 'slow-scan.example.com', port: 22 })).rejects.toMatchObject({ code: 'PREFLIGHT_TIMEOUT' });
    expect(timeouts[0]).toBeLessThanOrEqual(120);
    expect(timeouts[1]).toBeLessThan(timeouts[0]);
    expect(dialed).not.toContain('10.0.0.3');
  });

  it('hands the caller abort signal to both transport entry points', async () => {
    const controller = new AbortController();
    const seen: Array<AbortSignal | undefined> = [];
    const transport: BootstrapTransport = {
      captureHostKey: async (_target, options) => {
        seen.push(options?.signal);
        return { algorithm: 'ssh-ed25519', fingerprint: 'SHA256:x', knownHostsLine: 'line' };
      },
      runCommands: async (_session, commands, options) => {
        seen.push(options?.signal);
        options?.onHostKey?.({ algorithm: 'ssh-ed25519', fingerprint: base('x').expectedFingerprint as string, knownHostsLine: 'line' });
        return commands.map((command) => ok(command.id, probeOutputs()[command.id] ?? ''));
      },
    };
    const svc = makeService(transport);
    await svc.captureHostKey({ host: 'signal.example.com', port: 22 }, { signal: controller.signal });
    await svc.preflight(base('signal.example.com'), { hubUrl: hub, audit, signal: controller.signal });
    expect(seen).toEqual([controller.signal, controller.signal]);
  });

  it('words the budget error from the configured budget', async () => {
    const svc = makeService(new FakeTransport(), {
      resolveAddresses: async () => { await new Promise((resolve) => setTimeout(resolve, 1500)); return ['192.168.1.50']; },
      requestBudgetMs: 1000,
    });
    await expect(svc.preflight(base('budget-words.example.com'), { hubUrl: hub, audit }))
      .rejects.toMatchObject({ code: 'PREFLIGHT_TIMEOUT', message: expect.stringContaining('1-second') });
  });
});

describe('bootstrap routes: client disconnect', () => {
  it('aborts the service call when the client goes away before the reply', async () => {
    let signal: AbortSignal | undefined;
    let started!: () => void;
    const running = new Promise<void>((resolve) => { started = resolve; });
    vi.spyOn(NodeBootstrapService.getInstance(), 'preflight').mockImplementation(async (_input, context) => {
      signal = context.signal;
      started();
      await new Promise<void>((resolve) => context.signal?.addEventListener('abort', () => resolve(), { once: true }));
      throw new SshTransportError('SSH_UNREACHABLE', 'The request was cancelled.');
    });
    const pending = request(app)
      .post('/api/nodes/bootstrap/preflight')
      .set('Authorization', adminAuth)
      .send({
        host: 'server.example.com',
        username: 'ubuntu',
        privateKey: 'key',
        targetName: 'media-server',
        composeDir: '/opt/docker/sencho',
        agentDir: '/opt/sencho-agent',
      });
    const done = pending.then(() => null, () => null);
    await running;
    expect(signal?.aborted).toBe(false);
    pending.abort();
    await done;
    await vi.waitFor(() => expect(signal?.aborted).toBe(true));
  });
});

describe('bootstrap service target identity: DNS names are case-insensitive', () => {
  const audit = { username: 'admin', ip: '127.0.0.1', method: 'POST', path: '/api/nodes/bootstrap/preflight' };
  const hub = 'https://sencho.example.com';
  const key = '-----BEGIN OPENSSH PRIVATE KEY-----\nnot-a-real-key\n-----END OPENSSH PRIVATE KEY-----';
  const pinnedKey = 'SHA256:pinnedA00000000000000000000000000000000';
  const liveKey = 'SHA256:observedB0000000000000000000000000000000';
  const db = () => DatabaseService.getInstance();
  const base = (host: string, extra: Partial<BootstrapPreflightRequest> = {}): BootstrapPreflightRequest => ({
    host,
    port: 22,
    username: 'ubuntu',
    privateKey: key,
    expectedFingerprint: liveKey,
    targetName: 'case-server',
    composeDir: '/opt/docker/sencho',
    agentDir: '/opt/sencho-agent',
    ...extra,
  });
  const makeService = (transport: BootstrapTransport) => new NodeBootstrapService({
    transport,
    db: db(),
    now: () => 1_762_300_000_000,
    resolveAddresses: async () => ['192.168.1.50'],
    caPem: () => null,
  });
  const pin = (host: string, fingerprint: string) => db().upsertNodeBootstrapTrust({
    host, port: 22, fingerprint, algorithm: 'ssh-ed25519', approved_by: 'admin', approved_at: 1, last_seen_at: 1,
  });

  it('finds the lower-case pin from a mixed-case host-key scan and reports the change', async () => {
    pin('scan-case.example.com', pinnedKey);
    const result = await makeService(new FakeTransport(probeOutputs(), liveKey))
      .captureHostKey({ host: 'Scan-Case.Example.COM' });
    expect(result.host).toBe('scan-case.example.com');
    expect(result.trust).toBe('changed');
    expect(result.pinnedFingerprint).toBe(pinnedKey);
  });

  it('rejects a mixed-case preflight against the lower-case pin and creates no second pin', async () => {
    pin('pf-case.example.com', pinnedKey);
    const transport = new FakeTransport(probeOutputs(), liveKey);
    await expect(makeService(transport).preflight(
      base('PF-Case.Example.com'),
      { hubUrl: hub, audit },
    )).rejects.toMatchObject({ code: 'HOST_KEY_MISMATCH', details: { pinnedFingerprint: pinnedKey } });
    expect(transport.commands).toHaveLength(0);
    expect(db().getNodeBootstrapTrust('pf-case.example.com', 22)?.fingerprint).toBe(pinnedKey);
    const rows = db().getDb().prepare('SELECT host FROM node_bootstrap_trust WHERE lower(host) = ?').all('pf-case.example.com');
    expect(rows).toEqual([{ host: 'pf-case.example.com' }]);
    const { entries } = db().getAuditLogs({ search: 'pf-case.example.com', limit: 50 });
    expect(entries.some((entry) => entry.summary.startsWith('bootstrap.trust.mismatch'))).toBe(true);
  });

  it('stores a first pin under the canonical spelling', async () => {
    await makeService(new FakeTransport(probeOutputs(), liveKey)).preflight(
      base('First-Pin.Example.COM'),
      { hubUrl: hub, audit },
    );
    expect(db().getDb().prepare('SELECT host FROM node_bootstrap_trust WHERE lower(host) = ?').all('first-pin.example.com'))
      .toEqual([{ host: 'first-pin.example.com' }]);
    expect(db().getNodeBootstrapTrust('FIRST-PIN.example.com', 22)?.fingerprint).toBe(liveKey);
  });

  it('keys the target lock on the folded host even when a caller passes another spelling', async () => {
    const svc = new NodeBootstrapService({
      transport: new FakeTransport(probeOutputs(), liveKey),
      db: db(),
      now: () => 1_762_300_000_000,
      resolveAddresses: async () => ['192.168.1.50'],
      caPem: () => null,
    });
    const lock = (host: string, run: () => Promise<void>) => (
      svc as unknown as { withTargetLock: (h: string, p: number, r: () => Promise<void>) => Promise<void> }
    ).withTargetLock(host, 22, run);
    await lock('Lock-Direct.example.com', async () => {
      await expect(lock('LOCK-direct.example.com', async () => {})).rejects.toMatchObject({ code: 'BOOTSTRAP_IN_PROGRESS' });
    });
    await expect(lock('lock-direct.example.com', async () => {})).resolves.toBeUndefined();
  });

  it('shares one target lock across case variants and releases it afterwards', async () => {
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    const svc = new NodeBootstrapService({
      transport: new FakeTransport(probeOutputs(), liveKey),
      db: db(),
      now: () => 1_762_300_000_000,
      resolveAddresses: async () => {
        calls += 1;
        if (calls === 1) await gate;
        return ['192.168.1.50'];
      },
      caPem: () => null,
    });
    const first = svc.preflight(base('lock-case.example.com'), { hubUrl: hub, audit });
    await new Promise((resolve) => setImmediate(resolve));
    await expect(svc.preflight(base('LOCK-Case.example.com'), { hubUrl: hub, audit }))
      .rejects.toMatchObject({ code: 'BOOTSTRAP_IN_PROGRESS' });
    await expect(svc.captureHostKey({ host: 'Lock-CASE.example.com' }))
      .rejects.toMatchObject({ code: 'BOOTSTRAP_IN_PROGRESS' });
    release!();
    await first;
    await expect(svc.preflight(base('LOCK-case.example.com'), { hubUrl: hub, audit })).resolves.toBeDefined();
  });

  it('folds the host in the storage accessors, so no caller reaches a case variant', () => {
    pin('Accessor.Example.COM', pinnedKey);
    expect(db().getNodeBootstrapTrust('accessor.example.com', 22)?.fingerprint).toBe(pinnedKey);
    expect(db().getNodeBootstrapTrust('ACCESSOR.example.com', 22)?.host).toBe('accessor.example.com');
    pin('ACCESSOR.example.com', liveKey);
    expect(db().getDb().prepare('SELECT fingerprint FROM node_bootstrap_trust WHERE lower(host) = ?').all('accessor.example.com'))
      .toEqual([{ fingerprint: liveKey }]);
  });

  describe('stored case variants from an earlier build', () => {
    const insertRaw = (host: string, fingerprint: string, approvedAt: number, port = 22, approvedBy = 'admin') => db().getDb().prepare(
      `INSERT INTO node_bootstrap_trust (host, port, fingerprint, algorithm, approved_by, approved_at, last_seen_at)
       VALUES (?, ?, ?, 'ssh-ed25519', ?, ?, ?)`,
    ).run(host, port, fingerprint, approvedBy, approvedAt, approvedAt);
    const rowsFor = (lowerHost: string) => db().getDb().prepare(
      'SELECT host, port, fingerprint FROM node_bootstrap_trust WHERE lower(host) = ? ORDER BY host, port',
    ).all(lowerHost);
    const migrate = () => (db() as unknown as { migrateNodeBootstrapTrustHostCase: () => void }).migrateNodeBootstrapTrustHostCase();

    it('renames a lone mixed-case pin to the lower-case host and keeps the decision', () => {
      insertRaw('Legacy-One.Example.com', pinnedKey, 5);
      migrate();
      expect(rowsFor('legacy-one.example.com')).toEqual([{ host: 'legacy-one.example.com', port: 22, fingerprint: pinnedKey }]);
      expect(db().getNodeBootstrapTrust('legacy-one.example.com', 22)?.approved_at).toBe(5);
    });

    it('collapses duplicate spellings of one key into one pin', () => {
      insertRaw('legacy-same.example.com', pinnedKey, 5);
      insertRaw('LEGACY-same.example.com', pinnedKey, 9);
      migrate();
      expect(rowsFor('legacy-same.example.com')).toEqual([{ host: 'legacy-same.example.com', port: 22, fingerprint: pinnedKey }]);
    });

    it('trusts neither key when spellings disagree, so the host asks for a fresh decision', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      insertRaw('legacy-conflict.example.com', pinnedKey, 5);
      insertRaw('Legacy-Conflict.example.com', liveKey, 9);
      migrate();
      expect(rowsFor('legacy-conflict.example.com')).toEqual([]);
      expect(db().getNodeBootstrapTrust('legacy-conflict.example.com', 22)).toBeUndefined();
      expect(warn.mock.calls.some((call) => String(call[0]).includes('Conflicting host key pins')
        && String(call[0]).includes(pinnedKey) && String(call[0]).includes(liveKey))).toBe(true);
    });

    it('does not bring back a key that was replaced after the older spelling was pinned', () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      insertRaw('Legacy-Rotated.example.com', pinnedKey, 5);
      insertRaw('legacy-rotated.example.com', liveKey, 9);
      migrate();
      expect(db().getNodeBootstrapTrust('legacy-rotated.example.com', 22)).toBeUndefined();
    });

    it('judges each port on its own', () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      insertRaw('legacy-ports.example.com', pinnedKey, 5, 22);
      insertRaw('Legacy-Ports.example.com', pinnedKey, 6, 22);
      insertRaw('legacy-ports.example.com', liveKey, 7, 2222);
      migrate();
      expect(rowsFor('legacy-ports.example.com')).toEqual([
        { host: 'legacy-ports.example.com', port: 22, fingerprint: pinnedKey },
        { host: 'legacy-ports.example.com', port: 2222, fingerprint: liveKey },
      ]);
    });

    it('records each dropped key in the audit log, already on disk when the migration returns', () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      insertRaw('legacy-audit.example.com', pinnedKey, 5);
      insertRaw('LEGACY-audit.example.com', liveKey, 9);
      migrate();
      // Read the table directly: getAuditLogs would flush the buffer first and hide a lost row.
      const row = db().getDb().prepare("SELECT summary FROM audit_log WHERE summary LIKE 'bootstrap.trust.conflict: host=legacy-audit.example.com:22%'").get() as { summary: string } | undefined;
      expect(row?.summary).toContain('host=legacy-audit.example.com:22');
      expect(row?.summary).toContain(`${pinnedKey} (approved by admin at 1970-01-01T00:00:00.005Z)`);
      expect(row?.summary).toContain(`${liveKey} (approved by admin at 1970-01-01T00:00:00.009Z)`);
    });

    it('prefers the lower-case row when two spellings of one key were approved at the same time', () => {
      insertRaw('Legacy-Tie.example.com', pinnedKey, 5, 22, 'upper');
      insertRaw('legacy-tie.example.com', pinnedKey, 5, 22, 'lower');
      migrate();
      expect(db().getNodeBootstrapTrust('legacy-tie.example.com', 22)).toMatchObject({ fingerprint: pinnedKey, approved_by: 'lower' });
    });

    it('keeps the latest sighting when duplicate spellings hold the same key', () => {
      insertRaw('legacy-seen.example.com', pinnedKey, 5);
      db().getDb().prepare('UPDATE node_bootstrap_trust SET last_seen_at = 7 WHERE host = ?').run('legacy-seen.example.com');
      insertRaw('LEGACY-seen.example.com', pinnedKey, 9);
      db().getDb().prepare('UPDATE node_bootstrap_trust SET last_seen_at = 20 WHERE host = ?').run('LEGACY-seen.example.com');
      migrate();
      expect(db().getNodeBootstrapTrust('legacy-seen.example.com', 22)).toMatchObject({ approved_at: 5, last_seen_at: 20 });
    });

    it('runs when the database opens, so a pin stored by an earlier build stays reachable', { timeout: 60_000 }, () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sencho-trust-case-'));
      const previous = process.env.DATA_DIR;
      const open = () => new (DatabaseService as unknown as new () => DatabaseService)();
      try {
        process.env.DATA_DIR = dir;
        const first = open();
        first.getDb().prepare(
          `INSERT INTO node_bootstrap_trust (host, port, fingerprint, algorithm, approved_by, approved_at, last_seen_at)
           VALUES ('Boot-Case.Example.com', 22, ?, 'ssh-ed25519', 'admin', 5, 5)`,
        ).run(pinnedKey);
        for (const [host, fingerprint] of [['Boot-Clash.example.com', pinnedKey], ['boot-clash.example.com', liveKey]]) {
          first.getDb().prepare(
            `INSERT INTO node_bootstrap_trust (host, port, fingerprint, algorithm, approved_by, approved_at, last_seen_at)
             VALUES (?, 22, ?, 'ssh-ed25519', 'admin', 5, 5)`,
          ).run(host, fingerprint);
        }
        first.getDb().close();
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const reopened = open();
        warn.mockRestore();
        expect(reopened.getNodeBootstrapTrust('boot-case.example.com', 22)?.fingerprint).toBe(pinnedKey);
        expect(reopened.getDb().prepare('SELECT host FROM node_bootstrap_trust').all()).toEqual([{ host: 'boot-case.example.com' }]);
        // The conflict row is on disk as soon as the database has opened.
        expect(reopened.getDb().prepare("SELECT summary FROM audit_log WHERE summary LIKE 'bootstrap.trust.conflict: host=boot-clash.example.com:22%'").all()).toHaveLength(1);
        reopened.getDb().close();
      } finally {
        if (previous === undefined) delete process.env.DATA_DIR;
        else process.env.DATA_DIR = previous;
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it('is a no-op once every host is lower case', () => {
      insertRaw('legacy-idem.example.com', pinnedKey, 5);
      migrate();
      migrate();
      expect(rowsFor('legacy-idem.example.com')).toHaveLength(1);
    });
  });
});

describe('bootstrap service cancellation and missing host key', () => {
  const audit = { username: 'admin', ip: '127.0.0.1', method: 'POST', path: '/api/nodes/bootstrap/preflight' };
  const hub = 'https://sencho.example.com';
  const request: BootstrapPreflightRequest = {
    host: 'cancel.example.com',
    port: 22,
    username: 'ubuntu',
    privateKey: '-----BEGIN OPENSSH PRIVATE KEY-----\nnot-a-real-key\n-----END OPENSSH PRIVATE KEY-----',
    expectedFingerprint: 'SHA256:fixturefingerprint000000000000000000000000',
    targetName: 'cancel-server',
    composeDir: '/opt/docker/sencho',
    agentDir: '/opt/sencho-agent',
  };
  const build = (transport: BootstrapTransport, extra: Partial<ConstructorParameters<typeof NodeBootstrapService>[0]> = {}) => (
    new NodeBootstrapService({
      transport,
      db: DatabaseService.getInstance(),
      now: () => 1_762_300_000_000,
      resolveAddresses: async () => ['10.0.0.1', '10.0.0.2'],
      caPem: () => null,
      ...extra,
    })
  );

  it('neither pins a key nor succeeds when the transport never reported one', async () => {
    const host = 'no-key-reported.example.com';
    const transport: BootstrapTransport = {
      captureHostKey: async () => ({ algorithm: 'ssh-ed25519', fingerprint: 'SHA256:x', knownHostsLine: 'line' }),
      runCommands: async (_session, commands) => commands.map((command) => ({
        id: command.id, stdout: '', stderr: '', exitCode: 0, truncated: false, timedOut: false, error: null,
      })),
    };
    await expect(build(transport).preflight({ ...request, host }, { hubUrl: hub, audit }))
      .rejects.toMatchObject({ code: 'HOST_KEY_UNTRUSTED' });
    expect(DatabaseService.getInstance().getNodeBootstrapTrust(host, 22)).toBeUndefined();
  });

  it('stops dialing further addresses once the caller cancelled', async () => {
    const controller = new AbortController();
    const dialed: string[] = [];
    const transport: BootstrapTransport = {
      captureHostKey: async () => ({ algorithm: 'ssh-ed25519', fingerprint: 'SHA256:x', knownHostsLine: 'line' }),
      runCommands: async (session) => {
        dialed.push(session.address);
        controller.abort();
        throw new SshTransportError('SSH_UNREACHABLE', 'The request was cancelled.');
      },
    };
    await expect(build(transport).preflight(
      { ...request, host: 'cancel-loop.example.com' },
      { hubUrl: hub, audit, signal: controller.signal },
    )).rejects.toMatchObject({ code: 'SSH_UNREACHABLE' });
    expect(dialed).toEqual(['10.0.0.1']);
  });

  it('abandons a hung DNS lookup when the caller cancels and releases the target lock', async () => {
    const controller = new AbortController();
    let resolves = 0;
    const transport: BootstrapTransport = {
      captureHostKey: async () => ({ algorithm: 'ssh-ed25519', fingerprint: 'SHA256:x', knownHostsLine: 'line' }),
      runCommands: async (_session, commands, options) => {
        options?.onHostKey?.({ algorithm: 'ssh-ed25519', fingerprint: request.expectedFingerprint as string, knownHostsLine: 'line' });
        return commands.map((command) => ({
          id: command.id, stdout: '', stderr: '', exitCode: 0, truncated: false, timedOut: false, error: null,
        }));
      },
    };
    const svc = build(transport, {
      resolveAddresses: async () => {
        resolves += 1;
        if (resolves === 1) await new Promise(() => {});
        return ['10.0.0.1'];
      },
    });
    const first = svc.preflight({ ...request, host: 'hung-dns.example.com' }, { hubUrl: hub, audit, signal: controller.signal });
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort();
    await expect(first).rejects.toMatchObject({ code: 'SSH_UNREACHABLE' });
    await expect(svc.preflight({ ...request, host: 'hung-dns.example.com' }, { hubUrl: hub, audit })).resolves.toBeDefined();
  });

  it('reports a command timeout that lands on the request deadline as a budget error', async () => {
    const clock = createManualClock(1_762_300_000_000);
    const transport: BootstrapTransport = {
      captureHostKey: async () => ({ algorithm: 'ssh-ed25519', fingerprint: 'SHA256:x', knownHostsLine: 'line' }),
      runCommands: async (_session, commands, options) => {
        options?.onHostKey?.({ algorithm: 'ssh-ed25519', fingerprint: request.expectedFingerprint as string, knownHostsLine: 'line' });
        clock.advance(80);
        return [{ id: commands[0].id, stdout: '', stderr: '', exitCode: null, truncated: false, timedOut: true, error: 'COMMAND_TIMEOUT' }];
      },
    };
    await expect(build(transport, { requestBudgetMs: 60, now: clock.now }).preflight(
      { ...request, host: 'deadline-race.example.com' },
      { hubUrl: hub, audit },
    )).rejects.toMatchObject({ code: 'PREFLIGHT_TIMEOUT' });
  });
});
