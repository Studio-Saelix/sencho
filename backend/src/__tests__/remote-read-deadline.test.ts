/**
 * Bounded interactive reads against a remote node.
 *
 * The gateway used to forward a GET to a remote node with no deadline, so a
 * node that accepted the connection and went silent left the page pending for as
 * long as the transport allowed. These cases pin the contract: an ordinary read
 * answers within the deadline as an explicit timeout, while streams, downloads,
 * long-running operations, and a disconnected Pilot keep their own lifetimes,
 * and the timeout stays distinguishable from authorization failure and from a
 * confirmed empty answer.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import http from 'http';
import type { AddressInfo, Socket } from 'net';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { setupTestDb, cleanupTestDb, TEST_USERNAME, TEST_JWT_SECRET } from './helpers/setupTestDb';
import {
  INTERACTIVE_REMOTE_READ_TIMEOUT_MS,
  REMOTE_READ_BODY_IDLE_TIMEOUT_MS,
  REMOTE_READ_FAILURE_HEADER,
  REMOTE_READ_TIMEOUT_HEADER,
  SLOW_REMOTE_READ_TIMEOUT_MS,
  isInteractiveRemoteRead,
  isStreamingOrDownloadResponse,
  remoteReadTimeoutMs,
} from '../proxy/interactiveRemoteRead';

/** A stub remote whose answer each case decides. `null` hangs up on the request
 *  side: the socket is accepted and never written to, which is the black-holed
 *  node this feature exists for. */
type Responder = ((req: http.IncomingMessage, res: http.ServerResponse) => void) | null;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

