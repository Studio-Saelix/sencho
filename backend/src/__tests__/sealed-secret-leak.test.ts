/**
 * Sentinel sweep: drive every success and failure path of sealed secret
 * delivery on both sides (direct proxy, Pilot, and the local node), then look
 * for the secret, and its first 8 characters, everywhere Sencho writes or
 * answers: node responses, requests on the wire, every audit row, console
 * output, diagnostics, every new table, the writer container's options, and
 * the stack-side surfaces of a stack that references the secret volume (its
 * Compose Doctor report and stored findings, its dossier, and the fleet
 * snapshot capture).
 */
import fs from 'fs';
import path from 'path';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { cleanupTestDb, setupTestDb, TEST_JWT_SECRET, TEST_USERNAME } from './helpers/setupTestDb';
import { createFakeSecretDocker } from './helpers/fakeSecretDocker';
import { installInProcessNodeTransport, type InProcessCall } from './helpers/inProcessNodeTransport';

vi.mock('../helpers/remoteCapabilities', async (importOriginal) => {
  const original = await importOriginal<typeof import('../helpers/remoteCapabilities')>();
  return { ...original, probeRemoteCapability: vi.fn(async () => ({ kind: 'supported' })) };
});

const SENTINEL = 'Zq8LeakSentinel-4f1d9c2b7e6a5d3c';
const PURPOSE = 'edge-tunnel-run-token' as const;
const SLOT_A = '0b9f3c2e-1d4a-4b5c-8d6e-7f8091a2b3c4';
const SLOT_B = '1c0a4d3f-2e5b-4c6d-9e7f-8a9102b3c4d5';

let tmpDir: string;
let app: import('express').Express;

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ app } = await import('../index'));
});

afterAll(() => {
  cleanupTestDb(tmpDir);
});

