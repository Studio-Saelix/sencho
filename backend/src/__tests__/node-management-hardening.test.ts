/**
 * Node-management route hardening.
 *
 * Gate parity: the write routes under /api/nodes enforce node:manage (admin or
 * node-admin). viewer and deployer sessions must be refused, while the read
 * route stays open to any authenticated session. This is the backend contract
 * the frontend mirrors by showing the node table to everyone but gating the
 * Add / Edit / Delete affordances on node:manage.
 *
 * Tunnel cleanup: deleting a node tears down any live pilot tunnel so the
 * bridge (loopback server, ping timer, open streams) is released immediately
 * instead of lingering until the agent happens to disconnect.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { EventEmitter } from 'events';
import { WebSocket } from 'ws';
import { setupTestDb, cleanupTestDb, TEST_USERNAME, TEST_JWT_SECRET } from './helpers/setupTestDb';
import { PilotTunnelManager } from '../services/PilotTunnelManager';

let tmpDir: string;
let app: import('express').Express;
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;

type ManageRole = 'admin' | 'node-admin';
type DeniedRole = 'viewer' | 'deployer';

function authToken(username: string, role: string, tv: number): string {
  return jwt.sign({ username, role, tv }, TEST_JWT_SECRET, { expiresIn: '1m' });
}

/**
 * Token for a session in the given role. The auth middleware resolves the role
 * from the DB, so the user must exist; password_hash is irrelevant because we
 * sign the JWT directly rather than logging in. The seeded admin is reused so
 * we never trip the seat or last-admin guards.
 */
function tokenForRole(role: ManageRole | DeniedRole): string {
  const db = DatabaseService.getInstance();
  const username = role === 'admin' ? TEST_USERNAME : `nm-${role}`;
  let user = db.getUserByUsername(username);
  if (!user) {
    db.addUser({ username, password_hash: 'test-hash', role });
    user = db.getUserByUsername(username)!;
  }
  return authToken(username, role, user.token_version);
}

function makeMockTunnelWs(): EventEmitter & {
  readyState: number;
  bufferedAmount: number;
  send: (data: unknown) => void;
  ping: () => void;
  close: () => void;
} {
  const ws = new EventEmitter() as EventEmitter & {
    readyState: number;
    bufferedAmount: number;
    send: (data: unknown) => void;
    ping: () => void;
    close: () => void;
  };
  ws.readyState = WebSocket.OPEN;
  ws.bufferedAmount = 0;
  ws.send = () => { /* no-op */ };
  ws.ping = () => { /* no-op */ };
  ws.close = () => { ws.readyState = WebSocket.CLOSED; ws.emit('close'); };
  return ws;
}

function addPilotNode(name: string): number {
  return DatabaseService.getInstance().addNode({
    name,
    type: 'remote',
    mode: 'pilot_agent',
    compose_dir: '/tmp/x',
    is_default: false,
    api_url: '',
    api_token: '',
  });
}

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ DatabaseService } = await import('../services/DatabaseService'));
  ({ app } = await import('../index'));
});

afterAll(() => cleanupTestDb(tmpDir));

describe('node-management write routes require node:manage', () => {
  it('lets a viewer read the node list (the table stays visible)', async () => {
    const res = await request(app)
      .get('/api/nodes')
      .set('Authorization', `Bearer ${tokenForRole('viewer')}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  for (const role of ['viewer', 'deployer'] as const) {
    it(`refuses node creation for ${role} (403 PERMISSION_DENIED)`, async () => {
      const res = await request(app)
        .post('/api/nodes')
        .set('Authorization', `Bearer ${tokenForRole(role)}`)
        .send({ name: `nm-create-${role}`, type: 'remote', mode: 'pilot_agent' });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('PERMISSION_DENIED');
    });

    it(`refuses node deletion for ${role} and leaves the node intact (403)`, async () => {
      const db = DatabaseService.getInstance();
      const id = addPilotNode(`nm-del-${role}`);
      const res = await request(app)
        .delete(`/api/nodes/${id}`)
        .set('Authorization', `Bearer ${tokenForRole(role)}`);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('PERMISSION_DENIED');
      expect(db.getNode(id)).toBeTruthy();
      db.deleteNode(id);
    });
  }

  // Positive boundary: both manage-capable roles succeed. admin short-circuits
  // the permission engine; node-admin must resolve node:manage from
  // ROLE_PERMISSIONS, so this also guards against node-admin silently losing
  // write access if that mapping ever changes.
  for (const role of ['admin', 'node-admin'] as const) {
    it(`allows node creation for ${role} (200)`, async () => {
      const res = await request(app)
        .post('/api/nodes')
        .set('Authorization', `Bearer ${tokenForRole(role)}`)
        .send({ name: `nm-create-${role}-${Date.now()}`, type: 'remote', mode: 'pilot_agent' });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });
  }

  it('allows a node-admin to delete a node (200)', async () => {
    const db = DatabaseService.getInstance();
    const id = addPilotNode(`nm-del-nodeadmin-${Date.now()}`);
    const res = await request(app)
      .delete(`/api/nodes/${id}`)
      .set('Authorization', `Bearer ${tokenForRole('node-admin')}`);
    expect(res.status).toBe(200);
    expect(db.getNode(id)).toBeUndefined();
  });
});

describe('deleting a node tears down its pilot tunnel', () => {
  it('closes the active tunnel socket and removes the node row', async () => {
    const db = DatabaseService.getInstance();
    const mgr = PilotTunnelManager.getInstance();
    const id = addPilotNode(`nm-tunnel-del-${Date.now()}`);

    const ws = makeMockTunnelWs();
    await mgr.registerTunnel(id, ws as unknown as WebSocket, 'test-1.0.0');
    expect(mgr.hasActiveTunnel(id)).toBe(true);

    const res = await request(app)
      .delete(`/api/nodes/${id}`)
      .set('Authorization', `Bearer ${tokenForRole('admin')}`);

    expect(res.status).toBe(200);
    // The manager forgot the tunnel AND the underlying socket was actually
    // closed (not just dropped from the map), so the agent gets a clean close.
    expect(mgr.hasActiveTunnel(id)).toBe(false);
    expect(ws.readyState).toBe(WebSocket.CLOSED);
    expect(db.getNode(id)).toBeUndefined();
  });

  it('deletes a node with no active tunnel without error (closeTunnel no-op path)', async () => {
    const db = DatabaseService.getInstance();
    const id = addPilotNode(`nm-no-tunnel-del-${Date.now()}`);
    expect(PilotTunnelManager.getInstance().hasActiveTunnel(id)).toBe(false);

    const res = await request(app)
      .delete(`/api/nodes/${id}`)
      .set('Authorization', `Bearer ${tokenForRole('admin')}`);

    expect(res.status).toBe(200);
    expect(db.getNode(id)).toBeUndefined();
  });
});
