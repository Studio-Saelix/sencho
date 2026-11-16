import { describe, it, expect } from 'vitest';
import { classifyAgentLog } from '../services/nodeBootstrap/agentLogCause';

describe('classifyAgentLog', () => {
  it.each([
    ['a name that does not resolve', '[Pilot] Tunnel error: getaddrinfo ENOTFOUND hub.example.com', 'dns_unresolved', null],
    ['a lookup that timed out', '[Pilot] Tunnel error: getaddrinfo EAI_AGAIN hub.example.com', 'dns_unresolved', null],
    ['an unverifiable chain', '[Pilot] Tunnel error: unable to verify the first certificate', 'tls_untrusted', null],
    ['a missing issuer', '[Pilot] Tunnel error: unable to get local issuer certificate', 'tls_untrusted', null],
    ['a self-signed certificate', '[Pilot] Tunnel error: self-signed certificate in certificate chain', 'tls_untrusted', null],
    ['an expired certificate', '[Pilot] Tunnel error: certificate has expired', 'tls_untrusted', null],
    ['a certificate for another name', "[Pilot] Tunnel error: Hostname/IP does not match certificate's altnames", 'tls_untrusted', null],
    ['an error code', '[Pilot] Tunnel error: DEPTH_ZERO_SELF_SIGNED_CERT', 'tls_untrusted', null],
    ['a closed tunnel with a status', '[Pilot] Tunnel closed: 200 ', 'upgrade_blocked', 200],
    ['a closed tunnel with 400', '[Pilot] Tunnel closed: 400 ', 'upgrade_blocked', 400],
    ['an unexpected server response', '[Pilot] Tunnel error: Unexpected server response: 502', 'upgrade_blocked', 502],
    ['a 404 from a proxy that does not route the path', '[Pilot] Tunnel closed: 404 ', 'upgrade_blocked', 404],
  ])('names %s', (_label, line, cause, status) => {
    expect(classifyAgentLog(`[Pilot] starting\n${line}\n[Pilot] Reconnecting in 5s\n`)).toMatchObject({ cause, status, evidence: line.trim() });
  });

  it('names nothing for output that is not a known failure, so the cause stays unknown', () => {
    expect(classifyAgentLog('')).toBeNull();
    expect(classifyAgentLog('[Pilot] Tunnel connecting\n[Pilot] Reconnecting in 5s\n')).toBeNull();
    // A close code is four digits, and a 401 is the hub's own answer, recorded by the hub from its signed token.
    expect(classifyAgentLog('[Pilot] Tunnel closed: 1006 ')).toBeNull();
    expect(classifyAgentLog('[Pilot] Tunnel closed: 401 ')).toBeNull();
    expect(classifyAgentLog('[Pilot] Tunnel error: socket hang up')).toBeNull();
  });

  it('counts only lines the agent wrote about itself', () => {
    expect(classifyAgentLog('postgres: getaddrinfo ENOTFOUND db\nnginx: certificate has expired')).toBeNull();
  });

  it('takes the newest failure, and none from before a connection that was made after it', () => {
    expect(classifyAgentLog('[Pilot] Tunnel error: getaddrinfo ENOTFOUND hub.example.com\n[Pilot] Tunnel closed: 502 \n')).toMatchObject({ cause: 'upgrade_blocked', status: 502 });
    expect(classifyAgentLog('[Pilot] Tunnel error: getaddrinfo ENOTFOUND hub.example.com\n[Pilot] Tunnel connected to https://hub.example.com\n')).toBeNull();
    expect(classifyAgentLog('[Pilot] Tunnel connected to https://hub.example.com\n[Pilot] Tunnel error: getaddrinfo ENOTFOUND hub.example.com\n')).toMatchObject({ cause: 'dns_unresolved' });
  });

  it('keeps the evidence to one scrubbed, bounded line without control characters', () => {
    const secret = 'enroll-token-0123456789';
    const noisy = `\u001b[31m[Pilot] Tunnel error: getaddrinfo ENOTFOUND ${secret} ${'x'.repeat(500)}\u0007\u001b[0m`;
    const found = classifyAgentLog(`${noisy}\r\n`, [secret]);
    expect(found?.cause).toBe('dns_unresolved');
    expect(found?.evidence).not.toContain(secret);
    expect(found?.evidence).toContain('[redacted]');
    expect(found?.evidence).not.toMatch(/[\u0000-\u001f]/);
    expect(found?.evidence.length).toBeLessThanOrEqual(203);
    expect(found?.evidence).not.toContain('\n');
  });

  it('scrubs a secret that spans lines before it looks at any of them', () => {
    const secret = 'line-one-secret\nline-two-secret';
    const found = classifyAgentLog(`[Pilot] Tunnel error: ENOTFOUND hub ${secret}`, [secret]);
    expect(found?.evidence).not.toContain('line-two-secret');
  });
});
