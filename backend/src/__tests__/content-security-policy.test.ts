import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../app';

function directive(csp: string, name: string): string {
  return csp.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${name} `)) ?? '';
}

describe('content security policy', () => {
  it('serves styles and fonts only from the instance', async () => {
    const app = createApp();
    app.get('/csp-probe', (_req, res) => { res.json({ ok: true }); });
    const res = await request(app).get('/csp-probe');
    expect(res.status).toBe(200);
    const csp = res.headers['content-security-policy'];
    if (typeof csp !== 'string') {
      throw new Error('missing content security policy');
    }
    expect(directive(csp, 'font-src')).toBe("font-src 'self' data:");
    expect(directive(csp, 'style-src')).toBe("style-src 'self' 'unsafe-inline'");
  });
});
