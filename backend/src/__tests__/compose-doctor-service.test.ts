/**
 * ComposeDoctorService: orchestration over the renderer, the rule registry, and
 * persistence. Docker (render + snapshot) is mocked; the filesystem and database
 * are real. Covers status derivation, replace-on-run persistence, getLatest, the
 * unrenderable path, node-deletion cleanup, the renderConfig path guard, and the
 * hard guarantee that an environment value never reaches a stored row.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';
import DockerController from '../services/DockerController';
import { ComposeService } from '../services/ComposeService';

const SECRET = 'pw-7Q2x-never-store';

let tmpDir: string;
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;
let ComposeDoctorService: typeof import('../services/ComposeDoctorService').ComposeDoctorService;
let nodeId: number;

function db() { return DatabaseService.getInstance(); }
function doctor() { return ComposeDoctorService.getInstance(); }

/** Mock the two Docker calls; render returns the given effective model JSON.
 *  Pass `'reject'` as the snapshot to simulate an unreachable Docker daemon. */
function stubDocker(
  rendered: object | null,
  stderr = '',
  snapshot: { containers: unknown[]; networks: unknown[]; volumes: unknown[] } | 'reject' = { containers: [], networks: [], volumes: [] },
  inspectImage: ReturnType<typeof vi.fn> = vi.fn().mockRejectedValue(
    Object.assign(new Error('No such image'), { statusCode: 404 }),
  ),
) {
  vi.spyOn(ComposeService, 'getInstance').mockReturnValue({
    renderConfig: vi.fn().mockResolvedValue({
      rendered: rendered === null ? null : JSON.stringify(rendered),
      stderr,
      code: rendered === null ? 1 : 0,
      timedOut: false,
    }),
  } as unknown as ComposeService);
  vi.spyOn(DockerController, 'getInstance').mockReturnValue({
    getDependencySnapshot: snapshot === 'reject'
      ? vi.fn().mockRejectedValue(new Error('docker down'))
      : vi.fn().mockResolvedValue(snapshot),
    getDocker: vi.fn(() => ({
      listContainers: vi.fn().mockResolvedValue([]),
      getContainer: vi.fn(() => ({
        inspect: vi.fn().mockResolvedValue({ Config: {} }),
      })),
    })),
    inspectImage,
  } as unknown as DockerController);
}

function writeStack(stack: string, content = 'services:\n  web:\n    image: nginx:latest\n    ports:\n      - "8080:80"\n') {
  const dir = path.join(process.env.COMPOSE_DIR as string, stack);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'compose.yaml'), content);
  return dir;
}

beforeAll(async () => {
  tmpDir = await setupTestDb();
  await import('../index');
  ({ DatabaseService } = await import('../services/DatabaseService'));
  ({ ComposeDoctorService } = await import('../services/ComposeDoctorService'));
  nodeId = (db().getDb().prepare('SELECT id FROM nodes WHERE is_default = 1').get() as { id: number }).id;
});

afterAll(() => cleanupTestDb(tmpDir));
afterEach(() => vi.restoreAllMocks());

// parseUnsetEnvVars / parseMissingRequiredVars now live in helpers/envVarParse and
// are covered by env-var-parse.test.ts.

describe('ComposeService.renderConfig path guard', () => {
  it('rejects an invalid stack name without spawning docker', async () => {
    await expect(ComposeService.getInstance(nodeId).renderConfig('../escape')).rejects.toThrow('Invalid stack path');
  });
});

