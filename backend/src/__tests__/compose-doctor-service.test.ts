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

/**
 * Toggle for an env-context failure. The service imports the resolver directly,
 * so the only way to make that one collection step fail is to wrap the module;
 * the wrapper delegates unless this flag is set, and tests reset it in a
 * `finally`.
 */
const envSourceFailure = vi.hoisted(() => ({
  fail: false,
  /** Rewrites the resolved sources, to stand in for a file whose existence cannot be checked. */
  rewrite: null as null | ((sources: unknown) => unknown),
}));
vi.mock('../helpers/envFileResolution', async (importOriginal) => {
  const original = await importOriginal<typeof import('../helpers/envFileResolution')>();
  return {
    ...original,
    resolveStackEnvSources: async (...args: Parameters<typeof original.resolveStackEnvSources>) => {
      if (envSourceFailure.fail) throw new Error('env sources unreadable');
      const sources = await original.resolveStackEnvSources(...args);
      return (envSourceFailure.rewrite ? envSourceFailure.rewrite(sources) : sources) as typeof sources;
    },
  };
});

/**
 * Extra rule hits appended to a run, to stand in for a rule that emits several
 * hits for one service without a subject. Tests clear it in a `finally`.
 */
const injectedHits = vi.hoisted(() => ({ extra: [] as unknown[] }));
vi.mock('../services/assurance/coverage', async (importOriginal) => {
  const original = await importOriginal<typeof import('../services/assurance/coverage')>();
  return {
    ...original,
    runAssuranceRules: (...args: Parameters<typeof original.runAssuranceRules>) => {
      const run = original.runAssuranceRules(...args);
      return { ...run, findings: [...run.findings, ...(injectedHits.extra as typeof run.findings)] };
    },
  };
});

const SECRET = 'pw-7Q2x-never-store';

let tmpDir: string;
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;
let ComposeDoctorService: typeof import('../services/ComposeDoctorService').ComposeDoctorService;
let nodeId: number;

function db() { return DatabaseService.getInstance(); }
function doctor() { return ComposeDoctorService.getInstance(); }

/** Mock the two Docker calls; render returns the given effective model JSON.
 *  Pass `'reject'` as the snapshot to simulate an unreachable Docker daemon.
 *  `listed` is what the container list returns (the Compose version check reads
 *  it), and `composeVersion` is what `docker compose version --short` answers. */
