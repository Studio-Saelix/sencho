import { describe, expect, it } from 'vitest';

import {
  parseComposeDocument, parseLabelFile, MAX_COMPOSE_PARSE_BYTES,
} from '../services/composeSource';

const base = {
  file: 'compose.yaml',
  kind: 'compose-primary' as const,
  writability: 'writable' as const,
  layerIndex: 0,
};

function parse(source: string) {
  return parseComposeDocument({ ...base, source });
}

describe('parseComposeDocument', () => {
  it('records exact key, value, and sequence item ranges', () => {
    const parsed = parse([
      'services:',
      '  api:',
      '    image: nginx:1.27',
      '    ports:',
      '      - "8080:80"',
      '      - "127.0.0.1:9000:9000/tcp"',
      '',
    ].join('\n'));
    expect(parsed.state).toBe('parsed');
    expect(parsed.nodes.get('services.api')?.kind).toBe('mapping');
    const image = parsed.nodes.get('services.api.image');
    expect(image?.keyRange).toEqual({ line: 3, column: 5, endLine: 3, endColumn: 10 });
    expect(image?.valueRange).toEqual({ line: 3, column: 12, endLine: 3, endColumn: 22 });
    const item = parsed.nodes.get('services.api.ports[0]');
    expect(item?.form).toBe('short');
    expect(item?.valueRange).toEqual({ line: 5, column: 9, endLine: 5, endColumn: 18 });
  });

  it('marks duplicate keys as parse-failed with both positions and no nodes', () => {
    const parsed = parse('services:\n  api: {}\n  api: {}\n');
    expect(parsed.state).toBe('parse-failed');
    expect(parsed.nodes.size).toBe(0);
    const duplicate = parsed.diagnostics.find(entry => entry.code === 'duplicate-key');
    expect(duplicate?.range).toEqual({ line: 3, column: 3, endLine: 3, endColumn: 4 });
  });

  it('treats a file over the 1 MiB cap as too large', () => {
    const parsed = parse(`services:\n  api:\n    image: ${'a'.repeat(MAX_COMPOSE_PARSE_BYTES)}\n`);
    expect(parsed.state).toBe('too-large');
    expect(parsed.diagnostics[0]?.code).toBe('too-large');
  });

  it('detects !reset and !override markers without failing the parse', () => {
    const parsed = parse('services:\n  api:\n    image: !reset nginx\n    ports: !override []\n');
    expect(parsed.state).toBe('parsed');
    expect(parsed.nodes.get('services.api.image')?.customTag).toBe('!reset');
    expect(parsed.nodes.get('services.api.ports')?.customTag).toBe('!override');
  });

  it('records anchors, aliases, and merge keys with their via', () => {
    const parsed = parse([
      'x-base: &base',
      '  image: nginx',
      'services:',
      '  api:',
      '    <<: *base',
      '    restart: unless-stopped',
      '  copy:',
      '    image: *base',
      '',
    ].join('\n'));
    expect(parsed.state).toBe('parsed');
    expect(parsed.nodes.get('services.api.image')?.via).toBe('merge');
    expect(parsed.nodes.get('services.api.restart')?.via).toBe('own');
    expect(parsed.nodes.get('services.copy.image')?.via).toBe('alias');
  });

  it('keeps UTF-16 column parity on a multibyte line', () => {
    const parsed = parse('services:\n  api:\n    image: "héllo"\n');
    expect(parsed.nodes.get('services.api.image')?.valueRange).toEqual({
      line: 3, column: 12, endLine: 3, endColumn: 19,
    });
  });

  it('keeps CRLF sources on their real line numbers', () => {
    const parsed = parse('services:\r\n  api:\r\n    image: nginx:1\r\n');
    expect(parsed.nodes.get('services.api.image')?.valueRange?.line).toBe(3);
  });

  it('handles an empty document and rejects a non-map root', () => {
    const empty = parse('');
    expect(empty.state).toBe('parsed');
    expect(empty.nodes.size).toBe(0);
    const list = parse('- a\n- b\n');
    expect(list.state).toBe('parse-failed');
    expect(list.diagnostics[0]?.code).toBe('malformed-yaml');
  });
});

describe('parseLabelFile', () => {
  it('reads key=value entries with ranges and ignores comments', () => {
    const parsed = parseLabelFile('app.labels', '# comment\n\nio.sencho.url=http://example.test:8080\n\n');
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0].key).toBe('io.sencho.url');
    expect(parsed.entries[0].range).toEqual({ line: 3, column: 1, endLine: 3, endColumn: 39 });
    expect(parsed.entries[0].valueRange.column).toBe(15);
  });

  it('marks duplicate keys and unsupported lines explicitly', () => {
    const parsed = parseLabelFile('app.labels', 'a=1\na=2\nnonsense\n"unclosed=1\n');
    expect(parsed.duplicateKeys.has('a')).toBe(true);
    expect(parsed.diagnostics.filter(entry => entry.code === 'unsupported-syntax')).toHaveLength(2);
  });

  it('flags interpolation syntax without resolving it', () => {
    const parsed = parseLabelFile('app.labels', 'token=${SECRET}\n');
    expect(parsed.entries[0].hasInterpolation).toBe(true);
  });
});
