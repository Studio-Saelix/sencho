import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { setupTestDb, cleanupTestDb, TEST_USERNAME, TEST_JWT_SECRET } from './helpers/setupTestDb';
import { DatabaseService } from '../services/DatabaseService';

let tmpDir: string;
let app: import('express').Express;
let authHeader: string;

async function createPilotNode(name: string): Promise<number> {
  const res = await request(app)
    .post('/api/nodes')
    .set('Authorization', authHeader)
    .send({
      name,
      type: 'remote',
      mode: 'pilot_agent',
      compose_dir: '/opt/docker/sencho',
    });
  expect(res.status).toBe(200);
  return res.body.id as number;
}

function markConnected(nodeId: number): void {
  DatabaseService.getInstance().getDb()
    .prepare('UPDATE nodes SET pilot_last_seen = ? WHERE id = ?')
    .run(Date.now(), nodeId);
}

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ app } = await import('../index'));
  authHeader = `Bearer ${jwt.sign({ username: TEST_USERNAME }, TEST_JWT_SECRET, { expiresIn: '1m' })}`;
});

afterAll(() => cleanupTestDb(tmpDir));

describe('connected Pilot Compose directory lock', () => {
  it('lets a never-connected Pilot be corrected', async () => {
    const nodeId = await createPilotNode('never-connected-pilot');
    const res = await request(app)
      .put(`/api/nodes/${nodeId}`)
      .set('Authorization', authHeader)
      .send({ compose_dir: '/srv/corrected-stacks' });
    expect(res.status).toBe(200);
    expect(DatabaseService.getInstance().getNode(nodeId)?.compose_dir).toBe('/srv/corrected-stacks');
  });

  it('rejects a changed directory for a connected Pilot with PILOT_COMPOSE_DIR_LOCKED', async () => {
    const nodeId = await createPilotNode('connected-pilot');
    markConnected(nodeId);
    const res = await request(app)
      .put(`/api/nodes/${nodeId}`)
      .set('Authorization', authHeader)
      .send({ compose_dir: '/srv/moved-stacks' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PILOT_COMPOSE_DIR_LOCKED');
    expect(res.body.error).toMatch(/relocation/i);
    expect(DatabaseService.getInstance().getNode(nodeId)?.compose_dir).toBe('/opt/docker/sencho');
  });

  it('accepts the unchanged directory and other fields on a connected Pilot', async () => {
    const nodeId = await createPilotNode('connected-pilot-rename');
    markConnected(nodeId);
    const res = await request(app)
      .put(`/api/nodes/${nodeId}`)
      .set('Authorization', authHeader)
      .send({ name: 'connected-pilot-renamed', compose_dir: '/opt/docker/sencho' });
    expect(res.status).toBe(200);
    const node = DatabaseService.getInstance().getNode(nodeId);
    expect(node?.name).toBe('connected-pilot-renamed');
    expect(node?.compose_dir).toBe('/opt/docker/sencho');
  });

  it('leaves a proxy node free to change its compose directory', async () => {
    const created = await request(app)
      .post('/api/nodes')
      .set('Authorization', authHeader)
      .send({
        name: 'proxy-node',
        type: 'remote',
        mode: 'proxy',
        api_url: 'http://192.168.1.60:1852',
        api_token: 'tok',
        compose_dir: '/app/compose',
      });
    expect(created.status).toBe(200);
    const res = await request(app)
      .put(`/api/nodes/${created.body.id}`)
      .set('Authorization', authHeader)
      .send({ compose_dir: '/srv/proxy-stacks' });
    expect(res.status).toBe(200);
    expect(DatabaseService.getInstance().getNode(created.body.id)?.compose_dir).toBe('/srv/proxy-stacks');
  });
});