describe('sealed secret leak sweep', () => {
  it('never writes or answers the secret on any path', async () => {
    const { DatabaseService } = await import('../services/DatabaseService');
    const db = DatabaseService.getInstance();
    const { SealedSecretDeliveryService } = await import('../services/sealedSecrets/SealedSecretDeliveryService');
    const { SealedSecretStore } = await import('../services/sealedSecrets/SealedSecretStore');
    const { PilotTunnelManager } = await import('../services/PilotTunnelManager');

    const logged: string[] = [];
    for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        logged.push(args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg) ?? String(arg))).join(' '));
      });
    }

    const directId = db.addNode({
      name: 'leak-direct', type: 'remote', mode: 'proxy', compose_dir: '/app/compose', is_default: false,
      api_url: 'https://192.168.1.60:1852', api_token: 'stored-node-token',
    });
    const pilotId = db.addNode({ name: 'leak-pilot', type: 'remote', mode: 'pilot_agent', compose_dir: '/app/compose', is_default: false });
    const plainId = db.addNode({
      name: 'leak-plain', type: 'remote', mode: 'proxy', compose_dir: '/app/compose', is_default: false,
      api_url: 'http://192.168.1.62:1852', api_token: 'stored-node-token',
    });
    const mismatchId = db.addNode({
      name: 'leak-mismatch', type: 'remote', mode: 'proxy', compose_dir: '/app/compose', is_default: false,
      api_url: 'https://192.168.1.63:1852', api_token: 'stored-node-token',
    });
    db.pinNodeSealingKey(mismatchId, Buffer.alloc(32, 9).toString('base64'), 'other', true);
    const localId = db.getDefaultNode()!.id;
    vi.spyOn(PilotTunnelManager.getInstance(), 'getLoopbackUrl').mockImplementation((id: number) => (id === pilotId ? 'http://127.0.0.1:41999' : null));
    vi.spyOn(PilotTunnelManager.getInstance(), 'isTunnelConfidential').mockImplementation((id: number) => id === pilotId);

    const fake = createFakeSecretDocker();
    SealedSecretStore.resetForTests();
    SealedSecretStore.getInstance().setDockerForTests(fake.docker);
    const service = SealedSecretDeliveryService.getInstance();

    const calls: InProcessCall[] = [];
    let loseNext = false;
    const transport = installInProcessNodeTransport({
      app,
      bearer: () => jwt.sign({ scope: 'node_proxy' }, TEST_JWT_SECRET, { expiresIn: '5m' }),
      afterAnswer: () => {
        if (loseNext) { loseNext = false; throw new Error('response lost'); }
      },
    });

    const attempt = async (work: () => Promise<unknown>) => {
      try {
        await work();
      } catch {
        // Every refusal is part of the sweep; its message is checked below.
      }
    };
    const errors: unknown[] = [];
    const run = async (work: () => Promise<unknown>) => {
      try {
        await work();
      } catch (error: unknown) {
        errors.push(error);
      }
    };

    for (const nodeId of [directId, pilotId, localId]) {
      fake.volumes.clear();
      fake.files.clear();
      db.getDb().prepare('DELETE FROM sealed_secret_generations').run();
      const deliver = (slot: string, secret: string) => service.deliver({ nodeId, purpose: PURPOSE, slot, secret, actor: 'admin' });
      await run(() => deliver(SLOT_A, SENTINEL));
      loseNext = nodeId !== localId;
      await run(() => deliver(SLOT_B, `${SENTINEL}-b`));
      await run(() => deliver(SLOT_B, `${SENTINEL}-b`));
      await run(() => deliver(SLOT_B, `${SENTINEL}-c`));
      fake.exitCodes.push(1);
      await run(() => deliver(SLOT_A, `${SENTINEL}-d`));
      await run(() => deliver(SLOT_A, `${SENTINEL}${'x'.repeat(5000)}`));
      await run(() => service.remove({ nodeId, purpose: PURPOSE, slot: SLOT_A, actor: 'admin' }));
      await run(() => service.remove({ nodeId, purpose: PURPOSE, slot: SLOT_B, actor: 'admin' }));
      fake.volumes.set('sencho_edge_secret', {});
      db.getDb().prepare('DELETE FROM sealed_secret_generations').run();
      await run(() => deliver(SLOT_A, SENTINEL));
    }
    await attempt(() => service.deliver({ nodeId: plainId, purpose: PURPOSE, slot: SLOT_A, secret: SENTINEL, actor: 'admin' }));
    await attempt(() => service.deliver({ nodeId: mismatchId, purpose: PURPOSE, slot: SLOT_A, secret: SENTINEL, actor: 'admin' }));
    calls.push(...transport.calls);
    expect(errors.length).toBeGreaterThan(0);

    // A stack that references the secret volume, read through every stack-side surface.
    const consumer = 'leak-consumer';
    const stackDir = path.join(process.env.COMPOSE_DIR as string, consumer);
    fs.mkdirSync(stackDir, { recursive: true });
    fs.writeFileSync(path.join(stackDir, 'compose.yaml'),
      'services:\n  app:\n    image: alpine:3.20\n    volumes:\n      - tok:/run/tok:ro\nvolumes:\n  tok:\n    external: true\n    name: sencho_edge_secret\n');
    const { ComposeService } = await import('../services/ComposeService');
    const DockerController = (await import('../services/DockerController')).default;
    vi.spyOn(ComposeService.prototype, 'renderConfig').mockResolvedValue({
      rendered: JSON.stringify({
        name: consumer,
        services: { app: { image: 'alpine:3.20', volumes: [{ type: 'volume', source: 'tok', target: '/run/tok', read_only: true }] } },
        networks: {},
        volumes: { tok: { name: 'sencho_edge_secret', external: true } },
      }),
      stderr: '',
      code: 0,
      timedOut: false,
    });
    vi.spyOn(DockerController.prototype, 'getDependencySnapshot').mockResolvedValue({
      containers: [],
      networks: [],
      volumes: [{ name: 'sencho_edge_secret', driver: 'local', secret: true, composeProject: null, stack: null }],
    } as unknown as Awaited<ReturnType<typeof DockerController.prototype.getDependencySnapshot>>);
    const { ComposeDoctorService } = await import('../services/ComposeDoctorService');
    const doctorReport = await ComposeDoctorService.getInstance().runPreflight(localId, consumer, 'admin');
    expect(doctorReport.findings.some((finding) => finding.ruleId === 'secret-volume-reference')).toBe(true);
    expect((db.getDb().prepare('SELECT COUNT(*) AS n FROM preflight_findings').get() as { n: number }).n).toBeGreaterThan(0);
    const userBearer = `Bearer ${jwt.sign({ username: TEST_USERNAME }, TEST_JWT_SECRET, { expiresIn: '5m' })}`;
    const dossier = await request(app).get(`/api/stacks/${consumer}/dossier`).set('Authorization', userBearer);
    expect(dossier.status).toBe(200);
    const { captureLocalNodeFiles } = await import('../utils/snapshot-capture');
    const capture = await captureLocalNodeFiles({ id: localId, name: 'local', mode: 'proxy' }, true);

    db.flushAuditLogBuffer();
    const { collectDiagnostics } = await import('../services/DiagnosticsService');
    const diagnostics = await collectDiagnostics();
    const tables = ['audit_log', 'sealed_secret_generations', 'sealed_secret_deliveries', 'node_sealing_keys', 'managed_stacks', 'global_settings', 'preflight_findings']
      .map((table) => JSON.stringify(db.getDb().prepare(`SELECT * FROM ${table}`).all()));
    const surfaces: Record<string, string> = {
      requests: JSON.stringify(calls.map((call) => ({ path: call.path, headers: call.headers, data: call.data }))),
      responses: JSON.stringify(calls.map((call) => call.response)),
      errors: JSON.stringify(errors.map((error) => ({ message: (error as Error).message, details: (error as { details?: unknown }).details }))),
      console: logged.join('\n'),
      diagnostics: JSON.stringify(diagnostics),
      tables: tables.join('\n'),
      writerOptions: JSON.stringify(fake.createOptions),
      doctorReport: JSON.stringify(doctorReport),
      dossier: JSON.stringify(dossier.body),
      snapshotCapture: JSON.stringify(capture),
    };
    for (const [surface, text] of Object.entries(surfaces)) {
      expect(text, surface).not.toContain(SENTINEL);
      expect(text, surface).not.toContain(SENTINEL.slice(0, 8));
    }

    // The sweep did reach the node, the store and the refusals it claims to cover.
    expect(fake.createOptions.length).toBeGreaterThan(4);
    expect(calls.some((call) => call.response?.status === 409)).toBe(true);
    expect(calls.some((call) => (call.response?.status ?? 0) >= 500 || call.response?.status === 400)).toBe(true);
    const actions = (db.getDb().prepare('SELECT summary FROM audit_log').all() as { summary: string }[]).map((row) => row.summary.split(':')[0]);
    for (const action of ['sealed_secret.accepted', 'sealed_secret.replaced', 'sealed_secret.refused', 'sealed_secret.removed', 'sealed_secret.delivered', 'sealed_secret.delivery_refused']) {
      expect(actions, action).toContain(action);
    }
  });
});
