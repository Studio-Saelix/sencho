/**
 * HTTP contract of the registry delivery router: the machine-scope gate on
 * every endpoint, and the discover catch mapping service statuses to stable
 * client messages without echoing target detail.
 */
import express from 'express';
import request from 'supertest';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setupTestDb } from './helpers/setupTestDb';
import { RegistryDeliveryService } from '../services/RegistryDeliveryService';

let registryDeliveryRouter: typeof import('../routes/registryDelivery').registryDeliveryRouter;
let machineScope: 'node_proxy' | 'pilot_tunnel' | undefined;

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (machineScope) req.machineAuthScope = machineScope;
    next();
  });
  app.use('/api/registry-delivery', registryDeliveryRouter);
  return app;
}

describe('registry delivery routes', () => {
  beforeEach(async () => {
    await setupTestDb();
    RegistryDeliveryService.resetForTests();
    ({ registryDeliveryRouter } = await import('../routes/registryDelivery'));
    machineScope = 'node_proxy';
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('requires machine authentication on discover', async () => {
    machineScope = undefined;
    const discoverSpy = vi.spyOn(RegistryDeliveryService.getInstance(), 'discoverOnTarget')
      .mockResolvedValue({} as never);

    const res = await request(makeApp()).post('/api/registry-delivery/discover').send({});

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'Machine authentication required' });
    expect(discoverSpy).not.toHaveBeenCalled();
  });

  it('requires machine authentication on evidence', async () => {
    machineScope = undefined;
    const sourceSpy = vi.spyOn(RegistryDeliveryService.getInstance(), 'getDeliverySourceId')
      .mockReturnValue('test-source');

    const res = await request(makeApp()).get('/api/registry-delivery/evidence');

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'Machine authentication required' });
    expect(sourceSpy).not.toHaveBeenCalled();
  });

  it('maps a discovery limit refusal to 413 with the limit-specific message', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const discoverSpy = vi.spyOn(RegistryDeliveryService.getInstance(), 'discoverOnTarget')
      .mockRejectedValue(Object.assign(new Error('too many refs'), { status: 413 }));

    const res = await request(makeApp()).post('/api/registry-delivery/discover').send({});

    expect(res.status).toBe(413);
    expect(res.body).toEqual({ error: 'Discovery exceeded the registry pull reference limit' });
    expect(discoverSpy).toHaveBeenCalledTimes(1);
  });

  it('passes a service status through with the generic message', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const discoverSpy = vi.spyOn(RegistryDeliveryService.getInstance(), 'discoverOnTarget')
      .mockRejectedValue(Object.assign(
        new Error('Registry delivery contract version not supported'),
        { status: 400 },
      ));

    const res = await request(makeApp()).post('/api/registry-delivery/discover').send({});

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Registry delivery discovery failed' });
    expect(discoverSpy).toHaveBeenCalledTimes(1);
  });

  it('maps a status-less discovery failure to 500 with the generic message', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const discoverSpy = vi.spyOn(RegistryDeliveryService.getInstance(), 'discoverOnTarget')
      .mockRejectedValue(new Error('connection reset'));

    const res = await request(makeApp()).post('/api/registry-delivery/discover').send({});

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Registry delivery discovery failed' });
    expect(discoverSpy).toHaveBeenCalledTimes(1);
  });
});
