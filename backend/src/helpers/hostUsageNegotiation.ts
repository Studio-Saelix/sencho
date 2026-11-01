import {
  HOST_USAGE_UNKNOWN_HEADER,
  HOST_USAGE_UNKNOWN_HEADER_VALUE,
} from '../services/CapabilityRegistry';

/**
 * Whether the caller can render `null` host usage.
 *
 * A local browser session always can: it is served by this same build, whose
 * dashboard shows `--` with "usage unknown". Every non-browser caller is a
 * machine client (a hub proxy, a Pilot tunnel, or an opaque API token), so it
 * must advertise `host-usage-unknown-v1` with `HOST_USAGE_UNKNOWN_HEADER`. An
 * older hub or a monitoring integration written against the numeric shape
 * sends no header and receives the numeric kernel shape instead of a null that
 * its dashboard would render as `NaN%`.
 */
export function requestAcceptsUnknownHostUsage(req: {
  machineAuthScope?: 'node_proxy' | 'pilot_tunnel';
  apiTokenScope?: string;
  headers: Record<string, string | string[] | undefined>;
}): boolean {
  // A signed-in user session is the only caller that is guaranteed to run this
  // same frontend. API tokens and machine credentials are external clients.
  if (!req.machineAuthScope && !req.apiTokenScope) return true;
  const raw = req.headers[HOST_USAGE_UNKNOWN_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string') return false;
  // Node joins repeated non-cookie headers into one comma-separated value.
  return value.split(',')[0].trim() === HOST_USAGE_UNKNOWN_HEADER_VALUE;
}