describe('interactive remote read deadline', () => {
  let tmpDir: string;
  let app: import('express').Express;
  let authHeader: string;
  let viewerBearer: string;
  let remoteNodeId: number;
  let pilotNodeId: number;
  let unconfiguredNodeId: number;
  let stub: http.Server;
  let stubUrl: string;
  let responder: Responder = null;
  const stubSockets = new Set<Socket>();

  beforeAll(async () => {
    tmpDir = await setupTestDb();

    stub = http.createServer((req, res) => {
      if (responder) responder(req, res);
    });
    stub.on('connection', (socket: Socket) => {
      stubSockets.add(socket);
      socket.on('close', () => stubSockets.delete(socket));
    });
    await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', resolve));
    stubUrl = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`;

    ({ app } = await import('../index'));

    const { DatabaseService } = await import('../services/DatabaseService');
    remoteNodeId = DatabaseService.getInstance().addNode({
      name: 'silent-remote',
      type: 'remote',
      mode: 'proxy',
      compose_dir: '/tmp',
      is_default: false,
      api_url: stubUrl,
      api_token: 'read-deadline-test-token',
    });
    pilotNodeId = DatabaseService.getInstance().addNode({
      name: 'pilot-offline',
      type: 'remote',
      mode: 'pilot_agent',
      compose_dir: '/tmp',
      is_default: false,
      api_url: '',
      api_token: '',
    });
    unconfiguredNodeId = DatabaseService.getInstance().addNode({
      name: 'unconfigured-remote',
      type: 'remote',
      mode: 'proxy',
      compose_dir: '/tmp',
      is_default: false,
      api_url: '',
      api_token: '',
    });

    const token = jwt.sign({ username: TEST_USERNAME }, TEST_JWT_SECRET, { expiresIn: '10m' });
    authHeader = `Bearer ${token}`;

    // A non-admin request runs the mixed-version RBAC gate before the hop, so
    // the gate's own answer has to stay truthful about a silent node.
    const hash = await bcrypt.hash('password123', 1);
    DatabaseService.getInstance().addUser({ username: 'read-deadline-viewer', password_hash: hash, role: 'viewer' });
    const viewer = DatabaseService.getInstance().getUserByUsername('read-deadline-viewer')!;
    viewerBearer = `Bearer ${jwt.sign(
      { username: 'read-deadline-viewer', role: 'viewer', tv: viewer.token_version },
      TEST_JWT_SECRET,
      { expiresIn: '10m' },
    )}`;
  });

  afterAll(async () => {
    for (const socket of stubSockets) socket.destroy();
    await new Promise<void>((resolve) => stub.close(() => resolve()));
    cleanupTestDb(tmpDir);
  });

  beforeEach(() => {
    responder = null;
  });

  describe('route classification', () => {
    it('treats an ordinary page read as interactive', () => {
      expect(isInteractiveRemoteRead('GET', '/stacks')).toBe(true);
      expect(isInteractiveRemoteRead('GET', '/stacks/statuses')).toBe(true);
      expect(isInteractiveRemoteRead('GET', '/networking/overview?x=1')).toBe(true);
      expect(isInteractiveRemoteRead('GET', '/security/overview')).toBe(true);
      expect(isInteractiveRemoteRead('GET', '/stacks/web/containers')).toBe(true);
    });

    it('keeps work off the interactive clock', () => {
      expect(isInteractiveRemoteRead('POST', '/stacks/web/deploy')).toBe(false);
      expect(isInteractiveRemoteRead('POST', '/stacks/web/update')).toBe(false);
      expect(isInteractiveRemoteRead('DELETE', '/stacks/web')).toBe(false);
    });

    it('keeps streams and downloads off the interactive clock', () => {
      expect(isInteractiveRemoteRead('GET', '/containers/abc/logs')).toBe(false);
      expect(isInteractiveRemoteRead('GET', '/metrics/logs/global/stream')).toBe(false);
      expect(isInteractiveRemoteRead('GET', '/mesh/activity/stream')).toBe(false);
      expect(isInteractiveRemoteRead('GET', '/audit-log/export?format=csv')).toBe(false);
      expect(isInteractiveRemoteRead('GET', '/security/vex/export')).toBe(false);
      expect(isInteractiveRemoteRead('GET', '/stacks/web/files/download?path=a.yml')).toBe(false);
      expect(isInteractiveRemoteRead('GET', '/stacks/web/files/bulk-download')).toBe(false);
    });

    it('recognizes a response that turned out to be a stream or a download', () => {
      expect(isStreamingOrDownloadResponse({ 'content-type': 'text/event-stream' })).toBe(true);
      expect(isStreamingOrDownloadResponse({ 'content-type': 'Text/Event-Stream' })).toBe(true);
      expect(isStreamingOrDownloadResponse({
        'content-type': 'application/gzip',
        'content-disposition': 'attachment; filename="snapshot.tar.gz"',
      })).toBe(true);
      expect(isStreamingOrDownloadResponse({
        'content-type': 'application/gzip',
        'content-disposition': 'Attachment; filename="snapshot.tar.gz"',
      })).toBe(true);
      expect(isStreamingOrDownloadResponse({ 'content-type': 'application/json' })).toBe(false);
    });

    it('gives known-slow reads the longer budget and leaves work unbounded', () => {
      expect(remoteReadTimeoutMs('GET', '/stacks')).toBe(INTERACTIVE_REMOTE_READ_TIMEOUT_MS);
      expect(remoteReadTimeoutMs('GET', '/system/docker-df')).toBe(SLOW_REMOTE_READ_TIMEOUT_MS);
      expect(remoteReadTimeoutMs('GET', '/system/resources')).toBe(SLOW_REMOTE_READ_TIMEOUT_MS);
      expect(remoteReadTimeoutMs('GET', '/volumes/app_data/list')).toBe(SLOW_REMOTE_READ_TIMEOUT_MS);
      expect(remoteReadTimeoutMs('GET', '/volumes/app_data/read?path=x')).toBe(SLOW_REMOTE_READ_TIMEOUT_MS);
      expect(remoteReadTimeoutMs('GET', '/stacks/import/scan?path=/srv')).toBe(SLOW_REMOTE_READ_TIMEOUT_MS);
      expect(remoteReadTimeoutMs('GET', '/stacks/web/update-preview')).toBe(SLOW_REMOTE_READ_TIMEOUT_MS);
      expect(remoteReadTimeoutMs('GET', '/containers/abc/logs')).toBeNull();
      expect(remoteReadTimeoutMs('POST', '/system/docker-df')).toBeNull();
    });
  });

  describe('against a remote node', () => {
    it('answers a healthy read normally, with no timeout marker', async () => {
      responder = (_req, res) => {
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(['web']));
      };

      const res = await request(app)
        .get('/api/stacks')
        .set('Authorization', authHeader)
        .set('x-node-id', String(remoteNodeId));

      expect(res.status).toBe(200);
      expect(res.body).toEqual(['web']);
      expect(res.headers[REMOTE_READ_TIMEOUT_HEADER]).toBeUndefined();
    });

    it('keeps a confirmed empty answer distinct from a timeout', async () => {
      responder = (_req, res) => {
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end('[]');
      };

      const res = await request(app)
        .get('/api/stacks')
        .set('Authorization', authHeader)
        .set('x-node-id', String(remoteNodeId));

      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
      expect(res.headers[REMOTE_READ_TIMEOUT_HEADER]).toBeUndefined();
    });

    it('keeps an authorization failure distinct from a timeout', async () => {
      responder = (_req, res) => {
        res.statusCode = 403;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ error: 'Permission denied.' }));
      };

      const res = await request(app)
        .get('/api/stacks')
        .set('Authorization', authHeader)
        .set('x-node-id', String(remoteNodeId));

      expect(res.status).toBe(403);
      expect(res.body.error).toBe('Permission denied.');
      expect(res.headers[REMOTE_READ_TIMEOUT_HEADER]).toBeUndefined();
    });

    it('answers a black-holed read with an explicit timeout inside the deadline', async () => {
      responder = null;
      const startedAt = Date.now();

      const res = await request(app)
        .get('/api/stacks')
        .set('Authorization', authHeader)
        .set('x-node-id', String(remoteNodeId));

      const elapsed = Date.now() - startedAt;
      expect(res.status).toBe(504);
      expect(res.headers[REMOTE_READ_TIMEOUT_HEADER]).toBe('1');
      expect(res.body.code).toBe('remote_read_timeout');
      expect(res.body.error).toContain('silent-remote');
      expect(res.body.error).not.toMatch(/permission|unauthor/i);
      // Bounded: the gateway answers at its own deadline, not at a transport
      // timeout the test harness happens to impose.
      expect(elapsed).toBeGreaterThanOrEqual(INTERACTIVE_REMOTE_READ_TIMEOUT_MS - 250);
      expect(elapsed).toBeLessThan(INTERACTIVE_REMOTE_READ_TIMEOUT_MS + 4_000);
    }, 20_000);

    it('bounds a GitOps identity read, which hydrates the Git sources page', async () => {
      responder = null;
      const startedAt = Date.now();

      const res = await request(app)
        .get('/api/git-sources')
        .set('Authorization', authHeader)
        .set('x-node-id', String(remoteNodeId));

      expect(res.status).toBe(504);
      expect(res.headers[REMOTE_READ_TIMEOUT_HEADER]).toBe('1');
      expect(Date.now() - startedAt).toBeLessThan(INTERACTIVE_REMOTE_READ_TIMEOUT_MS + 4_000);
    }, 20_000);

    it('returns the whole body when the remote answers its headers at once and finishes after the deadline', async () => {
      // The deadline bounds time to the remote's headers, not the transfer. A
      // healthy but slow body must not be truncated at 5 s.
      responder = (_req, res) => {
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.flushHeaders();
        setTimeout(() => res.end(JSON.stringify(['web'])), INTERACTIVE_REMOTE_READ_TIMEOUT_MS + 1_500);
      };

      const res = await request(app)
        .get('/api/stacks')
        .set('Authorization', authHeader)
        .set('x-node-id', String(remoteNodeId));

      expect(res.status).toBe(200);
      expect(res.body).toEqual(['web']);
      expect(res.headers[REMOTE_READ_TIMEOUT_HEADER]).toBeUndefined();
    }, 20_000);

    it('returns the whole body on the identity hop when headers arrive before the body', async () => {
      responder = (_req, res) => {
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.flushHeaders();
        setTimeout(() => res.end(JSON.stringify([])), INTERACTIVE_REMOTE_READ_TIMEOUT_MS + 1_500);
      };

      const res = await request(app)
        .get('/api/git-sources')
        .set('Authorization', authHeader)
        .set('x-node-id', String(remoteNodeId));

      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
      expect(res.headers[REMOTE_READ_TIMEOUT_HEADER]).toBeUndefined();
    }, 20_000);

    it('releases the deadline at the headers of an attachment and lets its body finish', async () => {
      // `/api/stacks` is an ordinary read with no path exemption, so this
      // exercises the header-based release itself.
      responder = (_req, res) => {
        res.statusCode = 200;
        res.setHeader('content-type', 'text/plain');
        res.setHeader('content-disposition', 'Attachment; filename="snapshot.tar.gz"');
        res.flushHeaders();
        setTimeout(() => res.end('payload'), INTERACTIVE_REMOTE_READ_TIMEOUT_MS + 1_500);
      };

      const res = await request(app)
        .get('/api/stacks')
        .set('Authorization', authHeader)
        .set('x-node-id', String(remoteNodeId));

      expect(res.status).toBe(200);
      expect(res.text).toBe('payload');
      expect(res.headers[REMOTE_READ_TIMEOUT_HEADER]).toBeUndefined();
    }, 20_000);

    it('ends a body that stalls after its headers at the idle bound, not at the header deadline', async () => {
      // Headers say 200, then nothing moves. The time-to-headers budget is
      // released, so the bound that ends it is the body-idle one.
      responder = (_req, res) => {
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.flushHeaders();
      };
      const socketsBefore = stubSockets.size;
      const startedAt = Date.now();

      const outcome = await request(app)
        .get('/api/stacks')
        .set('Authorization', authHeader)
        .set('x-node-id', String(remoteNodeId))
        .then(() => 'resolved' as const, () => 'rejected' as const);

      const elapsed = Date.now() - startedAt;
      expect(outcome).toBe('rejected');
      expect(elapsed).toBeGreaterThanOrEqual(INTERACTIVE_REMOTE_READ_TIMEOUT_MS + 1_000);
      expect(elapsed).toBeGreaterThanOrEqual(REMOTE_READ_BODY_IDLE_TIMEOUT_MS - 500);
      expect(elapsed).toBeLessThan(REMOTE_READ_BODY_IDLE_TIMEOUT_MS + 4_000);
      // Ending the stalled transfer must close the upstream socket too, not
      // leave the remote connection open after both callers are gone.
      await expect.poll(() => stubSockets.size, { timeout: 3_000 }).toBeLessThanOrEqual(socketsBefore);
    }, 25_000);

    it('waits past the interactive budget for a known-slow read before calling it silent', async () => {
      // `docker system df` is given a longer time-to-headers budget; a slow
      // first byte that a healthy node produces must return 200, not a 504.
      responder = (_req, res) => {
        setTimeout(() => {
          res.statusCode = 200;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ totalSize: 0 }));
        }, INTERACTIVE_REMOTE_READ_TIMEOUT_MS + 1_000);
      };

      const res = await request(app)
        .get('/api/system/docker-df')
        .set('Authorization', authHeader)
        .set('x-node-id', String(remoteNodeId));

      expect(res.status).toBe(200);
      expect(res.headers[REMOTE_READ_TIMEOUT_HEADER]).toBeUndefined();
    }, 20_000);

    it('reports a silent node as unavailable to a non-admin, not as an old node', async () => {
      responder = null;

      const res = await request(app)
        .get('/api/stacks')
        .set('Authorization', viewerBearer)
        .set('x-node-id', String(remoteNodeId));

      // The capability probe could not run, which proves nothing about the
      // remote's version: answering "upgrade it" would send an operator to fix
      // the wrong thing.
      expect(res.status).toBe(503);
      expect(res.body.code).toBe('remote_unreachable');
      expect(res.body.error).not.toMatch(/upgrade/i);
    }, 20_000);

    it('still refuses a reachable node that does not enforce per-user permissions', async () => {
      responder = (_req, res) => {
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ version: '0.1.0', capabilities: ['fleet'] }));
      };

      const res = await request(app)
        .get('/api/stacks')
        .set('Authorization', viewerBearer)
        .set('x-node-id', String(remoteNodeId));

      expect(res.status).toBe(403);
      expect(res.body.error).toMatch(/does not enforce per-user permissions/i);
    }, 20_000);

    it('does not claim silence when the permission probe got an HTTP error', async () => {
      responder = (req, res) => {
        if (req.url?.startsWith('/api/meta')) {
          res.statusCode = 502;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ error: 'bad gateway' }));
          return;
        }
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify([]));
      };

      const res = await request(app)
        .get('/api/stacks')
        .set('Authorization', viewerBearer)
        .set('x-node-id', String(remoteNodeId));

      expect(res.status).toBe(503);
      expect(res.body.code).toBe('remote_unverified');
      expect(res.body.error).not.toMatch(/did not answer|unreachable/i);
      expect(res.headers[REMOTE_READ_FAILURE_HEADER]).toBe('unverified');
    }, 20_000);

    it('shares one capability probe across concurrent non-admin reads', async () => {
      let metaCalls = 0;
      responder = (req, res) => {
        if (req.url?.startsWith('/api/meta')) {
          metaCalls += 1;
          setTimeout(() => {
            res.statusCode = 200;
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify({
              version: '0.97.1',
              capabilities: ['cross-node-rbac'],
              startedAt: null,
              updateError: null,
              imagePinKind: null,
              updateBlocked: false,
              imageChannel: null,
            }));
          }, 300);
          return;
        }
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify([]));
      };

      const [first, second] = await Promise.all([
        request(app)
          .get('/api/stacks')
          .set('Authorization', viewerBearer)
          .set('x-node-id', String(remoteNodeId)),
        request(app)
          .get('/api/stacks/statuses')
          .set('Authorization', viewerBearer)
          .set('x-node-id', String(remoteNodeId)),
      ]);

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(metaCalls).toBe(1);
    }, 20_000);

    it('counts a slow permission probe against the read budget instead of adding to it', async () => {
      // The probe takes 4 s, then the read hangs. The total wait must stay
      // inside the client backstop rather than 5 s for the probe plus 5 s for
      // the read.
      responder = (req, res) => {
        if (req.url?.startsWith('/api/meta')) {
          setTimeout(() => {
            res.statusCode = 200;
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify({
              version: '0.97.1',
              capabilities: ['cross-node-rbac'],
              startedAt: null,
              updateError: null,
              imagePinKind: null,
              updateBlocked: false,
              imageChannel: null,
            }));
          }, 4_000);
        }
      };
      const startedAt = Date.now();

      const res = await request(app)
        .get('/api/stacks')
        .set('Authorization', viewerBearer)
        .set('x-node-id', String(remoteNodeId));

      const elapsed = Date.now() - startedAt;
      expect(res.status).toBe(504);
      expect(res.headers[REMOTE_READ_TIMEOUT_HEADER]).toBe('1');
      expect(elapsed).toBeGreaterThanOrEqual(INTERACTIVE_REMOTE_READ_TIMEOUT_MS - 300);
      expect(elapsed).toBeLessThan(INTERACTIVE_REMOTE_READ_TIMEOUT_MS + 2_500);
    }, 20_000);

    it('does not bound a long-running operation', async () => {
      responder = null;

      const pending = request(app)
        .post('/api/stacks/web/deploy')
        .set('Authorization', authHeader)
        .set('x-node-id', String(remoteNodeId))
        .send({});
      const settled = await Promise.race([
        pending.then(() => 'responded', () => 'failed'),
        sleep(INTERACTIVE_REMOTE_READ_TIMEOUT_MS + 1_500).then(() => 'pending'),
      ]);

      expect(settled).toBe('pending');
      pending.abort();
    }, 20_000);

    it('does not bound a log stream', async () => {
      responder = null;

      const pending = request(app)
        .get('/api/containers/abc/logs')
        .set('Authorization', authHeader)
        .set('x-node-id', String(remoteNodeId));
      const settled = await Promise.race([
        pending.then(() => 'responded', () => 'failed'),
        sleep(INTERACTIVE_REMOTE_READ_TIMEOUT_MS + 1_500).then(() => 'pending'),
      ]);

      expect(settled).toBe('pending');
      pending.abort();
    }, 20_000);

    it('releases the deadline once a read turns out to be a stream', async () => {
      responder = (_req, res) => {
        res.statusCode = 200;
        res.setHeader('content-type', 'text/event-stream');
        res.flushHeaders();
        // Then stay silent, like an idle activity feed.
      };

      const pending = request(app)
        .get('/api/stacks')
        .set('Authorization', authHeader)
        .set('x-node-id', String(remoteNodeId));
      const settled = await Promise.race([
        pending.then(() => 'responded', () => 'failed'),
        sleep(INTERACTIVE_REMOTE_READ_TIMEOUT_MS + 800).then(() => 'pending'),
      ]);

      expect(settled).toBe('pending');
      pending.abort();
    }, 20_000);

    it('fails a disconnected Pilot promptly, without waiting out the deadline', async () => {
      responder = null;
      const startedAt = Date.now();

      const res = await request(app)
        .get('/api/stacks')
        .set('Authorization', authHeader)
        .set('x-node-id', String(pilotNodeId));

      expect(res.status).toBe(503);
      expect(res.body.error).toMatch(/pilot tunnel/i);
      expect(res.headers[REMOTE_READ_FAILURE_HEADER]).toBe('pilot-disconnected');
      expect(Date.now() - startedAt).toBeLessThan(1_000);
    });

    it('names a node with no configured target instead of calling it unreachable', async () => {
      responder = null;

      const res = await request(app)
        .get('/api/stacks')
        .set('Authorization', authHeader)
        .set('x-node-id', String(unconfiguredNodeId));

      expect(res.status).toBe(503);
      expect(res.body.error).toMatch(/no api url or token/i);
      expect(res.headers[REMOTE_READ_FAILURE_HEADER]).toBe('not-configured');
    });
  });
});
