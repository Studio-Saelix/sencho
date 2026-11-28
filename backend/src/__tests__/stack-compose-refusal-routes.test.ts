/**
 * A stack whose inputs Sencho refuses to hand to Compose can still be running
 * (it ran before the file grew an alias bomb). Every route over such a stack
 * must say why it cannot act and must never answer with an empty list, a bare
 * 500, or a success for work it did not do. Delete in particular must not remove
 * the files of a stack whose containers are still bound to its directory.
 *
 * The refusal here is the guard's real exception class. Compose, the container
 * listing, the Engine lookup and the Docker endpoint guard are stubbed, so these
 * tests pin the route and deletion behavior; the real guard-to-delete wiring is
 * covered by the last describe block.
 */
import fs from 'fs';
import path from 'path';
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { setupTestDb, cleanupTestDb, loginAsTestAdmin } from './helpers/setupTestDb';
import { ComposeExpansionRefusal } from '../helpers/composeExpansionGuard';

const REFUSAL = 'Compose file "bomb.yaml" expands to more than 250,000 nodes, normally through nested YAML aliases. Sencho refused to run it.';

/** A small file whose nested anchors expand past the guard's node budget. */
const ALIAS_BOMB = (() => {
  const lines = ['x0: &a0 [lol, lol, lol, lol, lol, lol, lol, lol, lol]'];
  for (let level = 1; level <= 12; level += 1) {
    const refs = Array.from({ length: 9 }, () => `*a${level - 1}`).join(', ');
    lines.push(`x${level}: &a${level} [${refs}]`);
  }
  lines.push('services:', '  web:', '    image: nginx:alpine');
  return `${lines.join('\n')}\n`;
})();

const mocks = {
  runDown: vi.fn(),
  downStack: vi.fn(),
  getContainersByStack: vi.fn(),
  listBound: vi.fn(),
  stopContainer: vi.fn(),
  restartContainer: vi.fn(),
  pruneManagedOnly: vi.fn(),
};

let dispatchAlert: ReturnType<typeof vi.spyOn>;
let tmpDir: string;
let ComposeService: typeof import('../services/ComposeService').ComposeService;
let DockerController: typeof import('../services/DockerController').default;
let app: import('express').Express;
let authCookie: string;

function stackDir(name: string): string {
  return path.join(process.env.COMPOSE_DIR!, name);
}

function writeStack(name: string) {
  fs.mkdirSync(stackDir(name), { recursive: true });
  fs.writeFileSync(path.join(stackDir(name), 'compose.yaml'), 'services:\n  web:\n    image: nginx\n');
}

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ ComposeService } = await import('../services/ComposeService'));
  ({ default: DockerController } = await import('../services/DockerController'));
  ({ app } = await import('../index'));
  authCookie = await loginAsTestAdmin(app);
});

afterAll(() => {
  vi.restoreAllMocks();
  cleanupTestDb(tmpDir);
});

