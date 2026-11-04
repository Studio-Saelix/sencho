/**
 * GET /api/fleet/update-status reapply eligibility: every row carries a reason
 * that is null exactly when canReapplyCompose is true, for the local node and
 * for both remote transports (proxy and Pilot tunnel), including the unreachable
 * and pre-field (older remote) cases.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import axios from 'axios';
import { setupTestDb, cleanupTestDb, TEST_USERNAME, TEST_JWT_SECRET } from './helpers/setupTestDb';
import { OFFLINE_META } from '../services/CapabilityRegistry';

let tmpDir: string;
let app: import('express').Express;
let authHeader: string;
let localNodeId: number;
let proxyNodeId: number;
let pilotNodeId: number;
let NodeRegistry: typeof import('../services/NodeRegistry').NodeRegistry;
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;
let SelfUpdateService: typeof import('../services/SelfUpdateService').default;

const PROXY_URL = 'http://127.0.0.1:54322';
const PILOT_URL = 'http://127.0.0.1:54321';

function metaBody(over: Record<string, unknown> = {}) {
  return {
    version: '0.98.2',
    capabilities: ['stacks', 'containers'],
    startedAt: 1700000000,
    updateError: null,
    ...over,
  };
}

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ app } = await import('../index'));
  ({ NodeRegistry } = await import('../services/NodeRegistry'));
  ({ DatabaseService } = await import('../services/DatabaseService'));
  SelfUpdateService = (await import('../services/SelfUpdateService')).default;

  const db = DatabaseService.getInstance();
  localNodeId = db.getNodes().find(n => n.type === 'local')!.id;
  proxyNodeId = db.addNode({
    name: 'nas-proxy',
    type: 'remote',
    mode: 'proxy',
    compose_dir: '/tmp',
    is_default: false,
    api_url: PROXY_URL,
    api_token: 'token',
  });
  pilotNodeId = db.addNode({
    name: 'pilot-agent',
    type: 'remote',
    mode: 'pilot_agent',
    compose_dir: '/tmp',
    is_default: false,
    api_url: '',
    api_token: '',
  });

  authHeader = `Bearer ${jwt.sign({ username: TEST_USERNAME }, TEST_JWT_SECRET, { expiresIn: '1m' })}`;
});

afterAll(() => cleanupTestDb(tmpDir));

afterEach(() => {
  vi.restoreAllMocks();
});

function mockTargets(): void {
  vi.spyOn(NodeRegistry.getInstance(), 'getProxyTarget').mockImplementation((id: number) => {
    if (id === proxyNodeId) return { apiUrl: PROXY_URL, apiToken: '', trustedLoopback: true };
    if (id === pilotNodeId) return { apiUrl: PILOT_URL, apiToken: '', trustedLoopback: true };
    return null;
  });
}

/** Answer /api/meta per node URL; an Error value models an unreachable node. */
function mockMeta(byUrl: Record<string, unknown>): void {
  vi.spyOn(axios, 'get').mockImplementation(async (url: string) => {
    const body = byUrl[String(url)];
    if (body instanceof Error) throw body;
    return { data: body };
  });
}

function mockRelease(): void {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ tag_name: 'v0.99.0' }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  }));
}

type Row = Record<string, unknown> & {
  nodeId: number;
  canReapplyCompose: boolean;
  reapplyUnavailableReason: string | null;
};

async function fetchRows(): Promise<Row[]> {
  const res = await request(app).get('/api/fleet/update-status').set('Authorization', authHeader);
  expect(res.status).toBe(200);
  return (res.body as { nodes: Row[] }).nodes;
}

function localEligibility(available: boolean, code: string | null): void {
  const svc = SelfUpdateService.getInstance();
  vi.spyOn(svc, 'isAvailable').mockReturnValue(available);
  vi.spyOn(svc, 'getUnavailableCode').mockReturnValue(code as never);
  vi.spyOn(svc, 'getPinInfo').mockResolvedValue(null);
  vi.spyOn(svc, 'getLastError').mockReturnValue(null);
}

describe('local row', () => {
  it('reports the bounded reason when self-update is unavailable', async () => {
    mockRelease();
    localEligibility(false, 'not_compose_managed');

    const rows = await fetchRows();
    const local = rows.find(r => r.nodeId === localNodeId)!;

    expect(local.canReapplyCompose).toBe(false);
    expect(local.reapplyUnavailableReason).toBe('not_compose_managed');
  });

  it('reports a null reason when self-update is available', async () => {
    mockRelease();
    localEligibility(true, null);

    const rows = await fetchRows();
    const local = rows.find(r => r.nodeId === localNodeId)!;

    expect(local.canReapplyCompose).toBe(true);
    expect(local.reapplyUnavailableReason).toBeNull();
  });
});

