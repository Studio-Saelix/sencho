/**
 * Severity matrix and collision correctness for the live Networking findings
 * engine: host-mode severity across exposure intents (with/without a
 * documented Dossier access URL), and the network-name-collision fix that
 * must not flag intentional shared-external-network declarations.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { setupTestDb, cleanupTestDb, TEST_USERNAME, TEST_JWT_SECRET } from './helpers/setupTestDb';
import DockerController from '../services/DockerController';
import { ComposeService } from '../services/ComposeService';
import { DatabaseService } from '../services/DatabaseService';
import { invalidateNodeNetworkingAggregate } from '../services/network/networkingAggregateCache';

let tmpDir: string;
let app: import('express').Express;
let authHeader: string;

function renderedModel(stack: string, opts: { networkMode?: string; hostIp?: string } = {}) {
  const service: Record<string, unknown> = { image: 'nginx:latest' };
  if (opts.networkMode) {
    service.network_mode = opts.networkMode;
  } else {
    service.ports = [{ published: '8080', target: '80', host_ip: opts.hostIp ?? '' }];
  }
  return {
    rendered: JSON.stringify({
      name: stack,
      services: { web: service },
      networks: {},
      volumes: {},
    }),
    stderr: '',
    code: 0,
    timedOut: false,
  };
}

function stubEmptySnapshot() {
  vi.spyOn(DockerController, 'getInstance').mockReturnValue({
    getDependencySnapshot: vi.fn().mockResolvedValue({ containers: [], networks: [], volumes: [] }),
  } as unknown as DockerController);
}

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ app } = await import('../index'));
  authHeader = `Bearer ${jwt.sign({ username: TEST_USERNAME }, TEST_JWT_SECRET, { expiresIn: '5m' })}`;
});

afterAll(() => cleanupTestDb(tmpDir));

function writeStack(stack: string) {
  const dir = path.join(process.env.COMPOSE_DIR as string, stack);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'compose.yaml'), 'services:\n  web:\n    image: nginx:latest\n');
  return dir;
}

async function findingsFor(stack: string): Promise<Array<{ kind: string; severity: string; stack?: string }>> {
  const res = await request(app).get('/api/networking/overview').set('Authorization', authHeader);
  expect(res.status).toBe(200);
  return (res.body.findings as Array<{ kind: string; severity: string; stack?: string }>)
    .filter((f) => f.stack === stack);
}

describe('networking host-mode severity matrix', () => {
  const STACK = 'sevhost';
  let stackDir: string;

  beforeEach(() => {
    stackDir = writeStack(STACK);
    stubEmptySnapshot();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    DatabaseService.getInstance().deleteStackExposureIntents(1, STACK);
    DatabaseService.getInstance().deleteStackDossier(1, STACK);
    fs.rmSync(stackDir, { recursive: true, force: true });
  });

  it('unset intent is high severity for network_mode: host', async () => {
    vi.spyOn(ComposeService, 'getInstance').mockReturnValue({
      renderConfig: vi.fn().mockResolvedValue(renderedModel(STACK, { networkMode: 'host' })),
    } as unknown as ComposeService);
    const findings = await findingsFor(STACK);
    const hostFinding = findings.find((f) => f.kind === 'network-mode-host');
    expect(hostFinding?.severity).toBe('high');
  });

  it('internal intent is high severity for network_mode: host regardless of documentation', async () => {
    vi.spyOn(ComposeService, 'getInstance').mockReturnValue({
      renderConfig: vi.fn().mockResolvedValue(renderedModel(STACK, { networkMode: 'host' })),
    } as unknown as ComposeService);
    DatabaseService.getInstance().setStackExposureIntent(1, STACK, '', 'internal', null);
    DatabaseService.getInstance().upsertStackDossier(1, STACK, {
      purpose: '', owner: '', access_urls: 'http://localhost:8080', static_ip: '', vlan: '',
      firewall_notes: '', reverse_proxy_notes: '', backup_notes: '', upgrade_notes: '',
      recovery_notes: '', custom_notes: '',
    });
    const findings = await findingsFor(STACK);
    const hostFinding = findings.find((f) => f.kind === 'network-mode-host');
    expect(hostFinding?.severity).toBe('high');
  });

  it('lan intent without documented access is medium severity', async () => {
    vi.spyOn(ComposeService, 'getInstance').mockReturnValue({
      renderConfig: vi.fn().mockResolvedValue(renderedModel(STACK, { networkMode: 'host' })),
    } as unknown as ComposeService);
    DatabaseService.getInstance().setStackExposureIntent(1, STACK, '', 'lan', null);
    const findings = await findingsFor(STACK);
    const hostFinding = findings.find((f) => f.kind === 'network-mode-host');
    expect(hostFinding?.severity).toBe('medium');
  });

  it('lan intent with a documented Dossier access URL downgrades to info', async () => {
    vi.spyOn(ComposeService, 'getInstance').mockReturnValue({
      renderConfig: vi.fn().mockResolvedValue(renderedModel(STACK, { networkMode: 'host' })),
    } as unknown as ComposeService);
    DatabaseService.getInstance().setStackExposureIntent(1, STACK, '', 'lan', null);
    DatabaseService.getInstance().upsertStackDossier(1, STACK, {
      purpose: '', owner: '', access_urls: 'http://localhost:8080', static_ip: '', vlan: '',
      firewall_notes: '', reverse_proxy_notes: '', backup_notes: '', upgrade_notes: '',
      recovery_notes: '', custom_notes: '',
    });
    const findings = await findingsFor(STACK);
    const hostFinding = findings.find((f) => f.kind === 'network-mode-host');
    expect(hostFinding?.severity).toBe('info');
  });
});

describe('networking collision correctness', () => {
  const STACK_A = 'colla';
  const STACK_B = 'collb';
  let dirA: string;
  let dirB: string;

  afterEach(() => {
    vi.restoreAllMocks();
    invalidateNodeNetworkingAggregate(1);
    fs.rmSync(dirA, { recursive: true, force: true });
    fs.rmSync(dirB, { recursive: true, force: true });
  });

  it('two stacks declaring the SAME external network are not a name collision', async () => {
    dirA = writeStack(STACK_A);
    dirB = writeStack(STACK_B);
    stubEmptySnapshot();
    vi.spyOn(ComposeService, 'getInstance').mockReturnValue({
      renderConfig: vi.fn().mockImplementation((stack: string) => Promise.resolve({
        rendered: JSON.stringify({
          name: stack,
          services: { web: { image: 'nginx:latest' } },
          networks: { edge: { name: 'edge-net', external: true } },
          volumes: {},
        }),
        stderr: '', code: 0, timedOut: false,
      })),
    } as unknown as ComposeService);

    const res = await request(app).get('/api/networking/overview').set('Authorization', authHeader);
    expect(res.status).toBe(200);
    const findings = res.body.findings as Array<{ kind: string; network?: string }>;
    expect(findings.some((f) => f.kind === 'network-name-collision' && f.network === 'edge-net')).toBe(false);
  });

  it('two stacks declaring a non-external network with the same forced literal name IS a collision', async () => {
    dirA = writeStack(STACK_A);
    dirB = writeStack(STACK_B);
    stubEmptySnapshot();
    vi.spyOn(ComposeService, 'getInstance').mockReturnValue({
      renderConfig: vi.fn().mockImplementation((stack: string) => Promise.resolve({
        rendered: JSON.stringify({
          name: stack,
          services: { web: { image: 'nginx:latest' } },
          networks: { app: { name: 'shared-literal' } },
          volumes: {},
        }),
        stderr: '', code: 0, timedOut: false,
      })),
    } as unknown as ComposeService);

    const res = await request(app).get('/api/networking/overview').set('Authorization', authHeader);
    expect(res.status).toBe(200);
    const findings = res.body.findings as Array<{ kind: string; network?: string }>;
    expect(findings.some((f) => f.kind === 'network-name-collision' && f.network === 'shared-literal')).toBe(true);
  });
});
