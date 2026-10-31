import { describe, it, expect } from 'vitest';
import {
  REMOTE_READ_FAILURE_HEADER,
  REMOTE_READ_TIMEOUT_HEADER,
  classifyRemoteReadError,
  classifyRemoteReadFailure,
  remoteReadFailureMessage,
} from '../remoteReadFailure';

function timedOut(): Response {
  return new Response(JSON.stringify({ code: 'remote_read_timeout' }), {
    status: 504,
    headers: { [REMOTE_READ_TIMEOUT_HEADER]: '1' },
  });
}

function status(code: number, body: unknown = { error: 'nope' }): Response {
  return new Response(JSON.stringify(body), { status: code });
}

function marked(failure: string, code = 503): Response {
  return new Response(JSON.stringify({ error: 'nope' }), {
    status: code,
    headers: { [REMOTE_READ_FAILURE_HEADER]: failure },
  });
}

describe('classifyRemoteReadFailure', () => {
  it('reads a marked 504 as the gateway read deadline', () => {
    expect(classifyRemoteReadFailure(timedOut())).toBe('timeout');
  });

  it('keeps an unmarked 504 a plain HTTP failure', () => {
    expect(classifyRemoteReadFailure(status(504))).toBe('http');
  });

  it('reads a gateway 502 or a disconnected-node 503 as unreachable', () => {
    expect(classifyRemoteReadFailure(status(502))).toBe('unreachable');
    expect(classifyRemoteReadFailure(status(503))).toBe('unreachable');
  });

  it('treats a forwarded 502 or 503 as the remote answering with an error', () => {
    const proxied502 = new Response(JSON.stringify({ error: 'upstream' }), {
      status: 502,
      headers: { 'x-sencho-proxy': '1' },
    });
    const proxied503 = new Response(JSON.stringify({ error: 'busy' }), {
      status: 503,
      headers: { 'x-sencho-proxy': '1' },
    });
    expect(classifyRemoteReadFailure(proxied502)).toBe('http');
    expect(classifyRemoteReadFailure(proxied503)).toBe('http');
  });

  it('uses the cause the gateway marked when the status alone would mislead', () => {
    expect(classifyRemoteReadFailure(marked('unverified'))).toBe('unverified');
    expect(classifyRemoteReadFailure(marked('not-configured'))).toBe('not-configured');
    expect(classifyRemoteReadFailure(marked('pilot-disconnected'))).toBe('pilot-disconnected');
    expect(classifyRemoteReadFailure(marked('refused', 502))).toBe('refused');
  });

  it('treats a 401 forwarded by the proxy as a rejected node credential, not the session', () => {
    const proxied = new Response(JSON.stringify({ error: 'unauthorized' }), {
      status: 401,
      headers: { 'x-sencho-proxy': '1' },
    });
    expect(classifyRemoteReadFailure(proxied)).toBe('node-credential');
  });

  it('keeps authorization, missing surface, and success distinct', () => {
    expect(classifyRemoteReadFailure(status(401))).toBe('unauthorized');
    expect(classifyRemoteReadFailure(status(403))).toBe('unauthorized');
    expect(classifyRemoteReadFailure(status(404))).toBe('unsupported');
    expect(classifyRemoteReadFailure(status(500))).toBe('http');
    expect(classifyRemoteReadFailure(status(200, []))).toBeNull();
  });
});

describe('classifyRemoteReadError', () => {
  it('reads the response apiFetch attached to its Unauthorized throw', () => {
    const unauthorized = Object.assign(new Error('Unauthorized'), { response: status(401) });
    expect(classifyRemoteReadError(unauthorized)).toBe('unauthorized');
  });

  it('keeps a transport failure a plain error', () => {
    expect(classifyRemoteReadError(new TypeError('Failed to fetch'))).toBe('error');
    expect(classifyRemoteReadError(null)).toBe('error');
  });
});

describe('remoteReadFailureMessage', () => {
  it('names the node and does not read like an empty result', () => {
    const message = remoteReadFailureMessage('timeout', { nodeName: 'edge-1' });
    expect(message).toContain('"edge-1"');
    expect(message).toContain('did not answer in time');
    expect(message).not.toMatch(/empty|no data/i);
  });

  it('distinguishes unreachable, unauthorized, and unsupported copy', () => {
    expect(remoteReadFailureMessage('unreachable')).toContain('unreachable');
    expect(remoteReadFailureMessage('unauthorized')).toContain('do not have access');
    expect(remoteReadFailureMessage('unsupported')).toContain('does not serve this data');
    expect(remoteReadFailureMessage('http', { status: 500 })).toContain('500');
  });

  it('states only the missed deadline on a timeout, without claiming unreachable', () => {
    const message = remoteReadFailureMessage('timeout', { nodeName: 'edge-1' });
    expect(message).not.toMatch(/unreachable/i);
    expect(message).not.toMatch(/still starting/i);
  });

  it('names a rejected node credential instead of the operator’s access', () => {
    const message = remoteReadFailureMessage('node-credential', { nodeName: 'edge-1' });
    expect(message).toMatch(/stored credential/i);
    expect(message).toMatch(/API token/i);
    expect(message).not.toMatch(/do not have access/i);
  });

  it('does not call a node silent when its permission model was unverified', () => {
    const message = remoteReadFailureMessage('unverified', { nodeName: 'edge-1' });
    expect(message).toMatch(/permission model could not be verified/i);
    expect(message).not.toMatch(/did not answer|unreachable/i);
  });

  it('falls back to a neutral subject when the node is unnamed', () => {
    expect(remoteReadFailureMessage('timeout')).toContain('This node');
  });
});