beforeEach(async () => {
  vi.restoreAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.getContainersByStack.mockRejectedValue(new ComposeExpansionRefusal(REFUSAL));
  mocks.runDown.mockRejectedValue(new ComposeExpansionRefusal(REFUSAL));
  mocks.downStack.mockRejectedValue(new ComposeExpansionRefusal(REFUSAL));
  mocks.listBound.mockResolvedValue([]);
  mocks.pruneManagedOnly.mockResolvedValue(undefined);
  vi.spyOn(ComposeService.prototype, 'evaluateDockerEndpoint').mockResolvedValue(null);
  vi.spyOn(ComposeService.prototype, 'runDown').mockImplementation(mocks.runDown);
  vi.spyOn(ComposeService.prototype, 'downStack').mockImplementation(mocks.downStack);
  vi.spyOn(ComposeService.prototype, 'renderConfig').mockResolvedValue({
    rendered: null, stderr: '', code: null, timedOut: false, refusal: REFUSAL,
  });
  vi.spyOn(DockerController.prototype, 'getContainersByStack').mockImplementation(mocks.getContainersByStack);
  vi.spyOn(DockerController.prototype, 'listContainersBoundToStackDir').mockImplementation(mocks.listBound);
  vi.spyOn(DockerController.prototype, 'stopContainer').mockImplementation(mocks.stopContainer);
  vi.spyOn(DockerController.prototype, 'restartContainer').mockImplementation(mocks.restartContainer);
  vi.spyOn(DockerController.prototype, 'assertNoDockerEndpointContainers').mockResolvedValue(undefined);
  vi.spyOn(DockerController.prototype, 'pruneManagedOnly').mockImplementation(mocks.pruneManagedOnly);
  const { NotificationService } = await import('../services/NotificationService');
  dispatchAlert = vi.spyOn(NotificationService.getInstance(), 'dispatchAlert').mockResolvedValue({ persisted: true });
  const { MeshService } = await import('../services/MeshService');
  vi.spyOn(MeshService.getInstance(), 'optOutStack').mockResolvedValue(undefined);
  writeStack('refused');
  const { StackOpLockService } = await import('../services/StackOpLockService');
  StackOpLockService.resetForTests();
});

describe('refused stack: operations that need Compose to read it say why', () => {
  it('GET /containers answers 409 with the refusal, not an empty list', async () => {
    const res = await request(app).get('/api/stacks/refused/containers').set('Cookie', authCookie);
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: REFUSAL, code: 'compose_inputs_refused' });
  });

  it.each(['stop', 'restart', 'start'] as const)('POST /%s answers 409 with the refusal, not 404 "No containers"', async (action) => {
    const res = await request(app).post(`/api/stacks/refused/${action}`).set('Cookie', authCookie);
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: REFUSAL, code: 'compose_inputs_refused' });
    expect(mocks.stopContainer).not.toHaveBeenCalled();
    expect(mocks.restartContainer).not.toHaveBeenCalled();
    expect(dispatchAlert).not.toHaveBeenCalled();
  });

  it.each(['stop', 'restart', 'start'] as const)('POST /services/web/%s answers 409 with the refusal', async (action) => {
    const res = await request(app).post(`/api/stacks/refused/services/web/${action}`).set('Cookie', authCookie);
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: REFUSAL, code: 'compose_inputs_refused' });
  });

  it('POST /down answers 409 with the refusal instead of "Failed to start command"', async () => {
    const res = await request(app).post('/api/stacks/refused/down').set('Cookie', authCookie);
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: REFUSAL, code: 'compose_inputs_refused' });
    // A refusal ran nothing, so it stays out of the failure feed.
    expect(dispatchAlert).not.toHaveBeenCalled();
  });

  it('POST /down still reports an ordinary failure to the failure feed (control)', async () => {
    mocks.runDown.mockRejectedValue(new Error('daemon said no'));
    const res = await request(app).post('/api/stacks/refused/down').set('Cookie', authCookie);
    expect(res.status).toBe(500);
    expect(dispatchAlert).toHaveBeenCalled();
  });

  it('POST /down?removeVolumes=true carries the refusal too', async () => {
    const res = await request(app).post('/api/stacks/refused/down?removeVolumes=true').set('Cookie', authCookie);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('compose_inputs_refused');
    expect(res.body.error).toBe(REFUSAL);
  });

  it('GET /label-inventory answers 409 with the refusal instead of a 500', async () => {
    const res = await request(app).get('/api/stacks/refused/label-inventory').set('Cookie', authCookie);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('compose_inputs_refused');
  });

  it('bulk stop reports the refusal per stack with its code', async () => {
    const res = await request(app)
      .post('/api/stacks/bulk')
      .set('Cookie', authCookie)
      .send({ action: 'stop', stackNames: ['refused'] });
    expect(res.status).toBe(200);
    expect(res.body.results).toEqual([
      { stackName: 'refused', ok: false, error: REFUSAL, code: 'compose_inputs_refused' },
    ]);
    expect(dispatchAlert).not.toHaveBeenCalled();
  });
});

