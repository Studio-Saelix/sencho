import { describe, it, expect } from 'vitest';
import { classifyAgentLog } from '../services/nodeBootstrap/agentLogCause';
import { agentLogCommand } from '../services/nodeBootstrap/executionCommands';

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
    ['a closed tunnel with 502', '[Pilot] Tunnel closed: 502 ', 'upgrade_blocked', 502],
    ['a redirect', '[Pilot] Tunnel closed: 301 ', 'upgrade_blocked', 301],
    ['an unexpected server response', '[Pilot] Tunnel error: Unexpected server response: 502', 'upgrade_blocked', 502],
    ['a proxy that gives up with 504', '[Pilot] Tunnel error: Unexpected server response: 504', 'upgrade_blocked', 504],
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

  it.each([400, 401, 403, 404, 500])('does not blame a proxy for HTTP %i, which the hub\'s own tunnel handler also answers with', (status) => {
    expect(classifyAgentLog(`[Pilot] Tunnel closed: ${status} \n`)).toBeNull();
    expect(classifyAgentLog(`[Pilot] Tunnel error: Unexpected server response: ${status}\n`)).toBeNull();
  });

  it('names nothing when the hub\'s own rejection follows the status, since the hub answered', () => {
    expect(classifyAgentLog('[Pilot] Tunnel closed: 404 \n[Pilot] Tunnel upgrade rejected (unknown_node); re-enrollment required.\n')).toBeNull();
  });

  it('judges only the newest failure: an older failure does not name the cause of a later, different one', () => {
    const dnsAtBoot = '[Pilot] Tunnel error: getaddrinfo EAI_AGAIN hub.example.com';
    expect(classifyAgentLog(`${dnsAtBoot}\n[Pilot] Tunnel closed:  \n[Pilot] Tunnel error: connect ECONNREFUSED 10.0.0.5:443\n[Pilot] Tunnel closed:  \n`)).toBeNull();
    expect(classifyAgentLog(`${dnsAtBoot}\n[Pilot] Tunnel error: Opening handshake has timed out\n`)).toBeNull();
    expect(classifyAgentLog(`${dnsAtBoot}\n[Pilot] Tunnel closed: 401 \n`)).toBeNull();
    expect(classifyAgentLog(`${dnsAtBoot}\n[Pilot] Tunnel error: unable to verify the first certificate\n[Pilot] Tunnel closed:  \n`)).toMatchObject({ cause: 'tls_untrusted' });
  });

  it('ignores a resolver error from something other than the tunnel dial', () => {
    expect(classifyAgentLog('[Pilot] reverse dialer registration failed: getaddrinfo ENOTFOUND hub.example.com')).toBeNull();
  });

  it('counts only lines that begin with the agent\'s own tag, with or without a timestamp', () => {
    expect(classifyAgentLog('app says [Pilot] Tunnel closed: 200 ')).toBeNull();
    expect(classifyAgentLog('2026-11-16T01:02:03.000000000Z [Pilot] Tunnel closed: 200 ')).toMatchObject({ cause: 'upgrade_blocked', status: 200 });
  });

  it('strips colour codes before it reads a line', () => {
    const found = classifyAgentLog('\u001b[33m[Pilot] Tunnel error: getaddrinfo ENOTFOUND hub.example.com\u001b[0m');
    expect(found).toMatchObject({ cause: 'dns_unresolved', evidence: '[Pilot] Tunnel error: getaddrinfo ENOTFOUND hub.example.com' });
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

  it('reads a bounded tail of the container\'s log, with the privilege the start step used, and changes nothing', () => {
    expect(agentLogCommand(false)).toMatch(/docker logs --tail 200 sencho-agent 2>&1$/);
    expect(agentLogCommand(true)).toMatch(/^sudo -n .*docker logs --tail 200 sencho-agent 2>&1$/);
    expect(agentLogCommand(true)).not.toMatch(/\b(rm|restart|stop|kill|exec|up|down)\b/);
  });
});
