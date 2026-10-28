/**
 * Unit tests for the registry-agnostic port normalizer.
 *
 * The load-bearing cases are the real LinuxServer.io payload shapes (string
 * values, protocol embedded in the container value, no `protocol` key) and the
 * Portainer v2 string form, because those are the two registries Sencho ships
 * against. Each test asserts the literal spec that reaches `compose.yaml`, not
 * an implementation detail of the mapper.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { normalizePortEntry, normalizePortEntries } from '../helpers/portSpec';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('normalizePortEntry', () => {
  describe('string entries pass through verbatim', () => {
    it.each([
      '80:80',
      '443:443/tcp',
      '8080:80/udp',
      '127.0.0.1:8080:80',
      '3000-3005:3000-3005/udp',
      '8080',
    ])('returns %s unchanged', (spec) => {
      expect(normalizePortEntry(spec)).toBe(spec);
    });

    it('never inspects or rewrites registry-supplied content', () => {
      // The YAML emitter owns escaping. A value that would break hand-built
      // YAML must reach it byte-identical, or a registry could inject sibling
      // service keys through the port list.
      const hostile = '8080:80\n    cap_add: [ALL]';
      expect(normalizePortEntry(hostile)).toBe(hostile);
      expect(normalizePortEntry('*anchor')).toBe('*anchor');
    });

    it('accepts a numeric entry as a container port', () => {
      expect(normalizePortEntry(8080)).toBe('8080');
    });

    it('rejects a non-finite number', () => {
      expect(normalizePortEntry(Number.NaN)).toBeNull();
    });
  });

  describe('structured entries, LinuxServer.io shape', () => {
    // The real payload sends strings and puts the protocol in the container
    // value with no separate field. Appending a protocol unconditionally to
    // these produced the unrenderable '443:443/udp/tcp'.
    it.each([
      [{ external: '443', internal: '443/udp' }, '443:443/udp'],
      [{ external: '51820', internal: '51820/udp' }, '51820:51820/udp'],
      [{ external: '22000', internal: '22000' }, '22000:22000/tcp'],
      [{ external: '443', internal: '443', desc: 'HTTPS port' }, '443:443/tcp'],
    ])('maps %j to a single protocol', (entry, expected) => {
      expect(normalizePortEntry(entry)).toBe(expected);
    });

    it('accepts a protocol stated by both fields when they agree', () => {
      expect(normalizePortEntry({ external: '3478', internal: '3478/udp', protocol: 'udp' }))
        .toBe('3478:3478/udp');
    });

    it('drops an entry whose fields contradict each other on the protocol', () => {
      // The entry says udp and tcp at once. Emitting either one would be a
      // renderable spec that silently contradicts the catalogue.
      expect(normalizePortEntry({ external: '443', internal: '443/udp', protocol: 'tcp' })).toBeNull();
    });

    it('uses the separate field when the value carries no protocol', () => {
      expect(normalizePortEntry({ external: '3478', internal: '3478', protocol: 'udp' }))
        .toBe('3478:3478/udp');
    });

    it('accepts numeric port values', () => {
      expect(normalizePortEntry({ external: 32400, internal: 32400, protocol: 'tcp' }))
        .toBe('32400:32400/tcp');
    });

    it('lowercases a protocol sent in mixed case', () => {
      expect(normalizePortEntry({ external: '80', internal: '80/UDP' })).toBe('80:80/udp');
    });

    it('publishes the container port on the host when no host port is named', () => {
      expect(normalizePortEntry({ internal: '80' })).toBe('80:80/tcp');
    });
  });

  describe('structured entries, other registry field names', () => {
    it('reads a host/container pair', () => {
      expect(normalizePortEntry({ host: '8080', container: '80' })).toBe('8080:80/tcp');
    });

    it('reads a published/target pair', () => {
      expect(normalizePortEntry({ published: '9090', target: '90', protocol: 'udp' }))
        .toBe('9090:90/udp');
    });

    it('prefers the container field names over a stray lookalike', () => {
      expect(normalizePortEntry({ internal: '80', container: '81', external: '8080', host: '9999' }))
        .toBe('8080:80/tcp');
    });

    it('uses the protocol the host value carried when the container names none', () => {
      // The entry said udp; defaulting to tcp here would publish a renderable
      // spec that contradicts the catalogue.
      expect(normalizePortEntry({ external: '8080/udp', internal: '80' })).toBe('8080:80/udp');
    });

    it('publishes the container port on the host when the host port is 0', () => {
      // 0 asks for an ephemeral binding, not a published port, and the previous
      // mapper treated it as unnamed.
      expect(normalizePortEntry({ external: 0, internal: '80' })).toBe('80:80/tcp');
      expect(normalizePortEntry({ external: '0', internal: '80' })).toBe('80:80/tcp');
    });
  });

  describe('entries it cannot represent are dropped, never corrupted', () => {
    it.each([
      ['an unknown protocol', { external: '1', internal: '2/quic' }],
      ['a doubled protocol', { external: '1', internal: '2/udp/tcp' }],
      ['no container port', { external: '8080' }],
      ['a blank container port', { internal: '   ' }],
      ['an unrelated object', { note: 'see docs' }],
      ['a nested array', [{ internal: '80' }]],
      ['null', null],
      ['a boolean', true],
    ])('rejects %s', (_label, entry) => {
      expect(normalizePortEntry(entry)).toBeNull();
    });
  });
});

describe('normalizePortEntries', () => {
  it('normalizes a mixed list and keeps the order', () => {
    const entries = [
      { external: '443', internal: '443/udp' },
      '80:80',
      { host: '8080', container: '80' },
    ];
    expect(normalizePortEntries(entries, 'test')).toEqual(['443:443/udp', '80:80', '8080:80/tcp']);
  });

  it('returns an empty list for a missing or non-array value', () => {
    expect(normalizePortEntries(undefined, 'test')).toEqual([]);
    expect(normalizePortEntries('80:80', 'test')).toEqual([]);
  });

  it('warns once with the count and the source when it drops entries', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = normalizePortEntries(
      [{ external: '1', internal: '2/quic' }, { note: 'x' }, '80:80'],
      'linuxserver',
    );
    expect(result).toEqual(['80:80']);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0].join(' ')).toContain('2');
    expect(warn.mock.calls[0].join(' ')).toContain('linuxserver');
  });

  it('stays silent when nothing is dropped', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    normalizePortEntries(['80:80', { external: '443', internal: '443/udp' }], 'linuxserver');
    expect(warn).not.toHaveBeenCalled();
  });

  it('strips control characters from the source named in the warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    normalizePortEntries([{ note: 'x' }], 'evil\nregistry');
    expect(warn.mock.calls[0].join(' ')).not.toContain('\n');
  });
});
