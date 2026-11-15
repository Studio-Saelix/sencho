import type { Request } from 'express';
import { isValidRemoteUrl } from '../utils/validation';
import { isNativeTlsEnabled, rewriteHttpUrlToHttps } from './nativeTls';

/**
 * Pick the URL a Pilot agent should dial. SENCHO_PUBLIC_URL wins when set and
 * well-formed, because the request Host header is only reachable from the
 * network the operator opened the dialog from. Pilots on a public cloud cannot
 * dial a LAN or loopback address, so an explicit public URL is the only thing
 * that lets the enrolled YAML work unmodified.
 *
 * When the hub itself terminates TLS, an http:// URL would open a cleartext
 * connection to an HTTPS listener. Rewrite the scheme so enrollment matches the
 * listener even if SENCHO_PUBLIC_URL was left on http.
 */
export function resolvePrimaryUrl(req: Request): string {
  const override = process.env.SENCHO_PUBLIC_URL?.trim();
  let url = `${req.protocol}://${req.get('host') || 'localhost:1852'}`;
  if (override) {
    const check = isValidRemoteUrl(override);
    if (check.valid) url = override.replace(/\/$/, '');
    else console.warn(`[Enrollment] SENCHO_PUBLIC_URL is set but invalid (${check.reason}); falling back to request host.`);
  }
  return isNativeTlsEnabled() ? rewriteHttpUrlToHttps(url) : url;
}
