/**
 * The bounded host-port enumeration every per-port rule and the source locator
 * share. The 256-port cap is what keeps a hostile `1-65535` range from blowing
 * up a report, and a rule and the locator must agree on exactly which ports it
 * counts or a finding can point at a declaration it never reported.
 *
 * Also the protocol fold every port reader shares, so an authored `80/TCP`
 * compares equal to the `tcp` Docker reports, and the short-form split, where a
 * colon inside a `${...}` template is part of the template rather than a field
 * separator.
 */
import { describe, expect, it } from 'vitest';
import { claimsEnumeratedHostPort, enumeratedHostPorts, normalizePortProtocol, splitShortPortSpec } from '../helpers/composePortSpec';

describe('normalizePortProtocol', () => {
  it('folds a stated protocol to the lower case Docker reports', () => {
    expect(normalizePortProtocol('TCP')).toBe('tcp');
    expect(normalizePortProtocol('Udp')).toBe('udp');
    expect(normalizePortProtocol('sctp')).toBe('sctp');
  });

  it('keeps tcp when the entry names no protocol', () => {
    expect(normalizePortProtocol(undefined)).toBe('tcp');
    expect(normalizePortProtocol('')).toBe('tcp');
  });

  it('leaves an unresolved template as written instead of rewriting its variable name', () => {
    expect(normalizePortProtocol('${PROTO}')).toBe('${PROTO}');
  });
});

describe('bounded host-port enumeration', () => {
  it('caps a long range at 256 ports', () => {
    const ports = enumeratedHostPorts({ startPort: 10000, endPort: 20000 });
    expect(ports).toHaveLength(256);
    expect(ports[0]).toBe(10000);
    expect(ports[255]).toBe(10255);
    expect(claimsEnumeratedHostPort({ startPort: 10000, endPort: 20000 }, 10255)).toBe(true);
    expect(claimsEnumeratedHostPort({ startPort: 10000, endPort: 20000 }, 10256)).toBe(false);
    expect(claimsEnumeratedHostPort({ startPort: 10000, endPort: 20000 }, 9999)).toBe(false);
  });

  it('enumerates exactly 256 ports and no more at the boundary', () => {
    expect(enumeratedHostPorts({ startPort: 1000, endPort: 1255 })).toHaveLength(256);
    expect(enumeratedHostPorts({ startPort: 1000, endPort: 1256 })).toHaveLength(256);
    expect(claimsEnumeratedHostPort({ startPort: 1000, endPort: 1255 }, 1255)).toBe(true);
    expect(claimsEnumeratedHostPort({ startPort: 1000, endPort: 1256 }, 1256)).toBe(false);
  });

  it('enumerates a short range exactly', () => {
    expect(enumeratedHostPorts({ startPort: 8080, endPort: 8082 })).toEqual([8080, 8081, 8082]);
    expect(claimsEnumeratedHostPort({ startPort: 8080, endPort: 8082 }, 8082)).toBe(true);
    expect(claimsEnumeratedHostPort({ startPort: 8080, endPort: 8082 }, 8083)).toBe(false);
  });

  it('claims nothing for a dynamic publication', () => {
    expect(enumeratedHostPorts({ startPort: 0, endPort: 0, dynamic: true })).toEqual([]);
    expect(claimsEnumeratedHostPort({ startPort: 0, endPort: 0, dynamic: true }, 8080)).toBe(false);
  });
});

describe('splitShortPortSpec', () => {
  it('splits at the colons that separate the interface, host and container ports', () => {
    expect(splitShortPortSpec('8080:80')).toEqual({ hostIp: '', hostPart: '8080', container: '80', protocol: 'tcp' });
    expect(splitShortPortSpec('127.0.0.1:5353:53/udp')).toEqual({ hostIp: '127.0.0.1', hostPart: '5353', container: '53', protocol: 'udp' });
    expect(splitShortPortSpec('::1:51820:51820/udp')).toEqual({ hostIp: '::1', hostPart: '51820', container: '51820', protocol: 'udp' });
    expect(splitShortPortSpec('[::1]:51820:51820')).toEqual({ hostIp: '::1', hostPart: '51820', container: '51820', protocol: 'tcp' });
  });

  it('keeps a template whole, so the colon in its operator is not a field separator', () => {
    // Compose substitutes the template before it reads the fields, so the `:`
    // in `:-` and any colon in the default belong to the template.
    expect(splitShortPortSpec('${APP_PORT:-8080}:80')).toEqual({
      hostIp: '', hostPart: '${APP_PORT:-8080}', container: '80', protocol: 'tcp',
    });
    expect(splitShortPortSpec('${HOST_PORT}:80')).toEqual({ hostIp: '', hostPart: '${HOST_PORT}', container: '80', protocol: 'tcp' });
    expect(splitShortPortSpec('127.0.0.1:${APP_PORT:-8080}:80/udp')).toEqual({
      hostIp: '127.0.0.1', hostPart: '${APP_PORT:-8080}', container: '80', protocol: 'udp',
    });
    expect(splitShortPortSpec('[::1]:${APP_PORT:-8080}:80')).toEqual({
      hostIp: '::1', hostPart: '${APP_PORT:-8080}', container: '80', protocol: 'tcp',
    });
  });

  it('treats a template holding the whole entry as one field, including any slash in it', () => {
    expect(splitShortPortSpec('${PORTS}')).toEqual({ hostIp: '', hostPart: '', container: '${PORTS}', protocol: 'tcp' });
    expect(splitShortPortSpec('${ENTRY:-8080:80/tcp}')).toEqual({
      hostIp: '', hostPart: '', container: '${ENTRY:-8080:80/tcp}', protocol: 'tcp',
    });
  });

  it('keeps a template inside a default whole, up to its own closing brace', () => {
    expect(splitShortPortSpec('${APP_PORT:-${FALLBACK_PORT:-8080}}:80')).toEqual({
      hostIp: '', hostPart: '${APP_PORT:-${FALLBACK_PORT:-8080}}', container: '80', protocol: 'tcp',
    });
  });
});