describe('remote rows', () => {
  it('marks an online proxy node that advertises self-update as eligible', async () => {
    mockRelease();
    localEligibility(true, null);
    mockTargets();
    mockMeta({
      [`${PROXY_URL}/api/meta`]: metaBody({ capabilities: ['stacks', 'self-update'] }),
      [`${PILOT_URL}/api/meta`]: metaBody({ capabilities: ['stacks', 'self-update'] }),
    });

    const rows = await fetchRows();
    const proxy = rows.find(r => r.nodeId === proxyNodeId)!;

    expect(proxy.canReapplyCompose).toBe(true);
    expect(proxy.reapplyUnavailableReason).toBeNull();
  });

  it('carries the node-reported reason for an online proxy node without self-update', async () => {
    mockRelease();
    localEligibility(true, null);
    mockTargets();
    mockMeta({
      [`${PROXY_URL}/api/meta`]: metaBody({ selfUpdateUnavailable: 'docker_unreachable' }),
      [`${PILOT_URL}/api/meta`]: metaBody(),
    });

    const rows = await fetchRows();
    const proxy = rows.find(r => r.nodeId === proxyNodeId)!;

    expect(proxy.canReapplyCompose).toBe(false);
    expect(proxy.reapplyUnavailableReason).toBe('docker_unreachable');
  });

  it('carries the node-reported reason for a Pilot node without self-update', async () => {
    mockRelease();
    localEligibility(true, null);
    mockTargets();
    mockMeta({
      [`${PROXY_URL}/api/meta`]: metaBody(),
      [`${PILOT_URL}/api/meta`]: metaBody({ selfUpdateUnavailable: 'not_compose_managed' }),
    });

    const rows = await fetchRows();
    const pilot = rows.find(r => r.nodeId === pilotNodeId)!;

    expect(pilot.canReapplyCompose).toBe(false);
    expect(pilot.reapplyUnavailableReason).toBe('not_compose_managed');
  });

  it('reads a remote that predates the reason field as node_outdated', async () => {
    mockRelease();
    localEligibility(true, null);
    mockTargets();
    mockMeta({
      [`${PROXY_URL}/api/meta`]: metaBody(),
      [`${PILOT_URL}/api/meta`]: metaBody(),
    });

    const rows = await fetchRows();
    const proxy = rows.find(r => r.nodeId === proxyNodeId)!;

    expect(proxy.canReapplyCompose).toBe(false);
    expect(proxy.reapplyUnavailableReason).toBe('node_outdated');
  });

  it('reads an unreachable remote as node_unreachable through both transports', async () => {
    mockRelease();
    localEligibility(true, null);
    mockTargets();
    mockMeta({
      [`${PROXY_URL}/api/meta`]: new Error('connect ECONNREFUSED'),
      [`${PILOT_URL}/api/meta`]: new Error('socket hang up'),
    });

    const rows = await fetchRows();
    const proxy = rows.find(r => r.nodeId === proxyNodeId)!;
    const pilot = rows.find(r => r.nodeId === pilotNodeId)!;

    expect(proxy.canReapplyCompose).toBe(false);
    expect(proxy.reapplyUnavailableReason).toBe('node_unreachable');
    expect(pilot.canReapplyCompose).toBe(false);
    expect(pilot.reapplyUnavailableReason).toBe('node_unreachable');
  });

  it('keeps local eligibility from the service when the local poll throws', async () => {
    mockRelease();
    const svc = SelfUpdateService.getInstance();
    vi.spyOn(svc, 'isAvailable').mockReturnValue(true);
    vi.spyOn(svc, 'getUnavailableCode').mockReturnValue(null);
    vi.spyOn(svc, 'getPinInfo').mockRejectedValue(new Error('pin read failed'));
    mockTargets();
    mockMeta({
      [`${PROXY_URL}/api/meta`]: metaBody({ capabilities: ['self-update'] }),
      [`${PILOT_URL}/api/meta`]: metaBody({ capabilities: ['self-update'] }),
    });

    const rows = await fetchRows();
    const local = rows.find(r => r.nodeId === localNodeId)!;
    const proxy = rows.find(r => r.nodeId === proxyNodeId)!;

    expect(local.type).toBe('local');
    expect(local.canReapplyCompose).toBe(true);
    expect(local.reapplyUnavailableReason).toBeNull();
    expect(proxy.reapplyUnavailableReason === null).toBe(proxy.canReapplyCompose === true);
  });

  it('reads a poll that threw as node_unreachable', async () => {
    mockRelease();
    localEligibility(true, null);
    vi.spyOn(NodeRegistry.getInstance(), 'fetchMetaForNode').mockImplementation(async (id: number) => {
      if (id === proxyNodeId) throw new Error('meta probe crashed');
      return { ...OFFLINE_META };
    });

    const rows = await fetchRows();
    const proxy = rows.find(r => r.nodeId === proxyNodeId)!;

    expect(proxy.canReapplyCompose).toBe(false);
    expect(proxy.reapplyUnavailableReason).toBe('node_unreachable');
  });

  it('keeps the reason null exactly when reapply is eligible on every row', async () => {
    mockRelease();
    localEligibility(true, null);
    mockTargets();
    mockMeta({
      [`${PROXY_URL}/api/meta`]: metaBody({ capabilities: ['stacks', 'self-update'] }),
      [`${PILOT_URL}/api/meta`]: metaBody({ selfUpdateUnavailable: 'detecting' }),
    });

    const rows = await fetchRows();

    for (const row of rows) {
      expect(row.reapplyUnavailableReason === null).toBe(row.canReapplyCompose === true);
    }
  });
});
