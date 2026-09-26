import { describe, it, expect } from 'vitest';
import { parsePortSpec, withHostPort, containerLabel } from './portSpec';

describe('parsePortSpec', () => {
  it.each([
    ['8080:80', null, '8080', '80'],
    ['443:443/tcp', null, '443', '443/tcp'],
    ['51820:51820/udp', null, '51820', '51820/udp'],
    ['127.0.0.1:8080:80/tcp', '127.0.0.1', '8080', '80/tcp'],
    ['[::1]:8080:80/tcp', '[::1]', '8080', '80/tcp'],
    ['10.0.0.5:9000:9000/udp', '10.0.0.5', '9000', '9000/udp'],
  ])('reads %s into address, host and container', (spec, address, host, container) => {
    const parsed = parsePortSpec(spec);
    expect(parsed.bindAddress).toBe(address);
    expect(parsed.hostPort).toBe(host);
    expect(parsed.container).toBe(container);
  });

  it('offers no editable host port for a container-only spec', () => {
    const parsed = parsePortSpec('443/tcp');
    expect(parsed.bindAddress).toBeNull();
    expect(parsed.hostPort).toBeNull();
    expect(parsed.hostSegment).toBeNull();
    expect(parsed.container).toBe('443/tcp');
  });

  it('offers no editable host port for a bind address with no published port', () => {
    expect(parsePortSpec('127.0.0.1:80').hostPort).toBeNull();
    expect(parsePortSpec('[::1]:80/tcp').hostPort).toBeNull();
  });

  it('reads a hostname in the address position, which Compose accepts there', () => {
    // Restricted to a dotted quad this read as a published port of 'localhost',
    // and the sheet told the operator the port was on every interface.
    const parsed = parsePortSpec('localhost:8080:80/tcp');
    expect(parsed.bindAddress).toBe('localhost');
    expect(parsed.hostPort).toBe('8080');
    expect(parsed.container).toBe('80/tcp');
    expect(containerLabel(parsed)).toBe('localhost:80/tcp');
    expect(withHostPort('localhost:8080:80/tcp', '9090')).toBe('localhost:9090:80/tcp');
  });

  it('reads a hostname with no published port as an address', () => {
    const parsed = parsePortSpec('dbhost:5432');
    expect(parsed.bindAddress).toBe('dbhost');
    expect(parsed.hostPort).toBeNull();
    expect(parsed.container).toBe('5432');
  });

  it('keeps a range visible as a host segment but does not offer it as one number', () => {
    const parsed = parsePortSpec('3000-3005:3000-3005/udp');
    expect(parsed.hostSegment).toBe('3000-3005');
    expect(parsed.hostPort).toBeNull();
    expect(parsed.container).toBe('3000-3005/udp');
  });
});

describe('containerLabel', () => {
  it('keeps a bind address visible so the port is not read as every-interface', () => {
    expect(containerLabel(parsePortSpec('127.0.0.1:8080:80/tcp'))).toBe('127.0.0.1:80/tcp');
    expect(containerLabel(parsePortSpec('[::1]:8080:80/tcp'))).toBe('[::1]:80/tcp');
  });

  it('is the bare container segment when no address is pinned', () => {
    expect(containerLabel(parsePortSpec('51820:51820/udp'))).toBe('51820/udp');
  });
});

describe('withHostPort', () => {
  it.each([
    ['8080:80', '9090', '9090:80'],
    ['443:443/tcp', '8443', '8443:443/tcp'],
    ['51820:51820/udp', '51821', '51821:51820/udp'],
    // The bind address, the container port and the protocol all survive.
    ['127.0.0.1:8080:80/tcp', '9090', '127.0.0.1:9090:80/tcp'],
    ['[::1]:8080:80/tcp', '9090', '[::1]:9090:80/tcp'],
    ['10.0.0.5:9000:9000/udp', '9001', '10.0.0.5:9001:9000/udp'],
  ])('rewrites %s to %s keeping every other segment', (spec, hostPort, expected) => {
    expect(withHostPort(spec, hostPort)).toBe(expected);
  });

  it.each([
    '443/tcp',
    '80',
    '127.0.0.1:80',
    '[::1]:80/tcp',
    '3000-3005:3000-3005/udp',
  ])('leaves %s unchanged, because it has no single host port to replace', (spec) => {
    expect(withHostPort(spec, '1234')).toBe(spec);
  });

  it.each([
    ['an empty field', ''],
    ['a non-numeric value', 'abc'],
    ['a value with stray characters', '80a'],
    ['more digits than a port has', '123456'],
  ])('leaves the spec alone for %s rather than writing a broken host port', (_label, hostPort) => {
    expect(withHostPort('8080:80', hostPort)).toBe('8080:80');
  });

  it('accepts any single number, leaving the port range to the sheet to police', () => {
    // The sheet blocks the install on an out-of-range value before this runs;
    // this only refuses text that is not a number at all.
    expect(withHostPort('8080:80', '80')).toBe('80:80');
    expect(withHostPort('8080:80', '99999')).toBe('99999:80');
  });

  it('round-trips a spec read then written back unchanged', () => {
    for (const spec of ['8080:80', '443:443/tcp', '127.0.0.1:8080:80/tcp', '[::1]:8080:80/tcp']) {
      const { hostPort } = parsePortSpec(spec);
      expect(hostPort).not.toBeNull();
      expect(withHostPort(spec, hostPort!)).toBe(spec);
    }
  });

  it('keeps the container port and protocol that a naive split used to drop', () => {
    // The exact regression: parts[0] and parts[1] would yield '127.0.0.1:8080'.
    const rewritten = withHostPort('127.0.0.1:8080:80/tcp', '9090');
    expect(rewritten).not.toBe('127.0.0.1:8080');
    expect(rewritten).toContain('80/tcp');
  });
});
