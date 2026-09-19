import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
const mocks = vi.hoisted(() => ({ readLocal: vi.fn(), verify: vi.fn(), consume: vi.fn(), apply: vi.fn(), permission: vi.fn(), invalidate: vi.fn() }));
vi.mock('../middleware/auth', () => ({ authMiddleware: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
  req.machineAuthScope = req.headers['x-test-machine'] === 'yes' ? 'node_proxy' : undefined;
  req.nodeId = 1;
  next();
} }));
vi.mock('../middleware/permissions', () => ({ requirePermission: mocks.permission }));
vi.mock('../helpers/policyGate', () => ({ buildPolicyGateOptions: () => ({ bypass: false, actor: 'test' }) }));
vi.mock('../helpers/fleetUpdateCache', () => ({ invalidateFleetUpdateCache: mocks.invalidate }));
vi.mock('../services/ImageUpdateFactsService', () => ({
  ImageUpdateFactsService: { getInstance: () => ({ readLocal: mocks.readLocal }) },
  ImageUpdateFactsError: class extends Error {},
}));
vi.mock('../services/ImageUpdateObservationService', () => ({
  ImageUpdateObservationService: { getInstance: () => ({ verifyCurrent: mocks.verify, consumeCurrent: mocks.consume }) },
  ImageUpdateObservationError: class extends Error { constructor(public code: string, public status: number) { super(code); } },
}));
vi.mock('../services/automaticStackUpdate', () => ({ applyAutomaticStackUpdate: mocks.apply }));
vi.mock('../services/hubPostUpdateVerification', () => ({ skippedVerification: () => ({ status: 'skipped', source: 'skipped', completedAt: null, detail: null }) }));
import { checkedAutoUpdateRouter } from '../routes/checkedAutoUpdate';
import { hashImageUpdateFacts } from '../services/imageUpdateFacts';

const facts = { model: { renderable: true as const }, services: [], images: [{ ref: 'nginx:1', localDigests: ['sha256:abc'], platform: { os: 'linux', architecture: 'amd64' }, emptyReason: 'none' as const }] };
const body = { contractVersion: 1, stack: 'web', digestUpdateImages: ['nginx:1'], observationToken: 'token' };
const app = express();
app.use(express.json());
app.use('/api/auto-update', checkedAutoUpdateRouter);
beforeEach(() => {
  vi.resetAllMocks();
  mocks.permission.mockReturnValue(true);
  mocks.readLocal.mockResolvedValue(facts);
  mocks.verify.mockReturnValue({ factsHash: hashImageUpdateFacts(facts) });
  mocks.apply.mockImplementation(async ({ observation }) => {
    await observation.verify();
    await observation.consume();
    return { applied: true, result: 'applied', healthGateId: 'health' };
  });
});

describe('checked automatic update route', () => {
  it('rejects browser authentication before mutation', async () => {
    const response = await request(app).post('/api/auto-update/execute-checked').send(body);
    expect(response.status).toBe(403);
    expect(mocks.apply).not.toHaveBeenCalled();
  });
  it('validates singular contract and deduplicated nonempty image list', async () => {
    for (const invalid of [{ ...body, target: '*' }, { ...body, digestUpdateImages: [] }, { ...body, digestUpdateImages: ['nginx:1', 'nginx:1'] }, { ...body, contractVersion: 2 }]) {
      const response = await request(app).post('/api/auto-update/execute-checked').set('x-test-machine', 'yes').send(invalid);
      expect(response.status).toBe(400);
    }
    expect(mocks.apply).not.toHaveBeenCalled();
  });
  it('binds every requested image to current local facts before applying', async () => {
    const response = await request(app).post('/api/auto-update/execute-checked').set('x-test-machine', 'yes').send({ ...body, digestUpdateImages: ['other:1'] });
    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ applied: false, result: 'stale_observation', code: 'IMAGE_UPDATE_OBSERVATION_STALE' });
    expect(mocks.consume).not.toHaveBeenCalled();
  });
  it('rereads facts before consuming the observation and preserves health metadata', async () => {
    const response = await request(app).post('/api/auto-update/execute-checked').set('x-test-machine', 'yes').send(body);
    expect(response.status).toBe(200);
    expect(mocks.permission).toHaveBeenCalledWith(expect.anything(), expect.anything(), 'stack:deploy', 'stack', 'web', 1);
    expect(mocks.readLocal).toHaveBeenCalledTimes(2);
    expect(mocks.consume).toHaveBeenCalledWith('token', { stack: 'web', factsHash: hashImageUpdateFacts(facts) });
    expect(mocks.apply).toHaveBeenCalledWith(expect.objectContaining({ verificationOwner: 'hub_authority' }));
    expect(response.body).toMatchObject({ applied: true, result: 'applied', healthGateId: 'health' });
    expect(response.body).not.toHaveProperty('recheckWarning');
  });
  it('rejects facts that changed during policy without consuming the observation', async () => {
    mocks.readLocal.mockResolvedValueOnce(facts).mockResolvedValueOnce({ ...facts, images: [] });
    const response = await request(app).post('/api/auto-update/execute-checked').set('x-test-machine', 'yes').send(body);
    expect(response.status).toBe(409);
    expect(mocks.consume).not.toHaveBeenCalled();
    expect(mocks.invalidate).not.toHaveBeenCalled();
  });
});