function stubDocker(
  rendered: object | null,
  stderr = '',
  snapshot: { containers: unknown[]; networks: unknown[]; volumes: unknown[] } | 'reject' = { containers: [], networks: [], volumes: [] },
  inspectImage: ReturnType<typeof vi.fn> = vi.fn().mockRejectedValue(
    Object.assign(new Error('No such image'), { statusCode: 404 }),
  ),
  listed: unknown[] = [],
  composeVersion: string | null = null,
) {
  vi.spyOn(ComposeService, 'getInstance').mockReturnValue({
    renderConfig: vi.fn().mockResolvedValue({
      rendered: rendered === null ? null : JSON.stringify(rendered),
      stderr,
      code: rendered === null ? 1 : 0,
      timedOut: false,
    }),
    composeVersion: vi.fn().mockResolvedValue(composeVersion),
  } as unknown as ComposeService);
  vi.spyOn(DockerController, 'getInstance').mockReturnValue({
    getDependencySnapshot: snapshot === 'reject'
      ? vi.fn().mockRejectedValue(new Error('docker down'))
      : vi.fn().mockResolvedValue(snapshot),
    getDocker: vi.fn(() => ({
      listContainers: vi.fn().mockResolvedValue(listed),
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

  it('carries the stack\'s Mesh opt-in into the tunnel connector note', async () => {
    const model = {
      name: STACK,
      services: {
        cloudflared: { image: 'cloudflare/cloudflared:2024.10.0', networks: { default: null } },
        app: { image: 'example/app:1.0', networks: { default: null } },
      },
      networks: { default: { name: `${STACK}_default` } },
      volumes: {},
    };
    const noteFor = async (meshEnabled: boolean) => {
      stubDocker(model);
      vi.spyOn(db(), 'isMeshStackEnabled').mockReturnValue(meshEnabled);
      const report = await doctor().runPreflight(nodeId, STACK, 'tester');
      vi.restoreAllMocks();
      return report.findings.find(f => f.ruleId === 'tunnel-exposure')?.message ?? '';
    };
    expect(await noteFor(true)).toContain('It is also on the Sencho Mesh network');
    expect(await noteFor(false)).not.toContain('Sencho Mesh');
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
    expect(r.coverage.state).toBe('unrecorded');
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

  describe('on a fresh run', () => {
    const ack = (over: Record<string, unknown>) => ({
      node_id: nodeId, stack_name: STACK, rule_id: 'port-exposed-all-interfaces', service: 'web', reason: 'intentional',
      expiry_mode: 'forever' as const, expires_at: null, anchor_rendered_hash: null, anchor_image_ref: null,
      created_by: 'tester', created_at: Date.now(), ...over,
    });
    const model = (image: string) => ({
      name: STACK,
      services: { web: { image, ports: [{ target: 80, published: '8080', protocol: 'tcp' }], restart: 'always', healthcheck: { test: ['CMD', 'x'] } } },
      networks: {}, volumes: {},
    });
    afterEach(() => {
      db().getDb().prepare('DELETE FROM preflight_acknowledgements WHERE node_id = ? AND stack_name = ?').run(nodeId, STACK);
    });

    it('returns the same decisions as a later read of the stored run', async () => {
      stubDocker(model('nginx:1.27'));
      await doctor().runPreflight(nodeId, STACK, 'tester');
      db().upsertPreflightAcknowledgement(ack({ reason: 'Bind publicly on purpose' }));
      const fresh = await doctor().runPreflight(nodeId, STACK, 'tester');
      expect(fresh.acknowledgedCount).toBe(1);
      expect(fresh.findings.filter(finding => finding.acknowledged).map(finding => finding.ruleId))
        .toEqual(['port-exposed-all-interfaces']);
      const stored = doctor().getLatest(nodeId, STACK);
      expect(stored.findings).toEqual(fresh.findings);
      expect(stored.activeStatus).toBe(fresh.activeStatus);
      expect(stored.activeCount).toBe(fresh.activeCount);
    });

    it('applies a time-boxed acknowledgement on a fresh run only while it is live', async () => {
      stubDocker(model('nginx:1.27'));
      db().upsertPreflightAcknowledgement(ack({ expiry_mode: 'days', expires_at: Date.now() - 1000 }));
      expect((await doctor().runPreflight(nodeId, STACK, 'tester')).acknowledgedCount).toBe(0);
      db().upsertPreflightAcknowledgement(ack({ expiry_mode: 'days', expires_at: Date.now() + 3_600_000 }));
      const live = await doctor().runPreflight(nodeId, STACK, 'tester');
      expect(live.acknowledgedCount).toBe(1);
      expect(live.findings.find(finding => finding.acknowledged)?.acknowledgementExpiry).toBe('days');
    });

    it('reads the compose hash of this run, not of the last stored one, when the run cannot be stored', async () => {
      stubDocker(model('nginx:1.27'));
      const first = await doctor().runPreflight(nodeId, STACK, 'tester');
      db().upsertPreflightAcknowledgement(ack({ expiry_mode: 'until_compose_change', anchor_rendered_hash: first.renderedHash }));
      expect((await doctor().runPreflight(nodeId, STACK, 'tester')).acknowledgedCount).toBe(1);

      // The file changed and storing the new run fails: the stored run still holds
      // the anchored hash, which must not keep the acknowledgement alive.
      writeStack(STACK, 'services:\n  web:\n    image: nginx:latest\n    ports:\n      - "9090:80"\n');
      vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.spyOn(db(), 'replacePreflightRun').mockImplementation(() => { throw new Error('disk full'); });
      const changed = await doctor().runPreflight(nodeId, STACK, 'tester');
      expect(changed.renderedHash).not.toBe(first.renderedHash);
      expect(changed.acknowledgedCount).toBe(0);
    });

    it('does not apply a compose-anchored acknowledgement when the source cannot be read', async () => {
      stubDocker(model('nginx:1.27'));
      // The stored run holds the anchored hash; an unreadable source must not
      // fall back to it.
      const first = await doctor().runPreflight(nodeId, STACK, 'tester');
      db().upsertPreflightAcknowledgement(ack({ expiry_mode: 'until_compose_change', anchor_rendered_hash: first.renderedHash }));
      expect((await doctor().runPreflight(nodeId, STACK, 'tester')).acknowledgedCount).toBe(1);
      fs.rmSync(path.join(process.env.COMPOSE_DIR as string, STACK, 'compose.yaml'));
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const fresh = await doctor().runPreflight(nodeId, STACK, 'tester');
      expect(fresh.renderedHash).toBeNull();
      expect(fresh.acknowledgedCount).toBe(0);
    });

    it('reads the images of this run, not of the last stored one, when the run cannot be stored', async () => {
      stubDocker(model('nginx:1.27'));
      await doctor().runPreflight(nodeId, STACK, 'tester');
      db().upsertPreflightAcknowledgement(ack({ expiry_mode: 'until_image_change', anchor_image_ref: 'nginx:1.27' }));
      expect(doctor().getLatest(nodeId, STACK).acknowledgedCount).toBe(1);

      // The image changed, and storing the new run fails: the stored run still
      // records the old image, which must not keep the acknowledgement alive.
      vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.spyOn(db(), 'replacePreflightRun').mockImplementation(() => { throw new Error('disk full'); });
      stubDocker(model('nginx:1.28'));
      const fresh = await doctor().runPreflight(nodeId, STACK, 'tester');
      expect(fresh.acknowledgedCount).toBe(0);
      expect(fresh.findings.find(finding => finding.ruleId === 'port-exposed-all-interfaces')?.acknowledged).toBe(false);
    });
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

describe('Compose version mismatch note', () => {
  const STACK = 'skewrun';
  // A model with no rule findings of its own, so the only difference between
  // the baseline run and the skew run is the note under test.
  const cleanModel = () => ({
    name: STACK,
    services: {
      proxy: { image: 'nginx:1.27', restart: 'unless-stopped', healthcheck: { test: ['CMD', 'true'] } },
      web: { image: 'nginx:1.27', restart: 'unless-stopped', healthcheck: { test: ['CMD', 'true'] } },
    },
    networks: {},
    volumes: {},
  });
  const label = (service: string, version: string, over: Record<string, string> = {}) => ({
    Id: `${service}-${version}`,
    Labels: {
      'com.docker.compose.project': STACK,
      'com.docker.compose.service': service,
      'com.docker.compose.version': version,
      ...over,
    },
  });

  beforeEach(() => { writeStack(STACK); });
  afterEach(() => { fs.rmSync(path.join(process.env.COMPOSE_DIR as string, STACK), { recursive: true, force: true }); });

  it('notes every service created by another version without changing the report status', async () => {
    stubDocker(cleanModel());
    const baseline = await doctor().runPreflight(nodeId, STACK, 'tester');

    stubDocker(cleanModel(), '', { containers: [], networks: [], volumes: [] }, undefined, [
      label('proxy', '2.38.1'),
      label('web', '2.38.1'),
    ], '5.6.0');
    const report = await doctor().runPreflight(nodeId, STACK, 'tester');

    const note = report.findings.filter(f => f.ruleId === 'compose-version-mismatch');
    expect(note).toHaveLength(1);
    expect(note[0].severity).toBe('info');
    expect(note[0].message).toContain('proxy and web were created by Docker Compose 2.38.1');
    expect(note[0].message).toContain('Docker Compose 5.6.0');
    // A note never moves All Clear or the stored severity.
    expect(report.status).toBe(baseline.status);
    expect(report.highestSeverity).toBe(baseline.highestSeverity);
    expect(report.activeStatus).toBe(baseline.activeStatus);
  });

  it('matches a stack container by its working directory when the project label differs', async () => {
    stubDocker(cleanModel(), '', { containers: [], networks: [], volumes: [] }, undefined, [{
      Id: 'wd-1',
      Labels: {
        'com.docker.compose.project': 'some-other-project-name',
        'com.docker.compose.project.working_dir': path.join(process.env.COMPOSE_DIR as string, STACK),
        'com.docker.compose.service': 'web',
        'com.docker.compose.version': '2.38.1',
      },
    }], '5.6.0');
    const report = await doctor().runPreflight(nodeId, STACK, 'tester');
    const note = report.findings.find(f => f.ruleId === 'compose-version-mismatch');
    expect(note?.message).toContain('web was created by Docker Compose 2.38.1');
  });

  it('writes no note when the running version cannot be read, and still completes', async () => {
    stubDocker(cleanModel(), '', { containers: [], networks: [], volumes: [] }, undefined, [label('web', '2.38.1')], null);
    const report = await doctor().runPreflight(nodeId, STACK, 'tester');
    expect(report.findings.some(f => f.ruleId === 'compose-version-mismatch')).toBe(false);
  });

  it('writes no note and logs when the container list fails, and still completes', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(ComposeService, 'getInstance').mockReturnValue({
      renderConfig: vi.fn().mockResolvedValue({ rendered: JSON.stringify(cleanModel()), stderr: '', code: 0, timedOut: false }),
      composeVersion: vi.fn().mockResolvedValue('5.6.0'),
    } as unknown as ComposeService);
    vi.spyOn(DockerController, 'getInstance').mockReturnValue({
      getDependencySnapshot: vi.fn().mockResolvedValue({ containers: [], networks: [], volumes: [] }),
      getDocker: vi.fn(() => ({
        listContainers: vi.fn().mockRejectedValue(new Error('docker gone')),
        getContainer: vi.fn(() => ({ inspect: vi.fn().mockResolvedValue({ Config: {} }) })),
      })),
      inspectImage: vi.fn(),
    } as unknown as DockerController);

    const report = await doctor().runPreflight(nodeId, STACK, 'tester');
    expect(report.renderable).toBe(true);
    expect(report.findings.some(f => f.ruleId === 'compose-version-mismatch')).toBe(false);
    expect(warn.mock.calls.some(call => String(call[0]).includes('Compose version check unavailable'))).toBe(true);
  });

  it('writes no note and logs when the version probe fails, and still completes', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(ComposeService, 'getInstance').mockReturnValue({
      renderConfig: vi.fn().mockResolvedValue({ rendered: JSON.stringify(cleanModel()), stderr: '', code: 0, timedOut: false }),
      composeVersion: vi.fn().mockRejectedValue(new Error('compose hung')),
    } as unknown as ComposeService);
    vi.spyOn(DockerController, 'getInstance').mockReturnValue({
      getDependencySnapshot: vi.fn().mockResolvedValue({ containers: [], networks: [], volumes: [] }),
      getDocker: vi.fn(() => ({
        listContainers: vi.fn().mockResolvedValue([label('web', '2.38.1')]),
        getContainer: vi.fn(() => ({ inspect: vi.fn().mockResolvedValue({ Config: {} }) })),
      })),
      inspectImage: vi.fn(),
    } as unknown as DockerController);

    const report = await doctor().runPreflight(nodeId, STACK, 'tester');
    expect(report.renderable).toBe(true);
    expect(report.findings.some(f => f.ruleId === 'compose-version-mismatch')).toBe(false);
    expect(warn.mock.calls.some(call => String(call[0]).includes('Compose version check unavailable'))).toBe(true);
  });
});

describe('Compose Assurance contract persistence', () => {
  const STACK = 'assurance-run';
  const cleanModel = () => ({
    name: STACK,
    services: {
      web: { image: 'nginx:1.27', restart: 'unless-stopped', healthcheck: { test: ['CMD', 'true'] } },
    },
    networks: {},
    volumes: {},
  });

  beforeEach(() => { writeStack(STACK); });
  afterEach(() => {
    envSourceFailure.fail = false;
    envSourceFailure.rewrite = null;
    db().setStackProjectEnvFiles(nodeId, STACK, []);
    fs.rmSync(path.join(process.env.COMPOSE_DIR as string, STACK), { recursive: true, force: true });
    db().replacePreflightRun(
      { id: 'cleanup', node_id: nodeId, stack_name: 'assurance-legacy', source_hash: null, rendered_hash: null, service_images: null, status: 'pass', highest_severity: null, created_at: 1, created_by: null },
      [],
    );
    db().deleteNode(987655);
  });

  it('persists rule versions, subjects, and coverage', async () => {
    stubDocker(cleanModel());
    const report = await doctor().runPreflight(nodeId, STACK, 'tester');
    expect(report.coverage.state).toBe('complete');

    const run = db().getLatestPreflightRun(nodeId, STACK);
    expect(run?.coverage).toBeTruthy();
    const stored = JSON.parse(run!.coverage!) as { state: string; evaluated: number };
    expect(stored.state).toBe('complete');
    expect(stored.evaluated).toBeGreaterThan(0);

    const rows = db().getPreflightFindings(run!.id);
    for (const row of rows) {
      expect(row.rule_version).not.toBeNull();
      expect(typeof row.subject_kind).toBe('string');
      expect(typeof row.subject_key).toBe('string');
    }
    const normalized = doctor().getLatestAssurance(nodeId, STACK);
    expect(normalized.coverage.state).toBe('complete');
    expect(normalized.findings.every(finding => finding.identity.basis === 'structured')).toBe(true);
  });

  it('reads a legacy row as unrecorded coverage, a legacy identity, and redacted text', () => {
    const legacy = 'assurance-legacy';
    db().replacePreflightRun(
      { id: 'legacy-run', node_id: nodeId, stack_name: legacy, source_hash: null, rendered_hash: null, service_images: null, status: 'high', highest_severity: 'high', created_at: 2, created_by: 'tester' },
      [{
        id: 'legacy-finding',
        run_id: 'legacy-run',
        rule_id: 'privileged',
        severity: 'high',
        title: 'Privileged container',
        message: 'The stack references https://user:pass@host/x.env',
        source_path: 'https://user:pass@host/x.env',
        remediation: null,
        service: 'web',
        created_at: 2,
      }],
    );

    const report = doctor().getLatest(nodeId, legacy);
    expect(report.coverage.state).toBe('unrecorded');
    expect(report.findings[0].message).not.toContain('user:pass');
    expect(report.findings[0].sourcePath).not.toContain('user:pass');

    const normalized = doctor().getLatestAssurance(nodeId, legacy);
    expect(normalized.coverage.state).toBe('unrecorded');
    expect(normalized.findings[0].identity.basis).toBe('legacy');
    expect(normalized.findings[0].ruleVersion).toBeNull();
  });

  it('does not throw on a stored rule id that is no longer registered', () => {
    const legacy = 'assurance-retired';
    db().replacePreflightRun(
      { id: 'retired-run', node_id: nodeId, stack_name: legacy, source_hash: null, rendered_hash: null, service_images: null, status: 'warning', highest_severity: 'warning', created_at: 2, created_by: 'tester', coverage: null },
      [{
        id: 'retired-finding', run_id: 'retired-run', rule_id: 'a-retired-rule', severity: 'warning',
        title: 'Old rule', message: 'Old message', source_path: null, remediation: null, service: null,
        created_at: 2, rule_version: null, subject_kind: null, subject_key: null,
      }],
    );
    const normalized = doctor().getLatestAssurance(nodeId, legacy);
    expect(normalized.findings[0].ruleId).toBe('a-retired-rule');
    expect(normalized.findings[0].findingClass).toBe('information');
    expect(normalized.findings[0].ruleVersion).toBeNull();
  });

  describe('acknowledgement decisions on normalized findings', () => {
    const stack = 'assurance-acks';
    const row = (id: string, ruleId: string, severity: string, service: string) => ({
      id, run_id: 'ack-run', rule_id: ruleId, severity, title: ruleId, message: 'm',
      source_path: null, remediation: null, service, created_at: 2,
      rule_version: 1, subject_kind: 'service', subject_key: service,
    });
    const ack = (ruleId: string, service: string | null, over: Record<string, unknown> = {}) => ({
      node_id: nodeId, stack_name: stack, rule_id: ruleId, service, reason: `${ruleId} ${service ?? 'any'}`,
      expiry_mode: 'forever' as const, expires_at: null, anchor_rendered_hash: null, anchor_image_ref: null,
      created_by: 'tester', created_at: Date.now(), ...over,
    });
    const decidedPairs = () => doctor().getLatestAssurance(nodeId, stack).findings
      .filter(finding => finding.decision)
      .map(finding => [finding.ruleId, finding.scope.service, finding.decision?.expiry.mode]);

    beforeEach(() => {
      // Stored in an order that differs from the severity-then-registry order the
      // read path returns.
      db().replacePreflightRun(
        { id: 'ack-run', node_id: nodeId, stack_name: stack, source_hash: null, rendered_hash: 'hash-1', service_images: null, status: 'high', highest_severity: 'high', created_at: 2, created_by: 'tester', coverage: null },
        [
          row('f-web', 'privileged', 'high', 'web'),
          row('f-info', 'healthcheck-inherited', 'info', 'db'),
          row('f-db', 'privileged', 'high', 'db'),
          row('f-warn', 'no-restart-policy', 'warning', 'web'),
        ],
      );
    });
    afterEach(() => {
      db().getDb().prepare('DELETE FROM preflight_acknowledgements WHERE node_id = ? AND stack_name = ?').run(nodeId, stack);
      db().replacePreflightRun(
        { id: 'cleanup-acks', node_id: nodeId, stack_name: stack, source_hash: null, rendered_hash: null, service_images: null, status: 'pass', highest_severity: null, created_at: 1, created_by: null },
        [],
      );
    });

    it('attaches a decision only to the finding it was matched for', () => {
      db().upsertPreflightAcknowledgement(ack('privileged', 'db'));
      const { findings } = doctor().getLatestAssurance(nodeId, stack);
      expect(findings).toHaveLength(4);
      expect(decidedPairs()).toEqual([['privileged', 'db', 'forever']]);
      expect(findings.find(finding => finding.decision)?.decision?.reason).toBe('privileged db');
      // The wire report agrees finding for finding.
      expect(doctor().getLatest(nodeId, stack).findings.filter(finding => finding.acknowledged)
        .map(finding => [finding.ruleId, finding.service])).toEqual([['privileged', 'db']]);
    });

    it('applies a stack-wide acknowledgement anchored to the stored rendered hash', () => {
      db().upsertPreflightAcknowledgement(ack('no-restart-policy', null, { expiry_mode: 'until_compose_change', anchor_rendered_hash: 'hash-1' }));
      expect(decidedPairs()).toEqual([['no-restart-policy', 'web', 'until_compose_change']]);
      // An anchor from a different Compose version no longer applies.
      db().upsertPreflightAcknowledgement(ack('no-restart-policy', null, { expiry_mode: 'until_compose_change', anchor_rendered_hash: 'hash-0' }));
      expect(decidedPairs()).toEqual([]);
    });

    it('does not apply an expired acknowledgement or one for another rule', () => {
      db().upsertPreflightAcknowledgement(ack('privileged', 'web', { expiry_mode: 'days', expires_at: Date.now() - 1000 }));
      db().upsertPreflightAcknowledgement(ack('image-latest', 'web'));
      expect(decidedPairs()).toEqual([]);
    });

    it('lands each decision on its finding whatever order the rows are stored in', () => {
      db().upsertPreflightAcknowledgement(ack('privileged', 'db'));
      db().upsertPreflightAcknowledgement(ack('no-restart-policy', 'web'));
      const stored = [
        row('f-web', 'privileged', 'high', 'web'),
        row('f-info', 'healthcheck-inherited', 'info', 'db'),
        row('f-db', 'privileged', 'high', 'db'),
        row('f-warn', 'no-restart-policy', 'warning', 'web'),
      ];
      const run = { id: 'ack-run', node_id: nodeId, stack_name: stack, source_hash: null, rendered_hash: 'hash-1', service_images: null, status: 'high', highest_severity: 'high', created_at: 2, created_by: 'tester', coverage: null };
      const outcomes = [stored, [...stored].reverse(), [stored[2], stored[3], stored[0], stored[1]]].map(rows => {
        db().replacePreflightRun(run, rows);
        return {
          normalized: decidedPairs(),
          wire: doctor().getLatest(nodeId, stack).findings
            .filter(finding => finding.acknowledged).map(finding => [finding.ruleId, finding.service]),
        };
      });
      for (const outcome of outcomes) {
        expect(outcome.normalized.map(pair => pair.slice(0, 2))).toEqual([['privileged', 'db'], ['no-restart-policy', 'web']]);
        expect(outcome.wire).toEqual([['privileged', 'db'], ['no-restart-policy', 'web']]);
      }
    });

    it('carries every acknowledgement field to the wire exactly as the normalized read decided it', () => {
      const soon = Date.now() + 86_400_000;
      db().replacePreflightRun(
        { id: 'ack-run', node_id: nodeId, stack_name: stack, source_hash: null, rendered_hash: 'hash-1', service_images: JSON.stringify({ db: 'postgres:16' }), status: 'high', highest_severity: 'high', created_at: 2, created_by: 'tester', coverage: null },
        [
          row('f-web', 'privileged', 'high', 'web'),
          row('f-info', 'healthcheck-inherited', 'info', 'db'),
          row('f-db', 'privileged', 'high', 'db'),
          row('f-warn', 'no-restart-policy', 'warning', 'web'),
          row('f-img', 'image-latest', 'warning', 'db'),
        ],
      );
      db().upsertPreflightAcknowledgement(ack('privileged', 'web'));
      db().upsertPreflightAcknowledgement(ack('privileged', 'db', { expiry_mode: 'days', expires_at: soon }));
      db().upsertPreflightAcknowledgement(ack('no-restart-policy', 'web', { expiry_mode: 'until_compose_change', anchor_rendered_hash: 'hash-1' }));
      db().upsertPreflightAcknowledgement(ack('image-latest', 'db', { expiry_mode: 'until_image_change', anchor_image_ref: 'postgres:16' }));

      const wire = doctor().getLatest(nodeId, stack).findings;
      const { findings } = doctor().getLatestAssurance(nodeId, stack);
      expect(wire).toHaveLength(findings.length);
      // Finding for finding, in the same order, the wire fields are the decision's.
      findings.forEach((finding, index) => {
        const projected = wire[index];
        expect([projected.ruleId, projected.service]).toEqual([finding.ruleId, finding.scope.service]);
        expect(projected.acknowledged).toBe(finding.decision !== undefined);
        expect(projected.acknowledgementId).toBe(finding.decision?.id);
        expect(projected.acknowledgementReason).toBe(finding.decision?.reason);
        expect(projected.acknowledgementExpiry).toBe(finding.decision?.expiry.mode);
        expect(projected.acknowledgementExpiresAt).toBe(finding.decision?.expiry.expiresAt);
      });
      // Stated outright, so a regression made on both sides still fails.
      const summary = wire.filter(finding => finding.acknowledged)
        .map(finding => [finding.ruleId, finding.service, finding.acknowledgementReason, finding.acknowledgementExpiry, finding.acknowledgementExpiresAt]);
      expect(summary).toEqual(expect.arrayContaining([
        ['privileged', 'web', 'privileged web', 'forever', undefined],
        ['privileged', 'db', 'privileged db', 'days', soon],
        ['no-restart-policy', 'web', 'no-restart-policy web', 'until_compose_change', undefined],
        ['image-latest', 'db', 'image-latest db', 'until_image_change', undefined],
      ]));
      expect(summary).toHaveLength(4);
      expect(wire.filter(finding => !finding.acknowledged).every(finding => finding.acknowledgementId === undefined)).toBe(true);
    });
  });

  it('names the rule when two findings share a fingerprint, and keeps both', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    stubDocker(cleanModel());
    const duplicate = { ruleId: 'privileged', severity: 'high', title: 'Privileged container', message: 'm', service: 'web' };
    injectedHits.extra = [duplicate, { ...duplicate, message: 'again' }];
    try {
      const report = await doctor().runPreflight(nodeId, STACK, 'tester');
      expect(report.findings.filter(finding => finding.ruleId === 'privileged')).toHaveLength(2);
      const logged = warn.mock.calls.map(call => call.map(String).join(' '));
      expect(logged.some(line => line.includes('share a fingerprint') && line.includes('privileged'))).toBe(true);
    } finally {
      injectedHits.extra = [];
    }
  });

  it('stays quiet when every finding has its own fingerprint', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    stubDocker(cleanModel());
    await doctor().runPreflight(nodeId, STACK, 'tester');
    expect(warn.mock.calls.some(call => call.map(String).join(' ').includes('share a fingerprint'))).toBe(false);
  });

  it('records an env-source failure as partial coverage instead of a silent pass', async () => {
    envSourceFailure.fail = true;
    try {
      // Compose still reports an unset name, so the raw-stderr fallback warning
      // is the one env finding that survives an unreadable env context.
      stubDocker(cleanModel(), 'WARN The "MISSING" variable is not set. Defaulting to a blank string.');
      const report = await doctor().runPreflight(nodeId, STACK, 'tester');
      expect(report.renderable).toBe(true);
      expect(report.coverage.state).toBe('partial');
      const skipped = report.coverage.skipped.map(entry => entry.ruleId);
      expect(skipped).toEqual(expect.arrayContaining(['env-unset', 'env-file-missing']));
      expect(skipped).not.toContain('env-literal-dollar');
      expect(report.coverage.skipped.find(entry => entry.ruleId === 'env-unset')?.missing).toEqual(['env-context']);
      // The fallback warning is still reported, exactly as before the contract.
      expect(report.findings.map(finding => finding.ruleId)).toContain('env-literal-dollar');

      const run = db().getLatestPreflightRun(nodeId, STACK);
      expect((JSON.parse(run!.coverage!) as { state: string }).state).toBe('partial');
      expect(doctor().getLatest(nodeId, STACK).coverage.state).toBe('partial');
    } finally {
      envSourceFailure.fail = false;
    }
  });

  describe('an env file that cannot be read', () => {
    const stackDir = () => path.join(process.env.COMPOSE_DIR as string, STACK);
    const UNSET = 'WARN The "PORT" variable is not set. Defaulting to a blank string.';
    const expectPartialOnEnvContext = async () => {
      stubDocker(cleanModel(), UNSET);
      const report = await doctor().runPreflight(nodeId, STACK, 'tester');
      expect(report.renderable).toBe(true);
      expect(report.coverage.state).toBe('partial');
      const envSkips = report.coverage.skipped.filter(entry => entry.missing.includes('env-context'));
      expect(envSkips.map(entry => entry.ruleId)).toEqual(expect.arrayContaining(['env-unset', 'env-file-missing']));
      // The same on a later read of the stored run, so every surface agrees.
      expect(doctor().getLatest(nodeId, STACK).coverage).toEqual(report.coverage);
      return report;
    };

    it('records the project .env being a directory as partial coverage', async () => {
      fs.mkdirSync(path.join(stackDir(), '.env'));
      await expectPartialOnEnvContext();
    });

    it('records a configured project env file being a directory as partial coverage', async () => {
      fs.mkdirSync(path.join(stackDir(), 'prod.env'));
      db().setStackProjectEnvFiles(nodeId, STACK, ['prod.env']);
      await expectPartialOnEnvContext();
    });

    it('records a declared env_file being a directory as partial coverage', async () => {
      writeStack(STACK, 'services:\n  web:\n    image: nginx:1.27\n    env_file: app.env\n');
      fs.mkdirSync(path.join(stackDir(), 'app.env'));
      await expectPartialOnEnvContext();
    });

    it('records a file whose existence cannot be checked as partial coverage', async () => {
      envSourceFailure.rewrite = (sources) => {
        const resolved = sources as { envFiles: { existence: string }[] };
        return { ...resolved, envFiles: resolved.envFiles.map(file => ({ ...file, existence: 'unverifiable' })) };
      };
      await expectPartialOnEnvContext();
    });

    it('does not report the raw stderr name as an unset variable while the env context is missing', async () => {
      fs.mkdirSync(path.join(stackDir(), '.env'));
      const report = await expectPartialOnEnvContext();
      expect(report.findings.map(finding => finding.ruleId)).not.toContain('env-unset');
    });

    it.each([
      ['an absent project .env', () => undefined],
      ['a readable project .env', () => fs.writeFileSync(path.join(stackDir(), '.env'), 'PORT=8080\n')],
    ])('stays complete with %s', async (_label, arrange) => {
      arrange();
      stubDocker(cleanModel());
      const report = await doctor().runPreflight(nodeId, STACK, 'tester');
      expect(report.coverage.state).toBe('complete');
      expect(report.coverage.skipped.filter(entry => entry.missing.includes('env-context'))).toEqual([]);
    });
  });
});
