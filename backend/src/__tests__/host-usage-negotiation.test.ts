import { describe, expect, it } from 'vitest';
import { requestAcceptsUnknownHostUsage } from '../helpers/hostUsageNegotiation';
import {
  HOST_USAGE_UNKNOWN_HEADER,
  HOST_USAGE_UNKNOWN_HEADER_VALUE,
} from '../services/CapabilityRegistry';

describe('requestAcceptsUnknownHostUsage', () => {
  it('always accepts unknown for a local browser session', () => {
    expect(requestAcceptsUnknownHostUsage({ headers: {} })).toBe(true);
  });

  it('accepts unknown from a hub that advertises the capability', () => {
    for (const scope of ['node_proxy', 'pilot_tunnel'] as const) {
      expect(requestAcceptsUnknownHostUsage({
        machineAuthScope: scope,
        headers: { [HOST_USAGE_UNKNOWN_HEADER]: HOST_USAGE_UNKNOWN_HEADER_VALUE },
      })).toBe(true);
    }
  });

  it('treats a repeated header as the first value', () => {
    expect(requestAcceptsUnknownHostUsage({
      machineAuthScope: 'node_proxy',
      headers: { [HOST_USAGE_UNKNOWN_HEADER]: [HOST_USAGE_UNKNOWN_HEADER_VALUE, '0'] },
    })).toBe(true);
  });

  it('refuses unknown from a machine caller that does not advertise it', () => {
    for (const scope of ['node_proxy', 'pilot_tunnel'] as const) {
      expect(requestAcceptsUnknownHostUsage({ machineAuthScope: scope, headers: {} })).toBe(false);
      expect(requestAcceptsUnknownHostUsage({
        machineAuthScope: scope,
        headers: { [HOST_USAGE_UNKNOWN_HEADER]: '0' },
      })).toBe(false);
    }
  });
});
