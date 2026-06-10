import { describe, it, expect } from 'vitest';
import { computeDocDrift, extractExplicitAccessPort } from '../docDrift';
import type { AnatomyMarkdownInput, PortRow } from '../anatomyMarkdown';

function anatomyWith(ports: PortRow[]): AnatomyMarkdownInput {
  return {
    stackName: 'web',
    services: ['web'],
    ports: ports.length ? { web: ports } : {},
    volumes: {},
    restart: null,
    envFile: null,
    envVarCount: 0,
    missingVars: [],
    networkName: 'web_default',
    gitSource: null,
  };
}
const tcp = (host: string): PortRow => ({ host, container: '80', proto: 'tcp' });
const udp = (host: string): PortRow => ({ host, container: '80', proto: 'udp' });
/** Ports flagged for the given access_urls against the given published rows. */
const flagged = (urls: string, published: PortRow[] = []): number[] =>
  computeDocDrift(anatomyWith(published), urls).map((f) => f.port);

describe('extractExplicitAccessPort', () => {
  it('reads an explicit non-default port from an absolute URL', () => {
    expect(extractExplicitAccessPort('http://host:8080')).toBe(8080);
    expect(extractExplicitAccessPort('https://host:32400/web')).toBe(32400);
  });

  it('skips scheme-default ports (http :80, https :443) and port-less URLs', () => {
    expect(extractExplicitAccessPort('http://host:80')).toBeNull();
    expect(extractExplicitAccessPort('https://host:443')).toBeNull();
    expect(extractExplicitAccessPort('https://host')).toBeNull();
  });

  it('isolates the port from userinfo and never reads a password', () => {
    expect(extractExplicitAccessPort('http://user:pass@host:8080')).toBe(8080);
    expect(extractExplicitAccessPort('http://user:pass@host')).toBeNull();
  });

  it('handles IPv6 in absolute and bare forms', () => {
    expect(extractExplicitAccessPort('http://[::1]:8080')).toBe(8080);
    expect(extractExplicitAccessPort('[::1]:8080')).toBe(8080);
  });

  it('parses bare host:port for host-ish authorities (the corrected fallback)', () => {
    expect(extractExplicitAccessPort('plex.local:32400')).toBe(32400);
    expect(extractExplicitAccessPort('plex.local:32400/web')).toBe(32400);
    expect(extractExplicitAccessPort('localhost:8080')).toBe(8080);
    expect(extractExplicitAccessPort('192.168.1.5:32400')).toBe(32400);
  });

  it('rejects prose that merely looks like host:port', () => {
    expect(extractExplicitAccessPort('note:8080')).toBeNull(); // single-label host, not host-ish
    expect(extractExplicitAccessPort('ratio 16:9')).toBeNull(); // space -> invalid URL
    expect(extractExplicitAccessPort('see wiki')).toBeNull();
    expect(extractExplicitAccessPort('')).toBeNull();
    expect(extractExplicitAccessPort('   ')).toBeNull();
  });

  it('rejects out-of-range and non-numeric ports', () => {
    expect(extractExplicitAccessPort('http://host:0')).toBeNull();
    expect(extractExplicitAccessPort('http://host:99999')).toBeNull();
    expect(extractExplicitAccessPort('http://host:abc')).toBeNull();
  });

  it('intentionally does not check a scheme-less single-label host, but does with a scheme', () => {
    // `plex:32400` is indistinguishable from prose like `note:8080`, so the bare
    // form is skipped to avoid false positives. Adding a scheme opts it in.
    expect(extractExplicitAccessPort('plex:32400')).toBeNull();
    expect(extractExplicitAccessPort('nas:8096')).toBeNull();
    expect(extractExplicitAccessPort('http://plex:32400')).toBe(32400);
  });
});

describe('computeDocDrift', () => {
  it('flags a documented port that nothing publishes', () => {
    expect(flagged('http://host:9000', [tcp('8080')])).toEqual([9000]);
  });

  it('does not flag a documented port that is published', () => {
    expect(flagged('http://host:8080', [tcp('8080')])).toEqual([]);
  });

  it('does not flag a port-less or scheme-default URL', () => {
    expect(flagged('http://host', [tcp('8080')])).toEqual([]);
    expect(flagged('http://host:80', [tcp('8080')])).toEqual([]);
  });

  it('does not let a UDP-only publish satisfy an http access URL', () => {
    expect(flagged('http://host:51820', [udp('51820')])).toEqual([51820]);
  });

  it('matches a documented port inside a published range', () => {
    expect(flagged('http://host:8001', [tcp('8000-8002')])).toEqual([]);
    expect(flagged('http://host:8003', [tcp('8000-8002')])).toEqual([8003]);
  });

  it('recognizes a one-part published port (Anatomy UI semantics)', () => {
    expect(flagged('http://host:8096', [tcp('8096')])).toEqual([]);
  });

  it('dedupes repeated ports and sorts findings by port', () => {
    expect(flagged('http://host:9000\nhttp://host:9000')).toEqual([9000]);
    expect(flagged('http://host:9000\nhttp://host:8000', [tcp('1234')])).toEqual([8000, 9000]);
  });

  it('checks only URL-shaped lines, ignoring prose', () => {
    expect(flagged('http://host:8080\nhttp://host:9000\nnote:8080\nsee wiki', [tcp('8080')])).toEqual([9000]);
  });

  it('flags only the unpublished line when published and unpublished URLs are mixed', () => {
    expect(flagged('http://host:8080\nhttp://host:9000', [tcp('8080')])).toEqual([9000]);
  });

  it('treats an uppercase UDP proto as non-TCP', () => {
    expect(flagged('http://host:51820', [{ host: '51820', container: '51820', proto: 'UDP' }])).toEqual([51820]);
  });

  it('stays quiet when a port is published through an unresolved variable', () => {
    // ${PLEX_PORT}:32400 parses to a non-numeric host; its real value is unknown,
    // so a documented :32400 must not be flagged as a false positive.
    expect(flagged('http://host:32400', [{ host: '${PLEX_PORT}', container: '32400', proto: 'tcp' }])).toEqual([]);
  });

  it('suppresses the whole stack when a variable port is mixed with fixed ports', () => {
    // One indeterminate (variable) port makes the published set unknowable, so
    // even a port that is clearly unpublished stays unflagged. Pins the global
    // suppression so it cannot regress to a partial check.
    const published = [tcp('8080'), { host: '${PLEX_PORT}', container: '32400', proto: 'tcp' }];
    expect(flagged('http://host:9999', published)).toEqual([]);
  });

  it('keeps the first source line when a port is deduped across lines', () => {
    const [finding] = computeDocDrift(anatomyWith([]), 'http://a:9000\nhttps://b:9000/x');
    expect(finding.source).toBe('http://a:9000');
  });

  it('returns nothing when anatomy is unavailable or no URLs are documented', () => {
    expect(computeDocDrift(null, 'http://host:9000')).toEqual([]);
    expect(flagged('', [tcp('8080')])).toEqual([]);
  });

  it('produces an actionable finding shape', () => {
    const [finding] = computeDocDrift(anatomyWith([tcp('8080')]), '  http://host:9000  ');
    expect(finding).toMatchObject({ kind: 'access-url-port-unpublished', port: 9000, source: 'http://host:9000' });
    expect(finding.detail).toContain('9000');
  });
});
