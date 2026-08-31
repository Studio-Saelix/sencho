import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app';
import { resetTrustedProxyBlockListCache } from '../helpers/trustedProxyCidrs';

describe('Express trusted proxy configuration', () => {
  beforeEach(() => {
    delete process.env.SENCHO_TRUSTED_PROXY_CIDRS;
    resetTrustedProxyBlockListCache();
  });

  it('ignores forwarded client addresses from an untrusted direct peer', async () => {
    const app = createApp();
    app.get('/peer-ip', (req, res) => res.json({ ip: req.ip }));

    const res = await request(app)
      .get('/peer-ip')
      .set('X-Forwarded-For', '203.0.113.50');

    expect(res.status).toBe(200);
    expect(res.body.ip).not.toBe('203.0.113.50');
  });

  it('honors forwarded client addresses from an allowlisted proxy peer', async () => {
    process.env.SENCHO_TRUSTED_PROXY_CIDRS = '127.0.0.0/8';
    resetTrustedProxyBlockListCache();
    const app = createApp();
    app.get('/peer-ip', (req, res) => res.json({ ip: req.ip }));

    const res = await request(app)
      .get('/peer-ip')
      .set('X-Forwarded-For', '203.0.113.50');

    expect(res.status).toBe(200);
    expect(res.body.ip).toBe('203.0.113.50');
  });
});
