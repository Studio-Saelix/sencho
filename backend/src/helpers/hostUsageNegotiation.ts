import {
  HOST_USAGE_UNKNOWN_HEADER,
  HOST_USAGE_UNKNOWN_HEADER_VALUE,
} from '../services/CapabilityRegistry';

/**
 * Whether the caller can render `null` host usage.
 *
 * A local browser session always can: it is served by this same build, whose
 * dashboard shows `--` with "usage unknown". A machine caller (a hub proxy or
 * Pilot tunnel request) is another Sencho instance, so it must advertise
 * `host-usage-unknown-v1` with `HOST_USAGE_UNKNOWN_HEADER`. An older hub sends
 * no header and receives the numeric kernel shape instead of a null that its
 * dashboard would render as `NaN%`.
 */
export function requestAcceptsUnknownHostUsage(req: {
  machineAuthScope?: 'node_proxy' | 'pilot_tunnel';
  headers: Record<string, string | string[] | undefined>;
}): boolean {
  if (!req.machineAuthScope) return true;
  const raw = req.headers[HOST_USAGE_UNKNOWN_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value === HOST_USAGE_UNKNOWN_HEADER_VALUE;
}
