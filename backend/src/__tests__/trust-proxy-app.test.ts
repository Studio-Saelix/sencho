import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app';
import { isSecureRequest } from '../helpers/cookies';
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

  it('ignores a forwarded HTTPS scheme from an untrusted direct peer', async () => {
    const app = createApp();
    app.get('/request-scheme', (req, res) => {
      res.json({ protocol: req.protocol, secure: isSecureRequest(req) });
    });

    const res = await request(app)
      .get('/request-scheme')
      .set('X-Forwarded-Proto', 'https');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ protocol: 'http', secure: false });
  });

  it('honors a forwarded HTTPS scheme from an allowlisted proxy peer', async () => {
    process.env.SENCHO_TRUSTED_PROXY_CIDRS = '127.0.0.0/8';
    resetTrustedProxyBlockListCache();
    const app = createApp();
    app.get('/request-scheme', (req, res) => {
      res.json({ protocol: req.protocol, secure: isSecureRequest(req) });
    });

    const res = await request(app)
      .get('/request-scheme')
      .set('X-Forwarded-Proto', 'https');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ protocol: 'https', secure: true });
  });

  it('warns once per untrusted peer that sends forwarding headers', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const app = createApp();
      app.get('/probe', (_req, res) => res.json({ ok: true }));

      await request(app).get('/probe').set('X-Forwarded-For', '203.0.113.50');
      await request(app).get('/probe').set('X-Forwarded-Proto', 'https');

      const warnings = warn.mock.calls
        .map(call => String(call[0]))
        .filter(message => message.includes('[TrustProxy]'));
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('untrusted peer');
      expect(warnings[0]).toContain('SENCHO_TRUSTED_PROXY_CIDRS=');
    } finally {
      warn.mockRestore();
    }
  });

  it('logs the trusted-proxy policy when the app is built', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      createApp();

      const bootLines = log.mock.calls
        .map(call => String(call[0]))
        .filter(message => message.includes('[TrustProxy]'));
      expect(bootLines).toHaveLength(1);
      expect(bootLines[0]).toContain('SENCHO_TRUSTED_PROXY_CIDRS is not set');
    } finally {
      log.mockRestore();
    }
  });
});