describe('refused stack: Delete never orphans running containers', () => {
  it('refuses with the reason and keeps the files when containers are still bound to the directory', async () => {
    mocks.listBound.mockResolvedValue([
      { Id: 'a', Name: 'refused-web-1', State: 'running' },
      { Id: 'b', Name: 'refused-db-1', State: 'running' },
    ]);

    const res = await request(app).delete('/api/stacks/refused').set('Cookie', authCookie);

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('compose_inputs_refused');
    expect(res.body.error).toContain(REFUSAL);
    expect(res.body.error).toContain('2 containers');
    expect(res.body.error).toContain('refused-web-1');
    expect(fs.existsSync(path.join(stackDir('refused'), 'compose.yaml'))).toBe(true);
  });

  it('refuses when the Engine lookup itself fails: unknown is not none', async () => {
    mocks.listBound.mockRejectedValue(new Error('engine unreachable'));

    const res = await request(app).delete('/api/stacks/refused').set('Cookie', authCookie);

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('compose_inputs_refused');
    expect(res.body.error).toContain('could not check whether containers');
    expect(fs.existsSync(path.join(stackDir('refused'), 'compose.yaml'))).toBe(true);
  });

  it('keeps the volumes of a refused delete that still has containers, even when pruning was asked for', async () => {
    mocks.listBound.mockResolvedValue([{ Id: 'a', Name: 'refused-web-1', State: 'running' }]);

    const res = await request(app).delete('/api/stacks/refused?pruneVolumes=true').set('Cookie', authCookie);

    expect(res.status).toBe(409);
    expect(mocks.pruneManagedOnly).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(stackDir('refused'), 'compose.yaml'))).toBe(true);
  });

  it('prunes the volumes of a refused delete once nothing is bound to the stack', async () => {
    const res = await request(app).delete('/api/stacks/refused?pruneVolumes=true').set('Cookie', authCookie);

    expect(res.status).toBe(200);
    expect(mocks.pruneManagedOnly).toHaveBeenCalledWith('volumes', ['refused']);
  });

  it('cancels the deletion intent of a refused delete, so a retry is not blocked and boot does not replay it', async () => {
    const { DatabaseService } = await import('../services/DatabaseService');
    const status = () => (DatabaseService.getInstance().getDb()
      .prepare('SELECT status FROM stack_update_cleanup_pending WHERE stack_name = ? ORDER BY created_at DESC LIMIT 1')
      .get('refused') as { status: string } | undefined)?.status;

    mocks.listBound.mockResolvedValue([{ Id: 'a', Name: 'refused-web-1', State: 'running' }]);
    expect((await request(app).delete('/api/stacks/refused').set('Cookie', authCookie)).status).toBe(409);
    expect(status()).toBe('cancelled');

    mocks.listBound.mockRejectedValue(new Error('engine unreachable'));
    expect((await request(app).delete('/api/stacks/refused').set('Cookie', authCookie)).status).toBe(409);
    expect(status()).toBe('cancelled');

    // The same name deletes once nothing is left behind.
    mocks.listBound.mockResolvedValue([]);
    expect((await request(app).delete('/api/stacks/refused').set('Cookie', authCookie)).status).toBe(200);
  });

  it('names at most five containers and counts the rest', async () => {
    mocks.listBound.mockResolvedValue(
      Array.from({ length: 7 }, (_, i) => ({ Id: `c${i}`, Name: `refused-svc${i}-1`, State: 'running' })),
    );

    const res = await request(app).delete('/api/stacks/refused').set('Cookie', authCookie);

    expect(res.body.error).toContain('7 containers');
    expect(res.body.error).toContain('refused-svc4-1');
    expect(res.body.error).not.toContain('refused-svc5-1');
    expect(res.body.error).toContain('and 2 more');
  });

  it('says "1 container" for a single one', async () => {
    mocks.listBound.mockResolvedValue([{ Id: 'a', Name: 'refused-web-1', State: 'exited' }]);

    const res = await request(app).delete('/api/stacks/refused').set('Cookie', authCookie);

    expect(res.body.error).toContain('1 container of this stack');
  });

  it('still removes a refused stack that has no container bound to it', async () => {
    mocks.listBound.mockResolvedValue([]);

    const res = await request(app).delete('/api/stacks/refused').set('Cookie', authCookie);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    expect(fs.existsSync(stackDir('refused'))).toBe(false);
  });

  it('still tears down an ordinary stack through Compose and removes it', async () => {
    mocks.downStack.mockResolvedValue(undefined);

    const res = await request(app).delete('/api/stacks/refused').set('Cookie', authCookie);

    expect(res.status).toBe(200);
    expect(mocks.listBound).not.toHaveBeenCalled();
    expect(fs.existsSync(stackDir('refused'))).toBe(false);
  });
});

