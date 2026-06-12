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
let parseUnsetEnvVars: typeof import('../services/ComposeDoctorService').parseUnsetEnvVars;
let parseMissingRequiredVars: typeof import('../services/ComposeDoctorService').parseMissingRequiredVars;
let nodeId: number;

function db() { return DatabaseService.getInstance(); }
function doctor() { return ComposeDoctorService.getInstance(); }

/** Mock the two Docker calls; render returns the given effective model JSON. */
function stubDocker(rendered: object | null, stderr = '', snapshot = { containers: [], networks: [], volumes: [] }) {
  vi.spyOn(ComposeService, 'getInstance').mockReturnValue({
    renderConfig: vi.fn().mockResolvedValue({
      rendered: rendered === null ? null : JSON.stringify(rendered),
      stderr,
      code: rendered === null ? 1 : 0,
      timedOut: false,
    }),
  } as unknown as ComposeService);
  vi.spyOn(DockerController, 'getInstance').mockReturnValue({
    getDependencySnapshot: vi.fn().mockResolvedValue(snapshot),
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
  ({ ComposeDoctorService, parseUnsetEnvVars, parseMissingRequiredVars } = await import('../services/ComposeDoctorService'));
  nodeId = (db().getDb().prepare('SELECT id FROM nodes WHERE is_default = 1').get() as { id: number }).id;
});

afterAll(() => cleanupTestDb(tmpDir));
afterEach(() => vi.restoreAllMocks());

describe('parseUnsetEnvVars', () => {
  it('extracts variable names from Compose stderr (real escaped, quoted, and bare forms)', () => {
    // The escaped form is exactly what `docker compose config` emits in logfmt.
    const stderr =
      'time="2026-06-10T00:36:15-04:00" level=warning msg="The \\"DB_HOST\\" variable is not set. Defaulting to a blank string."\n'
      + 'The "TOKEN" variable is not set.\n'
      + 'The PLAIN variable is not set.';
    expect(parseUnsetEnvVars(stderr).sort()).toEqual(['DB_HOST', 'PLAIN', 'TOKEN']);
  });
  it('returns nothing for clean stderr', () => {
    expect(parseUnsetEnvVars('')).toEqual([]);
  });
  it('ignores lines that do not match the unset-variable phrase', () => {
    expect(parseUnsetEnvVars('the DB connection variable is configured\nNODE_ENV is not set elsewhere')).toEqual([]);
  });
});

describe('parseMissingRequiredVars', () => {
  it('extracts the name from the real required-variable error (unquoted)', () => {
    const stderr = 'error while interpolating services.web.environment.TOKEN: required variable REQ_TOKEN is missing a value: must be provided';
    expect(parseMissingRequiredVars(stderr)).toEqual(['REQ_TOKEN']);
  });
});

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
    expect(report.findings.map(f => f.ruleId)).toEqual(expect.arrayContaining(['env-unset', 'port-exposed-all-interfaces', 'image-latest', 'no-healthcheck']));
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

  it('never stores an environment value', async () => {
    stubDocker({ name: STACK, services: { web: { image: 'nginx:1.27', environment: { APP_SECRET: SECRET } } }, networks: {}, volumes: {} });
    const report = await doctor().runPreflight(nodeId, STACK, null);
    const runs = JSON.stringify(db().getDb().prepare('SELECT * FROM preflight_runs').all());
    const findings = JSON.stringify(db().getDb().prepare('SELECT * FROM preflight_findings').all());
    expect(runs).not.toContain(SECRET);
    expect(findings).not.toContain(SECRET);
    expect(JSON.stringify(report)).not.toContain(SECRET);
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
    vi.spyOn(ComposeService, 'getInstance').mockReturnValue({
      renderConfig: vi.fn().mockResolvedValue({
        rendered: JSON.stringify({ name: STACK, services: { web: { image: 'nginx:latest' } }, networks: {}, volumes: {} }),
        stderr: '', code: 0, timedOut: false,
      }),
    } as unknown as ComposeService);
    vi.spyOn(DockerController, 'getInstance').mockReturnValue({
      getDependencySnapshot: vi.fn().mockRejectedValue(new Error('docker down')),
    } as unknown as DockerController);
    const report = await doctor().runPreflight(nodeId, STACK, null);
    expect(report.renderable).toBe(true);
    expect(report.findings.map(f => f.ruleId)).toContain('image-latest'); // model rule still ran
    expect(report.findings.map(f => f.ruleId)).not.toContain('port-conflict-node'); // node-state skipped
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

describe('node deletion cleanup', () => {
  it('removes preflight runs and findings for a deleted node', () => {
    const ghostNode = 987654;
    db().replacePreflightRun(
      { id: 'run-x', node_id: ghostNode, stack_name: 's', source_hash: null, rendered_hash: null, status: 'pass', highest_severity: null, created_at: 1, created_by: null },
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
