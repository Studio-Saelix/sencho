import { describe, expect, it, vi } from 'vitest';
import { renameRetiredServiceUrlLabel } from './composeServiceUrl';

function renamed(source: string, service = 'web'): string {
  const result = renameRetiredServiceUrlLabel(source, service);
  if (!result.ok) throw new Error(`refused: ${result.reason}`);
  return result.yaml;
}

describe('renameRetiredServiceUrlLabel', () => {
  it('renames a block map key and keeps the value token byte for byte', () => {
    const source = [
      'services:',
      '  web:',
      '    image: nginx',
      '    labels:',
      '      sencho.service.url: "https://app.example.com" # public',
      '      other: x',
      '',
    ].join('\n');
    expect(renamed(source)).toBe(source.replace('sencho.service.url', 'io.sencho.url'));
  });

  it('keeps interpolation and escaped dollars in the value', () => {
    const source = 'services:\n  web:\n    labels:\n      sencho.service.url: ${APP_URL}/a$$b\n';
    expect(renamed(source)).toBe('services:\n  web:\n    labels:\n      io.sencho.url: ${APP_URL}/a$$b\n');
  });

  it('keeps the quotes of a quoted key', () => {
    const source = 'services:\n  web:\n    labels:\n      "sencho.service.url": https://a.example.com\n';
    expect(renamed(source)).toBe('services:\n  web:\n    labels:\n      "io.sencho.url": https://a.example.com\n');
  });

  it('renames a list item, plain or quoted, and a bare item', () => {
    expect(renamed('services:\n  web:\n    labels:\n      - sencho.service.url=https://a.example.com\n      - x=y\n'))
      .toBe('services:\n  web:\n    labels:\n      - io.sencho.url=https://a.example.com\n      - x=y\n');
    expect(renamed('services:\n  web:\n    labels:\n      - "sencho.service.url=https://a.example.com"\n'))
      .toBe('services:\n  web:\n    labels:\n      - "io.sencho.url=https://a.example.com"\n');
    expect(renamed('services:\n  web:\n    labels:\n      - sencho.service.url\n'))
      .toBe('services:\n  web:\n    labels:\n      - io.sencho.url\n');
  });

  it('renames inside flow collections', () => {
    expect(renamed('services:\n  web:\n    labels: { sencho.service.url: "https://a.example.com", x: y }\n'))
      .toBe('services:\n  web:\n    labels: { io.sencho.url: "https://a.example.com", x: y }\n');
    expect(renamed('services:\n  web:\n    labels: ["sencho.service.url=https://a.example.com"]\n'))
      .toBe('services:\n  web:\n    labels: ["io.sencho.url=https://a.example.com"]\n');
  });

  it('drops the retired label when io.sencho.url is already declared', () => {
    const map = 'services:\n  web:\n    labels:\n      io.sencho.url: https://new.example.com\n      sencho.service.url: https://old.example.com\n      other: x\n';
    expect(renamed(map)).toBe('services:\n  web:\n    labels:\n      io.sencho.url: https://new.example.com\n      other: x\n');
    const list = 'services:\n  web:\n    labels:\n      - io.sencho.url=https://new.example.com\n      - sencho.service.url=https://old.example.com\n';
    expect(renamed(list)).toBe('services:\n  web:\n    labels:\n      - io.sencho.url=https://new.example.com\n');
    const flow = 'services:\n  web:\n    labels: { io.sencho.url: "https://n.example.com", sencho.service.url: "https://o.example.com" }\n';
    expect(renamed(flow)).toContain('io.sencho.url');
    expect(renamed(flow)).not.toContain('sencho.service.url');
  });

  it('touches only the named service', () => {
    const source = 'services:\n  web:\n    labels:\n      sencho.service.url: https://a.example.com\n  api:\n    labels:\n      sencho.service.url: https://b.example.com\n';
    expect(renamed(source, 'web')).toBe(
      'services:\n  web:\n    labels:\n      io.sencho.url: https://a.example.com\n  api:\n    labels:\n      sencho.service.url: https://b.example.com\n',
    );
  });

  it('returns the source unchanged when the service has no retired label', () => {
    const source = 'services:\n  web:\n    labels:\n      io.sencho.url: https://a.example.com\n';
    expect(renamed(source)).toBe(source);
  });

  it('preserves CRLF files', () => {
    const source = 'services:\r\n  web:\r\n    labels:\r\n      sencho.service.url: https://a.example.com\r\n';
    expect(renamed(source)).toBe(source.replace('sencho.service.url', 'io.sencho.url'));
  });

  describe('refusals', () => {
    const refused = (source: string, service = 'web') => {
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      return renameRetiredServiceUrlLabel(source, service);
    };

    it('refuses anchored, aliased and merged labels and anchored services', () => {
      expect(refused('x-l: &l\n  sencho.service.url: https://a.example.com\nservices:\n  web:\n    labels: *l\n')).toEqual({ ok: false, reason: 'unsupported' });
      expect(refused('services:\n  web:\n    labels: &l\n      sencho.service.url: https://a.example.com\n')).toEqual({ ok: false, reason: 'unsupported' });
      expect(refused('x-l: &l\n  y: z\nservices:\n  web:\n    labels:\n      <<: *l\n      sencho.service.url: https://a.example.com\n')).toEqual({ ok: false, reason: 'unsupported' });
      expect(refused('services:\n  web: &w\n    labels:\n      sencho.service.url: https://a.example.com\n')).toEqual({ ok: false, reason: 'unsupported' });
    });

    it('refuses custom tags and interpolated list keys', () => {
      expect(refused('services:\n  web:\n    labels: !override\n      sencho.service.url: https://a.example.com\n')).toEqual({ ok: false, reason: 'unsupported' });
      expect(refused('services:\n  web:\n    labels:\n      - "${K}=v"\n      - sencho.service.url=https://a.example.com\n')).toEqual({ ok: false, reason: 'unsupported' });
    });

    it('reports a missing service and unparsable text', () => {
      expect(refused('services:\n  web: {}\n', 'api')).toEqual({ ok: false, reason: 'missing-service' });
      expect(refused('services: [\n')).toEqual({ ok: false, reason: 'parse' });
    });
  });
});