describe('refused stack: Blueprint withdraw-local (the remote-node delete path)', () => {
  function markAsBlueprint(name: string, blueprintId: number) {
    fs.writeFileSync(
      path.join(stackDir(name), '.blueprint.json'),
      JSON.stringify({ blueprintId, revision: 1, lastApplied: Date.now() }),
    );
  }

  it('answers 409 with the code and keeps the files while containers are still bound', async () => {
    markAsBlueprint('refused', 7);
    mocks.listBound.mockResolvedValue([{ Id: 'a', Name: 'refused-web-1', State: 'running' }]);

    const res = await request(app)
      .post('/api/blueprints/withdraw-local')
      .set('Cookie', authCookie)
      .send({ stackName: 'refused', blueprintId: 7 });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('compose_inputs_refused');
    expect(res.body.error).toContain(REFUSAL);
    expect(fs.existsSync(path.join(stackDir('refused'), 'compose.yaml'))).toBe(true);
  });

  it('withdraws a refused stack that has no bound container', async () => {
    markAsBlueprint('refused', 7);

    const res = await request(app)
      .post('/api/blueprints/withdraw-local')
      .set('Cookie', authCookie)
      .send({ stackName: 'refused', blueprintId: 7 });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('withdrawn');
    expect(fs.existsSync(stackDir('refused'))).toBe(false);
  });
});

describe('refused stack: the Fleet container list', () => {
  it('answers 409 with the refusal for a local node instead of an empty list', async () => {
    const res = await request(app).get('/api/fleet/node/1/stacks/refused/containers').set('Cookie', authCookie);
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: REFUSAL, code: 'compose_inputs_refused' });
  });

  it('carries a remote node\'s refusal through instead of a bare 502', async () => {
    const { DatabaseService } = await import('../services/DatabaseService');
    const { NodeRegistry } = await import('../services/NodeRegistry');
    const outbound = await import('../utils/outboundTarget');
    vi.spyOn(DatabaseService.getInstance(), 'getNode').mockReturnValue({ id: 9, type: 'remote', name: 'edge' } as never);
    vi.spyOn(NodeRegistry.getInstance(), 'getProxyTarget').mockReturnValue({ apiUrl: 'http://edge.invalid', apiToken: 't', trustedLoopback: false } as never);
    vi.spyOn(outbound, 'safeRemoteFetch').mockResolvedValue(
      new Response(JSON.stringify({ error: REFUSAL, code: 'compose_inputs_refused' }), { status: 409 }),
    );

    const res = await request(app).get('/api/fleet/node/9/stacks/refused/containers').set('Cookie', authCookie);

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: REFUSAL, code: 'compose_inputs_refused' });
  });

  it('keeps a bare 502 for a remote failure that is not a refusal', async () => {
    const { DatabaseService } = await import('../services/DatabaseService');
    const { NodeRegistry } = await import('../services/NodeRegistry');
    const outbound = await import('../utils/outboundTarget');
    vi.spyOn(DatabaseService.getInstance(), 'getNode').mockReturnValue({ id: 9, type: 'remote', name: 'edge' } as never);
    vi.spyOn(NodeRegistry.getInstance(), 'getProxyTarget').mockReturnValue({ apiUrl: 'http://edge.invalid', apiToken: 't', trustedLoopback: false } as never);
    vi.spyOn(outbound, 'safeRemoteFetch').mockResolvedValue(
      new Response(JSON.stringify({ error: 'Conflict of another kind', code: 'stack_op_in_progress' }), { status: 409 }),
    );

    const res = await request(app).get('/api/fleet/node/9/stacks/refused/containers').set('Cookie', authCookie);

    expect(res.status).toBe(502);
  });
});

