import { describe, expect, it } from 'vitest';
import { spawnSync } from 'child_process';

import {
  parseComposeDocument, parseLabelFile, MAX_COMPOSE_PARSE_BYTES,
} from '../services/composeSource';
import { authoredNodeKey } from '../services/composeSource/parseComposeDocument';

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
    // A cap that stopped the read does not mean the file declares no services.
    expect(parsed.serviceNamesKnown).toBe(false);
  });

  it('detects !reset and !override markers without failing the parse', () => {
    const parsed = parse('services:\n  api:\n    image: !reset nginx\n    ports: !override []\n');
    expect(parsed.state).toBe('parsed');
    expect(parsed.nodes.get('services.api.image')?.customTag).toBe('!reset');
    expect(parsed.nodes.get('services.api.ports')?.customTag).toBe('!override');
  });

  it('projects declarations through aliases and merge keys instead of dropping them', () => {
    const parsed = parse([
      'x-base: &base',
      '  file: base.yml',
      '  service: base',
      'x-svc: &svc',
      '  image: nginx:1',
      '  labels:',
      '    team: override',
      'services:',
      '  <<: {app: *svc}',
      '  worker:',
      '    extends: *base',
      '',
    ].join('\n'));
    expect(parsed.serviceNames).toEqual(expect.arrayContaining(['app', 'worker']));
    expect(parsed.extends).toContainEqual({ service: 'worker', baseService: 'base', file: 'base.yml' });
    expect(parsed.inlineLabels).toContainEqual(expect.objectContaining({
      service: 'app', key: 'team', form: 'map', hasInterpolation: false,
    }));
  });

  it('keeps the top-level service names known when an alias chain exceeds the follow cap', () => {
    const lines: string[] = [];
    for (let level = 0; level < 20; level += 1) {
      lines.push(level === 0
        ? 'x-0: &a0 [true]'
        : `x-${level}: &a${level} [*a${level - 1}]`);
    }
    lines.push('services:', '  web:', '    image: nginx:1.27', '    privileged: true', '');
    const parsed = parse(lines.join('\n'));
    // The chain is refused, so locations are not defensible...
    expect(parsed.state).toBe('parse-failed');
    expect(parsed.diagnostics.map(entry => entry.code)).toContain('too-deep');
    // ...but the file still declares web, and Doctor must not call it foreign.
    expect(parsed.serviceNames).toEqual(['web']);
    expect(parsed.serviceNamesKnown).toBe(true);
  });

  it('enumerates services supplied through a root-level alias or merge chain', () => {
    const lines = [
      'x-1: &a1',
      '  web:',
      '    image: nginx:1.27',
    ];
    for (let level = 2; level <= 5; level += 1) lines.push(`x-${level}: &a${level} {<<: *a${level - 1}}`);
    lines.push('services: *a5', '');
    const parsed = parse(lines.join('\n'));
    expect(parsed.state).toBe('parsed');
    expect(parsed.serviceNames).toEqual(['web']);
    expect(parsed.serviceNamesKnown).toBe(true);

    const deep = ['x-1: &a1', '  web:', '    image: nginx:1.27'];
    for (let level = 2; level <= 20; level += 1) deep.push(`x-${level}: &a${level} {<<: *a${level - 1}}`);
    deep.push('services: *a20', '');
    const tooDeep = parse(deep.join('\n'));
    // The services map itself was never reached, so the empty list is unknown.
    expect(tooDeep.serviceNames).toEqual([]);
    expect(tooDeep.serviceNamesKnown).toBe(false);
  });

  it('marks an inline label whose value is an alias as unresolved', () => {
    const parsed = parse([
      'x-value: &value override',
      'services:',
      '  app:',
      '    image: nginx:1',
      '    labels:',
      '      team: *value',
      '',
    ].join('\n'));
    expect(parsed.state).toBe('parsed');
    expect(parsed.inlineLabels).toContainEqual(expect.objectContaining({
      service: 'app', key: 'team', unresolved: true,
    }));
  });

  it('flattens a merge nested inside an anchored map', () => {
    const parsed = parse([
      'x-a: &a',
      '  image: new-image',
      '  healthcheck:',
      '    test: ["CMD", "new"]',
      'x-b: &b',
      '  <<: *a',
      'services:',
      '  api:',
      '    <<: *b',
      '    restart: always',
      '',
    ].join('\n'));
    expect(parsed.state).toBe('parsed');
    expect(parsed.nodes.get('services.api.image')?.via).toBe('merge');
    expect(parsed.nodes.get('services.api.healthcheck.test[0]')?.via).toBe('merge');
    expect(parsed.nodes.has('services.api.<<')).toBe(false);
  });

  it('keeps a bare list-form label as a declaration so later ranges stay aligned', () => {
    const parsed = parse([
      'services:',
      '  api:',
      '    image: nginx',
      '    labels:',
      '      - io.sencho.url',
      '      - io.sencho.url=https://example.test',
      '      - other=y',
      '',
    ].join('\n'));
    expect(parsed.inlineLabels.map(entry => entry.key)).toEqual(['io.sencho.url', 'io.sencho.url', 'other']);
    expect(parsed.inlineLabels.map(entry => entry.range.line)).toEqual([5, 6, 7]);
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

  it('keeps dotted top-level keys distinct from nested identities', () => {
    const parsed = parse([
      'networks:',
      '  edge:',
      '    driver: bridge',
      '    x:',
      '      driver: overlay',
      '  edge.x:',
      '    external: true',
      'configs:',
      '  app:',
      '    file: ./app.conf',
      '  app.file:',
      '    file: ./other.conf',
      '',
    ].join('\n'));
    expect(parsed.nodes.get(authoredNodeKey(['networks', 'edge', 'driver']))?.valueRange?.line).toBe(3);
    expect(parsed.nodes.get(authoredNodeKey(['networks', 'edge', 'x']))?.keyRange?.line).toBe(4);
    expect(parsed.nodes.get(authoredNodeKey(['networks', 'edge.x']))?.keyRange?.line).toBe(6);
    expect(parsed.nodes.get(authoredNodeKey(['configs', 'app', 'file']))?.valueRange?.line).toBe(10);
    expect(parsed.nodes.get(authoredNodeKey(['configs', 'app.file']))?.keyRange?.line).toBe(11);
    expect(parsed.resources).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'config', key: 'app', file: './app.conf' }),
      expect.objectContaining({ kind: 'config', key: 'app.file', file: './other.conf' }),
    ]));
  });

  it('resolves an anchored scalar used as a mapping key instead of dropping it', () => {
    const parsed = parse([
      'x-key: &k owner',
      'x-env: &e FOO',
      'services:',
      '  api:',
      '    image: nginx:1',
      '    labels:',
      '      ? *k',
      '      : inline',
      '    environment:',
      '      ? *e',
      '      : bar',
      '',
    ].join('\n'));
    expect(parsed.state).toBe('parsed');
    expect(parsed.inlineLabels).toContainEqual(expect.objectContaining({
      service: 'api', key: 'owner', form: 'map',
    }));
    expect(parsed.nodes.get(authoredNodeKey(['services', 'api', 'environment', 'FOO']))?.valueRange?.line).toBe(11);
  });

  it('does not treat a nested services map under an empty key as the project map', () => {
    const parsed = parse([
      '"":',
      '  services:',
      '    ghost:',
      '      image: nginx:1',
      'services:',
      '  api:',
      '    image: nginx:1',
      '',
    ].join('\n'));
    expect(parsed.serviceNames).toEqual(['api']);
    expect(authoredNodeKey([''])).not.toBe(authoredNodeKey([]));
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

  it('refuses a file with a self-referential alias and one fixed cycle diagnostic', () => {
    const source = 'services:\n  api:\n    x-a: &a [*a, *a, *a, *a, *a, *a, *a, *a]\n    <<: *a\n    image: nginx\n';
    const parsed = parse(source);
    // The walk stopped early, so the file is not understood and no location may
    // be claimed from it.
    expect(parsed.state).toBe('parse-failed');
    expect(parsed.diagnostics.filter(entry => entry.code === 'alias-cycle')).toHaveLength(1);
    expect(parsed.diagnostics.some(entry => entry.code === 'alias-budget')).toBe(false);
  });

  it('refuses a file whose alias work budget is exhausted', () => {
    const lines = ['x1: &x1', '  k: 1'];
    for (let level = 2; level <= 8; level += 1) {
      const refs = Array.from({ length: 8 }, () => `*x${level - 1}`).join(', ');
      lines.push(`x${level}: &x${level}`, `  <<: [${refs}]`);
    }
    lines.push('services:', '  api:', '    <<: *x8', '    image: nginx');
    const parsed = parse(`${lines.join('\n')}\n`);
    expect(parsed.state).toBe('parse-failed');
    expect(parsed.diagnostics.filter(entry => entry.code === 'alias-budget')).toHaveLength(1);
  });

  it('refuses a file with a forward or missing alias instead of dropping it', () => {
    const forward = parse('services:\n  api:\n    <<: *later\nxlater: &later\n  restart: always\n');
    expect(forward.state).toBe('parse-failed');
    expect(forward.diagnostics.filter(entry => entry.code === 'alias-unresolved')).toHaveLength(1);
    const missing = parse('services:\n  api:\n    <<: *nope\n');
    expect(missing.state).toBe('parse-failed');
    expect(missing.diagnostics.filter(entry => entry.code === 'alias-unresolved')).toHaveLength(1);
  });

  it('refuses a file whose alias chain exceeds the depth bound', () => {
    const lines: string[] = ['x0: &x0', '  k: 0'];
    for (let level = 1; level <= 20; level += 1) {
      lines.push(`x${level}: &x${level}`, `  k: *x${level - 1}`);
    }
    lines.push('services:', '  api:', '    <<: *x20', '    image: nginx');
    const parsed = parse(`${lines.join('\n')}\n`);
    expect(parsed.state).toBe('parse-failed');
    expect(parsed.diagnostics.filter(entry => entry.code === 'too-deep')).toHaveLength(1);
  });

  it('refuses hostile alias graphs inside an external process deadline', () => {
    const self = 'services:\n  api:\n    x-a: &a [*a, *a, *a, *a, *a, *a, *a, *a]\n    <<: *a\n    image: nginx\n';
    const lines = ['x1: &x1', '  k: 1'];
    for (let level = 2; level <= 8; level += 1) {
      const refs = Array.from({ length: 8 }, () => `*x${level - 1}`).join(', ');
      lines.push(`x${level}: &x${level}`, `  <<: [${refs}]`);
    }
    lines.push('services:', '  api:', '    <<: *x8', '    image: nginx');
    const branching = `${lines.join('\n')}\n`;
    // YAML anchors cannot express true mutual recursion (an alias must follow
    // its anchor), so this is the forward-reference form: it must be refused as
    // unresolved, not silently dropped or looped on.
    const mutual = 'x-a: &a\n  k: *b\nx-b: &b\n  k: *a\nservices:\n  api:\n    <<: *a\n    image: nginx\n';
    const script = [
      "const { parseComposeDocument } = require('./src/services/composeSource');",
      `const cases = ${JSON.stringify({ self, branching, mutual })};`,
      'const out = {};',
      'for (const [name, source] of Object.entries(cases)) {',
      '  const started = Date.now();',
      '  const parsed = parseComposeDocument({ file: "compose.yaml", kind: "compose-primary", writability: "writable", layerIndex: 0, source });',
      '  out[name] = { state: parsed.state, codes: [...new Set(parsed.diagnostics.map((entry) => entry.code))], ms: Date.now() - started };',
      '}',
      'console.log(JSON.stringify(out));',
      'process.exit(0);',
    ].join('\n');
    const result = spawnSync(process.execPath, ['-r', 'ts-node/register/transpile-only', '-e', script], {
      cwd: process.cwd(),
      timeout: 15_000,
      encoding: 'utf8',
    });
    expect(result.signal).not.toBe('SIGTERM');
    expect(result.status).toBe(0);
    const parsed = JSON.parse((result.stdout.trim().split('\n').pop() ?? '{}')) as Record<string, { state: string; codes: string[]; ms: number }>;
    expect(parsed.self.state).toBe('parse-failed');
    expect(parsed.self.codes).toContain('alias-cycle');
    expect(parsed.self.ms).toBeLessThan(1_000);
    expect(parsed.branching.state).toBe('parse-failed');
    expect(parsed.branching.codes).toContain('alias-budget');
    expect(parsed.branching.ms).toBeLessThan(1_000);
    expect(parsed.mutual.state).toBe('parse-failed');
    expect(parsed.mutual.codes).toContain('alias-unresolved');
    expect(parsed.mutual.ms).toBeLessThan(1_000);
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

  it('accepts an env-file export prefix and keeps the range on the key', () => {
    const parsed = parseLabelFile('app.labels', 'export ex=3\n  export\tspaced = 4\nplain=1\n');
    expect(parsed.entries.map(entry => entry.key)).toEqual(['ex', 'spaced', 'plain']);
    expect(parsed.diagnostics).toEqual([]);
    expect(parsed.entries[0].range).toEqual({ line: 1, column: 8, endLine: 1, endColumn: 12 });
    expect(parsed.entries[0].keyRange).toEqual({ line: 1, column: 8, endLine: 1, endColumn: 10 });
    expect(parsed.entries[0].valueRange).toEqual({ line: 1, column: 11, endLine: 1, endColumn: 12 });
    expect(parsed.entries[1].key).toBe('spaced');
    expect(parsed.entries[1].range.column).toBeGreaterThan(1);
  });

  it('treats an export-prefixed entry as the same key for duplicate detection and interpolation', () => {
    const parsed = parseLabelFile('app.labels', 'export a=1\na=2\nexport token=${SECRET}\n');
    expect(parsed.duplicateKeys.has('a')).toBe(true);
    expect(parsed.entries.find(entry => entry.key === 'token')?.hasInterpolation).toBe(true);
  });

  it('flags interpolation syntax without resolving it', () => {
    const parsed = parseLabelFile('app.labels', 'token=${SECRET}\n');
    expect(parsed.entries[0].hasInterpolation).toBe(true);
  });
});
