import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
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
  type BootstrapTransport,
  type SshCommand,
  type SshCommandResult,
} from '../services/nodeBootstrap/sshProbeClient';

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
    docker_root_disk: '/dev/sda1 1 1 104857600 1% /',
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
        agent: { projectContainers: [], dataVolumeExists: false, defaultDirHasComposeFile: false },
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
        agent: { projectContainers: [], dataVolumeExists: false, defaultDirHasComposeFile: false },
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
      },
      { hubUrl: 'https://sencho.example.com', audit },
    );
    expect(result.blocked).toBe(false);
    expect(db.getNodeBootstrapTrust('replace.example.com', 22)?.fingerprint).toBe('SHA256:fixturefingerprint000000000000000000000000');
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
