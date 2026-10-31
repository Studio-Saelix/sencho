import { describe, it, expect } from 'vitest';
import {
  REMOTE_READ_TIMEOUT_HEADER,
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

  it('keeps authorization, missing surface, and success distinct', () => {
    expect(classifyRemoteReadFailure(status(401))).toBe('unauthorized');
    expect(classifyRemoteReadFailure(status(403))).toBe('unauthorized');
    expect(classifyRemoteReadFailure(status(404))).toBe('unsupported');
    expect(classifyRemoteReadFailure(status(500))).toBe('http');
    expect(classifyRemoteReadFailure(status(200, []))).toBeNull();
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

  it('falls back to a neutral subject when the node is unnamed', () => {
    expect(remoteReadFailureMessage('timeout')).toContain('This node');
  });
});