describe('refused stack: GET /services names the refusal', () => {
  function writeCompose(content: string) {
    fs.mkdirSync(stackDir('refused'), { recursive: true });
    fs.writeFileSync(path.join(stackDir('refused'), 'compose.yaml'), content);
  }

  it('answers 409 with the guard text for an over-cap file, not the YAML library 500', async () => {
    writeCompose(ALIAS_BOMB);

    const res = await request(app).get('/api/stacks/refused/services').set('Cookie', authCookie);

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('compose_inputs_refused');
    expect(res.body.error).toContain('Compose file "compose.yaml"');
    expect(res.body.error).toContain('nested YAML aliases');
    expect(res.body.error).not.toContain(stackDir('refused'));
  });

  it('lists services when one anchor is reused more often than the YAML library default', async () => {
    const services = Array.from({ length: 150 }, (_, i) => `  svc${i}:\n    image: *image`);
    writeCompose(['x-image: &image nginx:alpine', 'services:', ...services].join('\n'));

    const res = await request(app).get('/api/stacks/refused/services').set('Cookie', authCookie);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(150);
    expect(res.body).toContain('svc0');
    expect(res.body).toContain('svc149');
  });

  it('answers 409 with a reason when one document reuses aliases past the shared budget', async () => {
    const refs = Array.from({ length: 10_001 }, () => '*label').join(', ');
    writeCompose(`x-label: &label app=web\nservices:\n  web:\n    labels: [${refs}]\n`);

    const res = await request(app).get('/api/stacks/refused/services').set('Cookie', authCookie);

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('compose_inputs_refused');
    expect(res.body.error).toContain('Compose file "compose.yaml"');
    expect(res.body.error).toContain('beyond the 10,000-reference budget');
    expect(res.body.error).not.toContain(stackDir('refused'));
  });
});

describe('refused stack: the real guard, the real down, and Delete together', () => {
  beforeEach(() => {
    // The refusal below comes from the real guard reading a real file; only the
    // Docker endpoint guard and the spawn are out of the picture.
    vi.mocked(ComposeService.prototype.downStack).mockRestore();
    vi.spyOn(ComposeService.prototype as unknown as { assertDockerEndpointSafe: () => Promise<void> }, 'assertDockerEndpointSafe').mockResolvedValue(undefined);
    fs.writeFileSync(path.join(stackDir('refused'), 'compose.yaml'), ALIAS_BOMB);
  });

  it('keeps the files of a bombed stack whose containers are still bound, and says why', async () => {
    mocks.listBound.mockResolvedValue([{ Id: 'a', Name: 'refused-web-1', State: 'running' }]);

    const res = await request(app).delete('/api/stacks/refused').set('Cookie', authCookie);

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('compose_inputs_refused');
    expect(res.body.error).toContain('nested YAML aliases');
    expect(res.body.error).toContain('refused-web-1');
    expect(fs.existsSync(path.join(stackDir('refused'), 'compose.yaml'))).toBe(true);
  });

  it('still deletes a bombed stack with nothing bound to it', async () => {
    const res = await request(app).delete('/api/stacks/refused').set('Cookie', authCookie);

    expect(res.status).toBe(200);
    expect(fs.existsSync(stackDir('refused'))).toBe(false);
  });
});
