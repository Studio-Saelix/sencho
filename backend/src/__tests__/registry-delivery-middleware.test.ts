import express from 'express';
import request from 'supertest';
import { describe, it, expect, beforeEach } from 'vitest';
import { REGISTRY_DELIVERY_BODY_FIELD } from '../helpers/registryDeliveryBodyLimits';
import {
  registryDeliveryApiPath,
  registryDeliveryMiddleware,
} from '../middleware/registryDelivery';
import { setupTestDb } from './helpers/setupTestDb';
import { RegistryDeliveryService } from '../services/RegistryDeliveryService';

describe('registryDeliveryMiddleware', () => {
  beforeEach(async () => {
    await setupTestDb();
    RegistryDeliveryService.resetForTests();
  });

  it('normalizes Express-mounted paths to /api/... for classification', () => {
    expect(registryDeliveryApiPath({ path: '/stacks/jackett/deploy' })).toBe(
      '/api/stacks/jackett/deploy',
    );
  });

  it('engages on stack deploy when mounted at /api (rejects invalid attestation)', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api', registryDeliveryMiddleware);
    app.post('/api/stacks/:name/deploy', (_req, res) => {
      res.status(200).json({ ok: true });
    });

    const res = await request(app)
      .post('/api/stacks/jackett/deploy')
      .send({
        [REGISTRY_DELIVERY_BODY_FIELD]: {
          attestation: 'not-a-jwt',
          auths: [],
          notAfter: Date.now() + 60_000,
          deliverySourceId: 'test-source',
        },
      });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Invalid registry delivery envelope' });
  });

  it('passes through eligible routes without a delivery field', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api', registryDeliveryMiddleware);
    app.post('/api/stacks/:name/deploy', (_req, res) => {
      res.status(200).json({ ok: true });
    });

    const res = await request(app)
      .post('/api/stacks/jackett/deploy')
      .send({});

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('does not engage on non-delivery routes', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api', registryDeliveryMiddleware);
    app.get('/api/stacks', (_req, res) => {
      res.status(200).json({ ok: true });
    });

    const res = await request(app)
      .get('/api/stacks')
      .send({
        [REGISTRY_DELIVERY_BODY_FIELD]: {
          attestation: 'not-a-jwt',
          auths: [],
          notAfter: Date.now() + 60_000,
          deliverySourceId: 'test-source',
        },
      });

    expect(res.status).toBe(200);
  });
});
