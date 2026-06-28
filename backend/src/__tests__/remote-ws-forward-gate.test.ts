/**
 * Unit coverage for the remote-WebSocket forward gate. The hub must enforce the
 * originating user's role before forwarding a remote upgrade, because the
 * forwarder authenticates the forwarded connection to the remote as an
 * admin-gated console_session. Logs and notifications stay open to any
 * authenticated user; every other path is an interactive terminal (container
 * exec / host console) and is admin-only on the hub.
 */
import { describe, it, expect } from 'vitest';
import { remoteWsForwardAllowed } from '../websocket/upgradeHandler';

const viewer = { role: 'viewer' as const };
const admin = { role: 'admin' as const };
const base = { wsResolvedUser: undefined, wsApiTokenScope: null, isProxyToken: false, decoded: {} };

const LOGS = '/api/stacks/web/logs';
const NOTIF = '/ws/notifications';
const EXEC = '/ws';
const CONSOLE = '/api/system/host-console';

describe('remoteWsForwardAllowed', () => {
  it('allows logs and notifications for any authenticated user', () => {
    for (const p of [LOGS, NOTIF]) {
      expect(remoteWsForwardAllowed(p, { ...base, wsResolvedUser: viewer })).toBe(true);
    }
  });

  it('denies interactive exec/console to every non-admin role (none holds system:console)', () => {
    for (const role of ['viewer', 'deployer', 'node-admin', 'auditor'] as const) {
      for (const p of [EXEC, CONSOLE]) {
        expect(remoteWsForwardAllowed(p, { ...base, wsResolvedUser: { role } })).toBe(false);
      }
    }
  });

  it('allows interactive exec/console to an admin user session', () => {
    for (const p of [EXEC, CONSOLE]) {
      expect(remoteWsForwardAllowed(p, { ...base, wsResolvedUser: admin })).toBe(true);
    }
  });

  it('gates host console on system:console, not merely role==admin (parity with handleHostConsoleWs)', async () => {
    // node-admin is the meaningful case: broad stack/node permissions but no
    // system:console, so it must be denied the remote host console.
    const { ROLE_PERMISSIONS } = await import('../middleware/permissions');
    for (const role of ['admin', 'viewer', 'deployer', 'node-admin', 'auditor'] as const) {
      const expected = ROLE_PERMISSIONS[role].includes('system:console');
      expect(remoteWsForwardAllowed(CONSOLE, { ...base, wsResolvedUser: { role } })).toBe(expected);
    }
  });

  it('denies an interactive path to a node_proxy (machine) token', () => {
    expect(remoteWsForwardAllowed(EXEC, { ...base, isProxyToken: true, decoded: { scope: 'node_proxy' } })).toBe(false);
  });

  it('allows an interactive path for a full-admin api token but denies a restricted scope', () => {
    expect(remoteWsForwardAllowed(EXEC, { ...base, wsApiTokenScope: 'full-admin', decoded: { scope: 'api_token' } })).toBe(true);
    expect(remoteWsForwardAllowed(EXEC, { ...base, wsApiTokenScope: 'deploy-only', decoded: { scope: 'api_token' } })).toBe(false);
  });

  it('allows an interactive path for a pre-gated console_session token', () => {
    expect(remoteWsForwardAllowed(CONSOLE, { ...base, decoded: { scope: 'console_session' } })).toBe(true);
  });

  it('treats an unknown path as interactive (admin-only)', () => {
    expect(remoteWsForwardAllowed('/ws/unknown', { ...base, wsResolvedUser: viewer })).toBe(false);
    expect(remoteWsForwardAllowed('/ws/unknown', { ...base, wsResolvedUser: admin })).toBe(true);
  });
});