describe('runPreflight', () => {
  const STACK = 'doctorrun';
  beforeEach(() => { writeStack(STACK); });
  afterEach(() => { fs.rmSync(path.join(process.env.COMPOSE_DIR as string, STACK), { recursive: true, force: true }); });

  it('derives status from the highest finding and persists the run', async () => {
    stubDocker(
      { name: STACK, services: { web: { image: 'nginx:latest', ports: [{ target: 80, published: '8080', protocol: 'tcp' }], environment: { APP_SECRET: SECRET } } }, networks: {}, volumes: {} },
      'WARN The "MISSING" variable is not set. Defaulting to a blank string.',
    );
    const report = await doctor().runPreflight(nodeId, STACK, 'tester');
    expect(report.renderable).toBe(true);
    expect(report.status).toBe('high'); // env-unset + 0.0.0.0 exposure are high
    expect(report.highestSeverity).toBe('high');
    expect(report.findings.map(f => f.ruleId)).toEqual(expect.arrayContaining(['env-literal-dollar', 'port-exposed-all-interfaces', 'image-latest', 'healthcheck-unverifiable']));
    expect(report.ranBy).toBe('tester');
    expect(report.sourceHash).toBeTruthy();

    // Persisted and retrievable.
    const stored = db().getLatestPreflightRun(nodeId, STACK);
    expect(stored?.status).toBe('high');
    expect(db().getPreflightFindings(stored!.id).length).toBe(report.findings.length);
    const latest = doctor().getLatest(nodeId, STACK);
    expect(latest.findings.length).toBe(report.findings.length);
    expect(latest.ranBy).toBe('tester');
  });

  it('surfaces a missing required env_file as a finding and ignores an optional one', async () => {
    const stack = 'envfilemissing';
    const dir = path.join(process.env.COMPOSE_DIR as string, stack);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'compose.yaml'),
      'services:\n  web:\n    image: nginx:1.27\n    env_file:\n      - ./gone.env\n      - path: ./optional.env\n        required: false\n',
    );
    try {
      stubDocker({ name: stack, services: { web: { image: 'nginx:1.27' } }, networks: {}, volumes: {} }, '');
      const report = await doctor().runPreflight(nodeId, stack, 'tester');
      const envFile = report.findings.filter(f => f.ruleId === 'env-file-missing');
      expect(envFile).toHaveLength(1);
      expect(envFile[0].sourcePath).toBe('./gone.env');
      expect(envFile[0].severity).toBe('high');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('never stores an environment value', async () => {
    stubDocker({ name: STACK, services: { web: { image: 'nginx:1.27', environment: { APP_SECRET: SECRET } } }, networks: {}, volumes: {} });
    const report = await doctor().runPreflight(nodeId, STACK, null);
    const runs = JSON.stringify(db().getDb().prepare('SELECT * FROM preflight_runs').all());
    const findings = JSON.stringify(db().getDb().prepare('SELECT * FROM preflight_findings').all());
    expect(runs).not.toContain(SECRET);
    expect(findings).not.toContain(SECRET);
    expect(JSON.stringify(report)).not.toContain(SECRET);
  });

  it('does not expose hash fragments as unset variable names (#1550)', async () => {
    const stack = 'hashfrag';
    const dir = path.join(process.env.COMPOSE_DIR as string, stack);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'compose.yaml'),
      [
        'services:',
        '  demo:',
        '    image: alpine:3',
        '    environment:',
        '      - EXAMPLE_AUTH_HASH=$2b$10$E6SDEbshpc$vCSrREDACTED',
      ].join('\n'),
    );
    try {
      stubDocker(
        { name: stack, services: { demo: { image: 'alpine:3', environment: { EXAMPLE_AUTH_HASH: '' } } }, networks: {}, volumes: {} },
        'WARN The "E6SDEbshpc" variable is not set. Defaulting to a blank string.\n'
          + 'WARN The "vCSr" variable is not set. Defaulting to a blank string.\n',
      );
      const report = await doctor().runPreflight(nodeId, stack, 'tester');
      const literal = report.findings.filter(f => f.ruleId === 'env-literal-dollar');
      const unset = report.findings.filter(f => f.ruleId === 'env-unset');
      expect(literal.length).toBeGreaterThan(0);
      expect(unset.some(f => f.title.includes('E6SDEbshpc') || f.title.includes('vCSr'))).toBe(false);
      const persisted = JSON.stringify(db().getPreflightFindings(db().getLatestPreflightRun(nodeId, stack)!.id));
      expect(persisted).not.toContain('E6SDEbshpc');
      expect(persisted).not.toContain('vCSr');
      expect(literal[0].title).toContain('likely secret');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('replaces the prior run rather than accumulating', async () => {
    stubDocker({ name: STACK, services: { web: { image: 'nginx:latest' } }, networks: {}, volumes: {} });
    await doctor().runPreflight(nodeId, STACK, null);
    vi.restoreAllMocks();
    stubDocker({ name: STACK, services: { web: { image: 'nginx:1.27', restart: 'always', healthcheck: { test: ['CMD', 'true'] } } }, networks: {}, volumes: {} });
    await doctor().runPreflight(nodeId, STACK, null);
    const allRuns = db().getDb().prepare('SELECT * FROM preflight_runs WHERE node_id = ? AND stack_name = ?').all(nodeId, STACK);
    expect(allRuns).toHaveLength(1);
    expect(doctor().getLatest(nodeId, STACK).status).toBe('pass');
  });

  it('treats inherited healthcheck as a note that does not block All Clear', async () => {
    const model = {
      name: STACK,
      services: { web: { image: 'nginx:1.27', restart: 'always' } },
      networks: {},
      volumes: {},
    };
    stubDocker(
      model,
      '',
      { containers: [], networks: [], volumes: [] },
      vi.fn().mockResolvedValue({
        inspect: { Config: { Healthcheck: { Test: ['CMD', 'true'] } } },
        history: [],
      }),
    );

    const report = await doctor().runPreflight(nodeId, STACK, 'tester');
    expect(report.findings.some(f => f.ruleId === 'healthcheck-inherited')).toBe(true);
    expect(report.activeCount).toBe(0);
    expect(report.activeStatus).toBe('pass');
    expect(report.status).toBe('pass');
  });

  it('classifies a safe socket proxy as info instead of a high socket mount', async () => {
    stubDocker({
      name: STACK,
      services: {
        proxy: {
          image: 'lscr.io/linuxserver/socket-proxy:v1',
          restart: 'unless-stopped',
          healthcheck: { test: ['CMD', 'true'] },
          volumes: [{
            type: 'bind',
            source: '/var/run/docker.sock',
            target: '/var/run/docker.sock',
            read_only: true,
          }],
          environment: { CONTAINERS: '1', IMAGES: '1' },
          networks: { app_internal: null },
        },
      },
      networks: { app_internal: { name: `${STACK}_app_internal`, internal: true } },
      volumes: {},
    });
    const report = await doctor().runPreflight(nodeId, STACK, 'tester');
    expect(report.findings.some(f => f.ruleId === 'docker-socket-mount')).toBe(false);
    expect(report.findings.some(f => f.ruleId === 'docker-socket-proxy')).toBe(true);
    expect(report.activeStatus).toBe('info');
    expect(report.activeHighestSeverity).toBe('info');
  });

  it('keeps a direct application socket mount as high', async () => {
    stubDocker({
      name: STACK,
      services: {
        app: {
          image: 'portainer/portainer-ce:2.19.0',
          restart: 'unless-stopped',
          healthcheck: { test: ['CMD', 'true'] },
          volumes: [{
            type: 'bind',
            source: '/var/run/docker.sock',
            target: '/var/run/docker.sock',
          }],
        },
      },
      networks: {},
      volumes: {},
    });
    const report = await doctor().runPreflight(nodeId, STACK, 'tester');
    expect(report.findings.some(f => f.ruleId === 'docker-socket-mount')).toBe(true);
    expect(report.activeStatus).toBe('high');
  });

  it('excludes the socket-proxy client note from active severity while keeping proxy info', async () => {
    stubDocker({
      name: STACK,
      services: {
        proxy: {
          image: 'tecnativa/docker-socket-proxy:v0.1',
          restart: 'unless-stopped',
          healthcheck: { test: ['CMD', 'true'] },
          volumes: [{
            type: 'bind',
            source: '/var/run/docker.sock',
            target: '/var/run/docker.sock',
            read_only: true,
          }],
          environment: { CONTAINERS: '1' },
          networks: { app_internal: null },
        },
        app: {
          image: 'myapp:1.0',
          restart: 'unless-stopped',
          healthcheck: { test: ['CMD', 'true'] },
          environment: { DOCKER_HOST: 'tcp://proxy:2375' },
          networks: { app_internal: null },
        },
      },
      networks: { app_internal: { name: `${STACK}_app_internal`, internal: true } },
      volumes: {},
    });
    const report = await doctor().runPreflight(nodeId, STACK, 'tester');
    expect(report.findings.some(f => f.ruleId === 'docker-socket-proxy-client')).toBe(true);
    expect(report.findings.some(f => f.ruleId === 'docker-socket-proxy')).toBe(true);
    expect(report.activeStatus).toBe('info');
    const issueCount = report.findings.filter(f => f.ruleId !== 'docker-socket-proxy-client').length;
    expect(report.activeCount).toBe(issueCount);
    expect(JSON.stringify(report)).not.toContain('tcp://proxy:2375');
  });

  it('returns an unrenderable report and never stores raw stderr', async () => {
    stubDocker(null, `bad yaml near ${SECRET}`); // stderr can echo arbitrary file content
    const report = await doctor().runPreflight(nodeId, STACK, null);
    expect(report.renderable).toBe(false);
    expect(report.status).toBe('unrenderable');
    expect(report.findings.map(f => f.ruleId)).toEqual(['render-failed']);
    // Raw stderr is never surfaced, so an arbitrary secret in it cannot leak.
    expect(report.renderError).not.toContain(SECRET);
    expect(report.renderError).not.toContain('bad yaml');
    const findings = JSON.stringify(db().getDb().prepare('SELECT * FROM preflight_findings').all());
    expect(findings).not.toContain(SECRET);
  });

  it('names a missing required variable in the render error without echoing the value', async () => {
    stubDocker(null, `required variable "DB_PASS" is missing a value: ${SECRET}`);
    const report = await doctor().runPreflight(nodeId, STACK, null);
    expect(report.renderError).toContain('DB_PASS');
    expect(report.renderError).not.toContain(SECRET);
  });

  it('getLatest round-trips an unrenderable run from the database', async () => {
    stubDocker(null, 'boom');
    await doctor().runPreflight(nodeId, STACK, null);
    vi.restoreAllMocks(); // getLatest is a pure DB read; no docker needed
    const latest = doctor().getLatest(nodeId, STACK);
    expect(latest.renderable).toBe(false);
    expect(latest.status).toBe('unrenderable');
    expect(latest.renderError).toBeTruthy();
    expect(latest.findings.map(f => f.ruleId)).toEqual(['render-failed']);
  });

  it('degrades to model-only findings when the node snapshot fails', async () => {
    stubDocker({ name: STACK, services: { web: { image: 'nginx:latest' } }, networks: {}, volumes: {} }, '', 'reject');
    const report = await doctor().runPreflight(nodeId, STACK, null);
    expect(report.renderable).toBe(true);
    expect(report.findings.map(f => f.ruleId)).toContain('image-latest'); // model rule still ran
    expect(report.findings.map(f => f.ruleId)).not.toContain('port-conflict-node'); // node-state skipped
    expect(report.findings.map(f => f.ruleId)).toContain('node-state-unavailable'); // partial coverage is surfaced
  });

  it('does not flag external resources as missing when the snapshot is unavailable', async () => {
    stubDocker(
      {
        name: STACK,
        services: { web: { image: 'nginx:1.27', restart: 'always', healthcheck: { test: ['CMD', 'true'] } } },
        networks: { ext: { name: 'shared', external: true } },
        volumes: { v: { name: 'data', external: true } },
      },
      '',
      'reject',
    );
    const report = await doctor().runPreflight(nodeId, STACK, null);
    expect(report.renderable).toBe(true);
    const ruleIds = report.findings.map(f => f.ruleId);
    // An empty snapshot must not be read as "the external resource is absent".
    expect(ruleIds).not.toContain('external-network-missing');
    expect(ruleIds).not.toContain('external-volume-missing');
    expect(ruleIds).toContain('node-state-unavailable');
  });

  it('marks the run partial (info) when only node state is unavailable', async () => {
    stubDocker({ name: STACK, services: { web: { image: 'nginx:1.27', restart: 'always', healthcheck: { test: ['CMD', 'true'] } } }, networks: {}, volumes: {} }, '', 'reject');
    const report = await doctor().runPreflight(nodeId, STACK, null);
    // A clean model with the daemon down yields only the advisory, so the clean
    // 'pass' becomes 'info': the operator sees the result is partial.
    expect(report.findings.map(f => f.ruleId)).toEqual(['node-state-unavailable']);
    expect(report.status).toBe('info');
    expect(report.highestSeverity).toBe('info');
  });

  it('runs node-state rules against a collected snapshot', async () => {
    stubDocker(
      { name: STACK, services: { web: { image: 'nginx:1.27', container_name: 'dup', restart: 'always', healthcheck: { test: ['CMD', 'true'] } } }, networks: {}, volumes: {} },
      '',
      { containers: [{ name: 'dup', stack: 'other', ports: [] }], networks: [], volumes: [] },
    );
    const report = await doctor().runPreflight(nodeId, STACK, null);
    const ruleIds = report.findings.map(f => f.ruleId);
    // A successful snapshot sets nodeStateAvailable true, so the node-state rule runs.
    expect(ruleIds).toContain('container-name-collision');
    expect(ruleIds).not.toContain('node-state-unavailable');
  });

  it('orders findings by severity, highest first', async () => {
    stubDocker({
      name: STACK,
      services: {
        a: { image: 'nginx:latest', ports: [{ target: 80, published: '8080', protocol: 'tcp' }], container_name: 'dup' },
        b: { image: 'nginx:1.27', container_name: 'dup', restart: 'always', healthcheck: { test: ['CMD', 'x'] } },
      },
      networks: {}, volumes: {},
    });
    const r = await doctor().runPreflight(nodeId, STACK, null);
    const rank = { blocker: 3, high: 2, warning: 1, info: 0 } as const;
    const ranks = r.findings.map(f => rank[f.severity]);
    expect(ranks).toEqual([...ranks].sort((x, y) => y - x)); // non-increasing
    expect(r.findings[0].severity).toBe('blocker'); // duplicate container_name
  });
});

describe('getLatest', () => {
  it('returns a never-run sentinel before any run', () => {
    const r = doctor().getLatest(nodeId, 'nostackyet');
    expect(r.status).toBe('never-run');
    expect(r.ranAt).toBeNull();
    expect(r.findings).toEqual([]);
  });
});

describe('preflight acknowledgements', () => {
  const STACK = 'doctorack';
  beforeEach(() => { writeStack(STACK); });
  afterEach(() => { fs.rmSync(path.join(process.env.COMPOSE_DIR as string, STACK), { recursive: true, force: true }); });

  it('lowers activeStatus when a finding is acknowledged', async () => {
    stubDocker(
      { name: STACK, services: { web: { image: 'nginx:latest', ports: [{ target: 80, published: '8080', protocol: 'tcp' }] } }, networks: {}, volumes: {} },
    );
    const report = await doctor().runPreflight(nodeId, STACK, 'tester');
    expect(report.status).toBe('high');
    const target = report.findings.find(f => f.ruleId === 'port-exposed-all-interfaces');
    expect(target).toBeTruthy();
    db().upsertPreflightAcknowledgement({
      node_id: nodeId,
      stack_name: STACK,
      rule_id: target!.ruleId,
      service: target!.service ?? null,
      reason: 'intentional',
      expiry_mode: 'forever',
      expires_at: null,
      anchor_rendered_hash: null,
      anchor_image_ref: null,
      created_by: 'tester',
      created_at: Date.now(),
    });
    const latest = doctor().getLatest(nodeId, STACK);
    expect(latest.acknowledgedCount).toBe(1);
    expect(latest.activeCount).toBe(latest.findings.length - 1);
    expect(latest.status).toBe('high');
    expect(latest.activeStatus).not.toBe('high');
  });
});

describe('node deletion cleanup', () => {
  it('removes preflight runs and findings for a deleted node', () => {
    const ghostNode = 987654;
    db().replacePreflightRun(
      { id: 'run-x', node_id: ghostNode, stack_name: 's', source_hash: null, rendered_hash: null, service_images: null, status: 'pass', highest_severity: null, created_at: 1, created_by: null },
      [{ id: 'find-x', run_id: 'run-x', rule_id: 'privileged', severity: 'high', title: 't', message: 'm', source_path: null, remediation: null, service: 's', created_at: 1 }],
    );
    expect(db().getLatestPreflightRun(ghostNode, 's')).toBeDefined();
    db().deleteNode(ghostNode);
    expect(db().getLatestPreflightRun(ghostNode, 's')).toBeUndefined();
    expect(db().getPreflightFindings('run-x')).toEqual([]);
  });
});

describe('exposure state feeds the exposure rules end to end', () => {
  const ruleIds = (stack: string) => doctor().getLatest(nodeId, stack).findings.map(f => f.ruleId);

  afterEach(() => {
    db().deleteStackExposureIntents(nodeId, 'expe2e');
    db().deleteStackDossier(nodeId, 'expe2e');
    fs.rmSync(path.join(process.env.COMPOSE_DIR as string, 'expe2e'), { recursive: true, force: true });
  });

  it('fires exposure-internal-published from a stored stack intent', async () => {
    writeStack('expe2e');
    db().setStackExposureIntent(nodeId, 'expe2e', '', 'internal', 'tester');
    stubDocker({ name: 'expe2e', services: { web: { image: 'nginx:latest', ports: [{ target: 80, published: '8080', protocol: 'tcp' }] } }, networks: {}, volumes: {} });
    await doctor().runPreflight(nodeId, 'expe2e', 'tester');
    expect(ruleIds('expe2e')).toContain('exposure-internal-published');
  });

  it('fires exposure-port-vs-dossier from the dossier access URLs', async () => {
    writeStack('expe2e');
    db().upsertStackDossier(nodeId, 'expe2e', {
      purpose: '', owner: '', access_urls: 'https://app.example.com:443', static_ip: '', vlan: '',
      firewall_notes: '', reverse_proxy_notes: '', backup_notes: '', upgrade_notes: '', recovery_notes: '', custom_notes: '',
    });
    stubDocker({ name: 'expe2e', services: { web: { image: 'nginx:latest', ports: [{ target: 80, published: '8080', protocol: 'tcp' }] } }, networks: {}, volumes: {} });
    await doctor().runPreflight(nodeId, 'expe2e', 'tester');
    expect(ruleIds('expe2e')).toContain('exposure-port-vs-dossier');
  });
});
