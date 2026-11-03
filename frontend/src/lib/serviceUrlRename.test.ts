import { afterEach, describe, expect, it, vi } from 'vitest';
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
    expect(renamed(flow)).toBe('services:\n  web:\n    labels: { io.sencho.url: "https://n.example.com" }\n');
    const crlf = 'services:\r\n  web:\r\n    labels:\r\n      io.sencho.url: https://n.example.com\r\n      sencho.service.url: https://o.example.com\r\n      other: x\r\n';
    expect(renamed(crlf)).toBe('services:\r\n  web:\r\n    labels:\r\n      io.sencho.url: https://n.example.com\r\n      other: x\r\n');
  });

  it('keeps the current key even when its value is empty, so the retired value is dropped with it', () => {
    expect(renamed('services:\n  web:\n    labels:\n      io.sencho.url: ""\n      sencho.service.url: https://o.example.com\n'))
      .toBe('services:\n  web:\n    labels:\n      io.sencho.url: ""\n');
  });

  it('renames every duplicate retired list item, or drops them all when the current key is declared', () => {
    expect(renamed('services:\n  web:\n    labels:\n      - sencho.service.url=https://a.example.com\n      - sencho.service.url=https://b.example.com\n'))
      .toBe('services:\n  web:\n    labels:\n      - io.sencho.url=https://a.example.com\n      - io.sencho.url=https://b.example.com\n');
    expect(renamed('services:\n  web:\n    labels:\n      - sencho.service.url=https://a.example.com\n      - io.sencho.url=https://n.example.com\n      - sencho.service.url=https://b.example.com\n'))
      .toBe('services:\n  web:\n    labels:\n      - io.sencho.url=https://n.example.com\n');
  });

  it('keeps comments, tabs after the colon and odd indentation', () => {
    expect(renamed('services:\n  web:\n      labels:\n          sencho.service.url:\thttps://a.example.com # keep\n'))
      .toBe('services:\n  web:\n      labels:\n          io.sencho.url:\thttps://a.example.com # keep\n');
    expect(renamed('services:\n  web:\n    labels:\n      - sencho.service.url=https://a.example.com # keep\n'))
      .toBe('services:\n  web:\n    labels:\n      - io.sencho.url=https://a.example.com # keep\n');
  });

  it('leaves a key that is not exactly the retired label alone', () => {
    const source = 'services:\n  web:\n    labels:\n      "sencho.service.url ": https://a.example.com\n      sencho.service.urls: x\n';
    expect(renamed(source)).toBe(source);
  });

  it.each([
    ['no labels key', 'services:\n  web:\n    image: nginx\n'],
    ['an empty labels value', 'services:\n  web:\n    labels:\n'],
    ['an empty string labels value', 'services:\n  web:\n    labels: ""\n'],
    ['an empty labels map', 'services:\n  web:\n    labels: {}\n'],
  ])('leaves the file unchanged when the service has %s here (the label lives in another file)', (_name, source) => {
    expect(renamed(source)).toBe(source);
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
    afterEach(() => vi.restoreAllMocks());
    const refused = (source: string, service = 'web') => {
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      return renameRetiredServiceUrlLabel(source, service);
    };
    const UNSUPPORTED = { ok: false, reason: 'unsupported' };

    it.each([
      ['labels shared through an alias', 'x-l: &l\n  sencho.service.url: https://a.example.com\nservices:\n  web:\n    labels: *l\n'],
      ['an anchored labels block', 'services:\n  web:\n    labels: &l\n      sencho.service.url: https://a.example.com\n'],
      ['a merged labels block', 'x-l: &l\n  y: z\nservices:\n  web:\n    labels:\n      <<: *l\n      sencho.service.url: https://a.example.com\n'],
      ['an anchored service', 'services:\n  web: &w\n    labels:\n      sencho.service.url: https://a.example.com\n'],
      ['a custom YAML tag', 'services:\n  web:\n    labels: !override\n      sencho.service.url: https://a.example.com\n'],
      ['an interpolated list key', 'services:\n  web:\n    labels:\n      - "${K}=v"\n      - sencho.service.url=https://a.example.com\n'],
      ['an aliased list item', 'x: &i sencho.service.url=https://a.example.com\nservices:\n  web:\n    labels:\n      - *i\n'],
      ['an escaped key', 'services:\n  web:\n    labels:\n      "sencho\\x2eservice.url": https://a.example.com\n'],
    ])('refuses %s', (_name, source) => {
      expect(refused(source)).toMatchObject(UNSUPPORTED);
    });

    it('reports a missing service and unparsable text', () => {
      expect(refused('services:\n  web: {}\n', 'api')).toEqual({ ok: false, reason: 'missing-service' });
      expect(refused('services: [\n')).toEqual({ ok: false, reason: 'parse' });
    });
  });
});
