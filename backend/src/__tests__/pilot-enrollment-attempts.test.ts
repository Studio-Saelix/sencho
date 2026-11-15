/**
 * What the hub records when a Pilot reaches it and is refused, so a bootstrap
 * that times out can name the cause the hub can see. Only a credential the hub
 * signed is believed: an expired token still carries signed claims, a forged
 * one carries nothing the hub trusts.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import type { IncomingMessage } from 'http';
import type { Duplex } from 'stream';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { WebSocketServer } from 'ws';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';
import { handlePilotTunnel } from '../websocket/pilotTunnel';
import { PilotEnrollmentAttempts } from '../services/PilotEnrollmentAttempts';
import { mintPilotEnrollmentToken } from '../helpers/pilotEnrollment';

let tmpDir: string;
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;
let wss: WebSocketServer;
let nodeId: number;
const attempts = () => PilotEnrollmentAttempts.getInstance();

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ DatabaseService } = await import('../services/DatabaseService'));
  wss = new WebSocketServer({ noServer: true });
});

afterAll(() => {
  wss.close();
  cleanupTestDb(tmpDir);
});

beforeEach(() => {
  nodeId = DatabaseService.getInstance().addNode({
    name: `attempts-${Date.now()}-${Math.random()}`,
    type: 'remote',
    mode: 'pilot_agent',
    compose_dir: '/tmp/x',
    is_default: false,
    api_url: '',
    api_token: '',
  });
  attempts().clear(nodeId);
});

function stubSocket() {
  const socket = new EventEmitter() as EventEmitter & { writes: string[]; destroy(): void; write(chunk: string): boolean };
  socket.writes = [];
  socket.destroy = () => undefined;
  socket.write = (chunk: string) => { socket.writes.push(chunk); return true; };
  return socket;
}

async function connect(token: string) {
  const socket = stubSocket();
  const req = { headers: { authorization: `Bearer ${token}`, 'x-sencho-agent-version': 't' } } as unknown as IncomingMessage;
  await handlePilotTunnel(req, socket as unknown as Duplex, Buffer.alloc(0), wss);
  return socket;
}

function secret(): string {
  return DatabaseService.getInstance().getGlobalSettings().auth_jwt_secret as string;
}

function expired(claims: Record<string, unknown>, signingSecret = secret()): string {
  return jwt.sign({ ...claims, iat: Math.floor(Date.now() / 1000) - 7200, exp: Math.floor(Date.now() / 1000) - 3600 }, signingSecret);
}

describe('hub record of refused Pilot attempts', () => {
  it('records an expired enrollment the Pilot presented', async () => {
    const socket = await connect(expired({ scope: 'pilot_enroll', nodeId }));
    expect(socket.writes[0]).toMatch(/^HTTP\/1\.1 401/);
    expect(attempts().lastRefusal(nodeId)).toMatchObject({ reason: 'enrollment_expired' });
  });

  it('records an expired saved tunnel credential', async () => {
    await connect(expired({ scope: 'pilot_tunnel', nodeId }));
    expect(attempts().lastRefusal(nodeId)).toMatchObject({ reason: 'credential_expired' });
  });

  it('records an enrollment that was already used', async () => {
    const { token } = mintPilotEnrollmentToken(nodeId);
    const hash = crypto.createHash('sha256').update(token).digest('hex');
    expect(DatabaseService.getInstance().consumePilotEnrollment(hash)?.node_id).toBe(nodeId);
    await connect(token);
    expect(attempts().lastRefusal(nodeId)).toMatchObject({ reason: 'enrollment_used' });
  });

  it('records an enrollment a newer one replaced', async () => {
    const first = mintPilotEnrollmentToken(nodeId);
    mintPilotEnrollmentToken(nodeId);
    await connect(first.token);
    expect(attempts().lastRefusal(nodeId)?.reason).toBe('enrollment_used');
  });

  it('does not believe an expired token it did not sign', async () => {
    await connect(expired({ scope: 'pilot_enroll', nodeId }, 'not-the-hub-secret'));
    expect(attempts().lastRefusal(nodeId)).toBeNull();
  });

  it('does not record an expired token for a node that is not a Pilot node', async () => {
    await connect(expired({ scope: 'pilot_enroll', nodeId: 987654 }));
    expect(attempts().lastRefusal(987654)).toBeNull();
  });

  it('forgets a refusal when a new enrollment is minted for the node', async () => {
    await connect(expired({ scope: 'pilot_enroll', nodeId }));
    expect(attempts().lastRefusal(nodeId)).not.toBeNull();
    mintPilotEnrollmentToken(nodeId);
    expect(attempts().lastRefusal(nodeId)).toBeNull();
  });

  it('forgets a refusal once the hub accepts a connection from the node', async () => {
    attempts().recordRefusal(nodeId, 'enrollment_used');
    const accepting = { handleUpgrade: (_req: unknown, _socket: unknown, _head: unknown, done: (ws: unknown) => void) => done({ send: () => undefined, close: () => undefined }) };
    const valid = jwt.sign({ scope: 'pilot_tunnel', nodeId }, secret(), { expiresIn: 60 });
    const req = { headers: { authorization: `Bearer ${valid}` }, socket: {} } as unknown as IncomingMessage;
    await handlePilotTunnel(req, stubSocket() as unknown as Duplex, Buffer.alloc(0), accepting as unknown as WebSocketServer);
    expect(attempts().lastRefusal(nodeId)).toBeNull();
  });

  it('keeps the newest refusal per node and a bounded number of nodes', () => {
    const own = new PilotEnrollmentAttempts();
    own.recordRefusal(1, 'enrollment_expired', 10);
    own.recordRefusal(1, 'enrollment_used', 20);
    expect(own.lastRefusal(1)).toEqual({ reason: 'enrollment_used', at: 20 });
    for (let id = 100; id < 1200; id += 1) own.recordRefusal(id, 'enrollment_used', id);
    expect(own.lastRefusal(1)).toBeNull();
    expect(own.lastRefusal(1199)).not.toBeNull();
  });
});
