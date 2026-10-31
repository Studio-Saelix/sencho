/**
 * Volume-protection capability and the node dispatcher: no build advertises
 * protection without an engine, skew reads as update required only when the
 * contract really differs, and the hub reads a node's status in process for the
 * local node and over the proxy target for direct-proxy and Pilot nodes alike,
 * keeping only whitelisted metadata.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { setupTestDb, cleanupTestDb, TEST_USERNAME, TEST_JWT_SECRET } from './helpers/setupTestDb';
import type { NodeProxyJsonRead } from '../helpers/nodeProxyJson';
import type { BackupEngine } from '../services/recovery/types';

const mockRead = vi.fn<(args: { nodeId: number; path: string; headers?: Record<string, string> }) => Promise<NodeProxyJsonRead>>();
vi.mock('../helpers/nodeProxyJson', () => ({
  readNodeProxyJson: (args: { nodeId: number; path: string; headers?: Record<string, string> }) => mockRead(args),
}));

let tmpDir: string;
let app: import('express').Express;
let authHeader: string;
let capability: typeof import('../services/recovery/capability');
let dispatcher: typeof import('../services/recovery/dispatcher');
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;
let localNodeId: number;
let proxyNodeId: number;
let pilotNodeId: number;

const fakeEngine: BackupEngine = {
  engineId: 'fake',
  contractVersion: 1,
  storageKinds: ['named_volume'],
  probe: async () => ({ engineId: 'fake', build: 'sha256:0', usable: true }),
  createPoint: async () => ({ ok: false, errorClass: 'internal' }),
  verifyPoint: async () => ({ ok: false, errorClass: 'internal' }),
  restore: async () => ({ ok: false, errorClass: 'internal' }),
};

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ app } = await import('../index'));
  ({ DatabaseService } = await import('../services/DatabaseService'));
  capability = await import('../services/recovery/capability');
  dispatcher = await import('../services/recovery/dispatcher');
  authHeader = `Bearer ${jwt.sign({ username: TEST_USERNAME }, TEST_JWT_SECRET, { expiresIn: '5m' })}`;
  const db = DatabaseService.getInstance();
  localNodeId = db.getDefaultNode()!.id!;
  proxyNodeId = db.addNode({ name: 'recovery-proxy', type: 'remote', api_url: 'http://192.168.1.61:1852', api_token: 't', compose_dir: '/srv', is_default: false });
  pilotNodeId = db.addNode({ name: 'recovery-pilot', type: 'remote', mode: 'pilot_agent', compose_dir: '/srv', is_default: false });
});

afterAll(() => cleanupTestDb(tmpDir));

beforeEach(async () => {
  mockRead.mockReset();
  capability.resetBackupEnginesForTests();
  // The hub caches a node's support for 30 s, so each case starts cold.
  const { resetRemoteRecoverySupportCacheForTests } = await import('../services/recovery/remoteSupport');
  resetRemoteRecoverySupportCacheForTests();
  vi.restoreAllMocks();
});

const echoing = (descriptor: Record<string, unknown>) => async (args: { headers?: Record<string, string> }): Promise<NodeProxyJsonRead> =>
  ({ kind: 'ok', data: { ...descriptor, operationId: args.headers?.[dispatcher.RECOVERY_OPERATION_HEADER] } });

const descriptor = (state = 'unavailable', reason = 'engine_not_installed', contractVersion = 1, version = 1) => ({
  contractVersion,
  volumeProtection: { capability: 'volume-protection-v1', version, state, reason },
});

describe('advertising', () => {
  it('advertises volume protection, because this build ships the engine', async () => {
    const { CAPABILITIES, getActiveCapabilities } = await import('../services/CapabilityRegistry');
    expect(CAPABILITIES as readonly string[]).toContain('volume-protection-v1');
    expect(getActiveCapabilities()).toContain('volume-protection-v1');
    const meta = await request(app).get('/api/meta');
    expect(meta.status).toBe(200);
    expect((meta.body.capabilities as string[])).toContain('volume-protection-v1');
  });

  it('reports this node as unavailable, not as update required, when it has no engine', () => {
    expect(capability.getLocalVolumeProtectionStatus()).toEqual({
      capability: 'volume-protection-v1', version: 1, state: 'unavailable', reason: 'engine_not_installed',
    });
  });

  it('reports available once an engine is registered', () => {
    capability.registerBackupEngine(fakeEngine);
    capability.registerBackupEngine(fakeEngine);
    expect(capability.getRegisteredEngines()).toHaveLength(1);
    expect(capability.getLocalVolumeProtectionStatus()).toMatchObject({ state: 'available', reason: 'engine_registered' });
  });

  it('fails closed when this build cannot use the recovery schema', async () => {
    const db = DatabaseService.getInstance();
    capability.registerBackupEngine(fakeEngine);
    vi.spyOn(db, 'getRecoverySchemaOutcome').mockReturnValue({ kind: 'newer', storedVersion: 2 });
    expect(capability.getLocalVolumeProtectionStatus()).toMatchObject({ state: 'unavailable', reason: 'schema_newer_than_build' });
    const { recoveryDb } = await import('../services/recovery/recoveryDb');
    expect(() => recoveryDb()).toThrow(expect.objectContaining({ errorClass: 'schema_unsupported' }));
    vi.spyOn(db, 'getRecoverySchemaOutcome').mockReturnValue({ kind: 'failed' });
    expect(capability.getLocalVolumeProtectionStatus()).toMatchObject({ state: 'unavailable', reason: 'recovery_store_unavailable' });
  });
});

describe('resolveRemoteVolumeProtection', () => {
  const resolve = (read: NodeProxyJsonRead) => capability.resolveRemoteVolumeProtection(read);

  it('reads a node without the descriptor route as update required', () => {
    expect(resolve({ kind: 'route_missing' })).toMatchObject({ state: 'update_required', reason: 'node_contract_older' });
  });

  it('reads contract skew in either direction as update required, naming the side', () => {
    expect(resolve({ kind: 'ok', data: descriptor('available', 'engine_registered', 2) })).toMatchObject({ state: 'update_required', reason: 'hub_contract_older' });
    expect(resolve({ kind: 'ok', data: descriptor('available', 'engine_registered', 1, 2) })).toMatchObject({ state: 'update_required', reason: 'hub_contract_older' });
    expect(resolve({ kind: 'ok', data: descriptor('available', 'engine_registered', 1, 0) })).toMatchObject({ state: 'update_required', reason: 'node_contract_older' });
  });

  it('passes a same-contract node\'s own answer through', () => {
    expect(resolve({ kind: 'ok', data: descriptor() })).toMatchObject({ state: 'unavailable', reason: 'engine_not_installed' });
    expect(resolve({ kind: 'ok', data: descriptor('available', 'engine_registered') })).toMatchObject({ state: 'available' });
  });

  it('reads an unreachable node as unknown, never as available or unavailable', () => {
    for (const read of [{ kind: 'no_target' }, { kind: 'transport', detail: 'ECONNRESET' }] as NodeProxyJsonRead[]) {
      expect(resolve(read)).toMatchObject({ state: 'unknown', reason: 'node_unreachable' });
    }
  });

  it('tells a node that refused or failed the read apart from one that could not be reached', () => {
    expect(resolve({ kind: 'http', status: 401 })).toMatchObject({ state: 'unknown', reason: 'node_refused' });
    expect(resolve({ kind: 'http', status: 403 })).toMatchObject({ state: 'unknown', reason: 'node_refused' });
    expect(resolve({ kind: 'http', status: 500 })).toMatchObject({ state: 'unknown', reason: 'node_error' });
    expect(resolve({ kind: 'http', status: 502 })).toMatchObject({ state: 'unknown', reason: 'node_error' });
  });

  it('refuses a state and reason that contradict each other, or that only the hub may conclude', () => {
    for (const [state, reason] of [
      ['available', 'engine_not_installed'],
      ['unavailable', 'engine_registered'],
      ['available', 'node_unreachable'],
      ['update_required', 'node_contract_older'],
      ['unknown', 'descriptor_invalid'],
    ]) {
      expect(resolve({ kind: 'ok', data: descriptor(state, reason) })).toMatchObject({ state: 'unknown', reason: 'descriptor_invalid' });
    }
  });

  it('reads a malformed descriptor as unknown', () => {
    for (const data of [
      null, [], 'text', {}, { contractVersion: 1 },
      { contractVersion: 1.5, volumeProtection: descriptor().volumeProtection },
      { contractVersion: 1, volumeProtection: { ...descriptor().volumeProtection, capability: 'other' } },
      { contractVersion: 1, volumeProtection: { ...descriptor().volumeProtection, state: 'protected' } },
      { contractVersion: 1, volumeProtection: { ...descriptor().volumeProtection, reason: 'because' } },
    ]) {
      expect(resolve({ kind: 'ok', data })).toMatchObject({ state: 'unknown', reason: 'descriptor_invalid' });
    }
  });
});

describe('readRecoveryNodeStatus', () => {
  it('answers in process for the local node, without a network read', async () => {
    const result = await dispatcher.readRecoveryNodeStatus(localNodeId);
    expect(result).toMatchObject({ nodeId: localNodeId, transport: 'local', errorClass: null, volumeProtection: { state: 'unavailable' } });
    expect(result.operationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(mockRead).not.toHaveBeenCalled();
  });

  for (const [label, getId, transport] of [
    ['a direct-proxy node', () => proxyNodeId, 'node_proxy'],
    ['a Pilot node', () => pilotNodeId, 'pilot_tunnel'],
  ] as const) {
    describe(label, () => {
      it('reads the node\'s own descriptor over its proxy target, carrying the operation id', async () => {
        mockRead.mockImplementation(echoing(descriptor('available', 'engine_registered')));
        const result = await dispatcher.readRecoveryNodeStatus(getId());
        expect(mockRead).toHaveBeenCalledWith(expect.objectContaining({
          nodeId: getId(), path: '/api/recovery/node',
          headers: { [dispatcher.RECOVERY_OPERATION_HEADER]: result.operationId },
        }));
        expect(result).toMatchObject({ transport, errorClass: null, volumeProtection: { state: 'available', reason: 'engine_registered' } });
      });

      it('keeps only whitelisted metadata from the answer', async () => {
        mockRead.mockImplementation(echoing({ ...descriptor(), repositoryPassword: 'hunter2', paths: ['/srv/data'] }));
        const result = await dispatcher.readRecoveryNodeStatus(getId());
        expect(JSON.stringify(result)).not.toContain('hunter2');
        expect(JSON.stringify(result)).not.toContain('/srv/data');
      });

      it('rejects and logs an answer that belongs to another dispatch, or that lost the operation id', async () => {
        const { resetRemoteRecoverySupportCacheForTests } = await import('../services/recovery/remoteSupport');
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        mockRead.mockResolvedValue({ kind: 'ok', data: { ...descriptor('available', 'engine_registered'), operationId: '00000000-0000-4000-8000-000000000000' } });
        expect(await dispatcher.readRecoveryNodeStatus(getId())).toMatchObject({
          transport, errorClass: 'internal', volumeProtection: { state: 'unknown', reason: 'descriptor_mismatch' },
        });
        resetRemoteRecoverySupportCacheForTests();
        mockRead.mockResolvedValue({ kind: 'ok', data: descriptor('available', 'engine_registered') });
        expect((await dispatcher.readRecoveryNodeStatus(getId())).volumeProtection).toMatchObject({ state: 'unknown', reason: 'descriptor_mismatch' });
        expect(warn).toHaveBeenCalledTimes(2);
      });

      it('reports a node that refused or failed the read with its own class', async () => {
        const { resetRemoteRecoverySupportCacheForTests } = await import('../services/recovery/remoteSupport');
        mockRead.mockResolvedValue({ kind: 'http', status: 401 });
        expect(await dispatcher.readRecoveryNodeStatus(getId())).toMatchObject({ transport, errorClass: 'node_refused' });
        resetRemoteRecoverySupportCacheForTests();
        mockRead.mockResolvedValue({ kind: 'http', status: 500 });
        expect(await dispatcher.readRecoveryNodeStatus(getId())).toMatchObject({ transport, errorClass: 'node_error' });
      });

      it('reads a node with no engine as an older build, the same way the preflight will', async () => {
        mockRead.mockImplementation(echoing(descriptor('unavailable', 'engine_not_installed')));
        expect(await dispatcher.readRecoveryNodeStatus(getId())).toMatchObject({
          transport, errorClass: 'update_required',
          volumeProtection: { state: 'update_required', reason: 'node_contract_older' },
        });
      });

      it('caches the answer for 30 s, so a poll does not read the descriptor every time', async () => {
        const { resolveRemoteRecoverySupport } = await import('../services/recovery/remoteSupport');
        mockRead.mockImplementation(echoing(descriptor('available', 'engine_registered')));
        await resolveRemoteRecoverySupport(getId());
        await resolveRemoteRecoverySupport(getId());
        expect(mockRead).toHaveBeenCalledTimes(1);
        await resolveRemoteRecoverySupport(getId(), () => Date.now() + 31_000);
        expect(mockRead).toHaveBeenCalledTimes(2);
      });

      it('reports an old node as update required', async () => {
        mockRead.mockResolvedValue({ kind: 'route_missing' });
        expect(await dispatcher.readRecoveryNodeStatus(getId())).toMatchObject({
          transport, errorClass: 'update_required', volumeProtection: { state: 'update_required' },
        });
      });

      it('reports an unreachable node, or a dropped connection, as unknown', async () => {
        mockRead.mockResolvedValue({ kind: 'no_target' });
        expect(await dispatcher.readRecoveryNodeStatus(getId())).toMatchObject({
          transport, errorClass: 'transport_unreachable', volumeProtection: { state: 'unknown' },
        });
        mockRead.mockResolvedValue({ kind: 'transport', detail: 'socket hang up' });
        expect((await dispatcher.readRecoveryNodeStatus(getId())).errorClass).toBe('transport_unreachable');
      });
    });
  }

  it('does not treat a node this instance does not know as local', async () => {
    expect(await dispatcher.readRecoveryNodeStatus(987654)).toMatchObject({
      transport: null, errorClass: 'invalid_request', volumeProtection: { state: 'unknown' },
    });
    expect(mockRead).not.toHaveBeenCalled();
  });
});

describe('GET /api/recovery/node', () => {
  it('requires a signed-in caller', async () => {
    expect((await request(app).get('/api/recovery/node')).status).toBe(401);
  });

  it('requires stack:read', async () => {
    const { ROLE_PERMISSIONS } = await import('../middleware/permissions');
    const bcrypt = (await import('bcrypt')).default;
    const db = DatabaseService.getInstance();
    db.addUser({ username: 'recovery-viewer', password_hash: await bcrypt.hash('x', 1), role: 'viewer' });
    const token = `Bearer ${jwt.sign({ username: 'recovery-viewer' }, TEST_JWT_SECRET, { expiresIn: '5m' })}`;
    expect((await request(app).get('/api/recovery/node').set('Authorization', token)).status).toBe(200);
    const original = [...ROLE_PERMISSIONS.viewer];
    ROLE_PERMISSIONS.viewer.splice(0, ROLE_PERMISSIONS.viewer.length, ...original.filter((a) => a !== 'stack:read'));
    try {
      const denied = await request(app).get('/api/recovery/node').set('Authorization', token);
      expect(denied.status).toBe(403);
    } finally {
      ROLE_PERMISSIONS.viewer.splice(0, ROLE_PERMISSIONS.viewer.length, ...original);
    }
  });

  it('returns this node\'s descriptor and nothing else', async () => {
    const res = await request(app).get('/api/recovery/node').set('Authorization', authHeader);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ...descriptor(), operationId: null });
  });

  it('echoes a well-formed operation id and ignores anything else', async () => {
    const id = '5b0c1f3e-6a7d-4e8f-9a0b-1c2d3e4f5a6b';
    const ok = await request(app).get('/api/recovery/node').set('Authorization', authHeader).set(dispatcher.RECOVERY_OPERATION_HEADER, id.toUpperCase());
    expect(ok.body.operationId).toBe(id);
    const bad = await request(app).get('/api/recovery/node').set('Authorization', authHeader).set(dispatcher.RECOVERY_OPERATION_HEADER, 'not-a-uuid; drop');
    expect(bad.body.operationId).toBeNull();
  });

  it('is what the hub\'s resolver reads as this node\'s answer', async () => {
    const res = await request(app).get('/api/recovery/node').set('Authorization', authHeader);
    expect(capability.resolveRemoteVolumeProtection({ kind: 'ok', data: res.body })).toMatchObject({ state: 'unavailable', reason: 'engine_not_installed' });
  });
});
