import { describe, expect, it } from 'vitest';

import {
  correlateField, correlateLabel, normalizeForCompare, parseComposeDocument, resolveEditOrigin,
} from '../services/composeSource';
import type { AuthoredFileSource, AuthoredProject, SourceFileKind } from '../services/composeSource';

function file(file: string, source: string, layerIndex: number, kind: SourceFileKind = 'compose-primary'): AuthoredFileSource {
  const parsed = parseComposeDocument({ file, source, kind, layerIndex, writability: 'writable' });
  return {
    file, kind, layerIndex, writability: 'writable', state: parsed.state,
    nodes: parsed.nodes, diagnostics: parsed.diagnostics,
  };
}

function project(files: Array<{ file: string; source: string; kind?: SourceFileKind }>, generated: Array<'mesh-override'> = []): AuthoredProject {
  return {
    stack: 'demo',
    nodeId: 1,
    files: files.map((entry, index) => file(entry.file, entry.source, index, entry.kind)),
    generatedLayers: generated,
    labels: new Map(),
    diagnostics: [],
    partial: false,
    partialReasons: [],
  };
}

describe('correlateField', () => {
  it('returns unique for one authored declaration', () => {
    const result = correlateField(project([{ file: 'compose.yaml', source: 'services:\n  api:\n    image: nginx:1\n' }]), 'api', 'image', 'nginx:1');
    expect(result.reason).toBe('unique');
    expect(result.origin?.file).toBe('compose.yaml');
  });

  it('returns override-winner when exactly one layer matches the effective value', () => {
    const result = correlateField(project([
      { file: 'compose.yaml', source: 'services:\n  api:\n    image: nginx:1\n' },
      { file: 'compose.override.yaml', source: 'services:\n  api:\n    image: nginx:2\n', kind: 'compose-override' },
    ]), 'api', 'image', 'nginx:2');
    expect(result.reason).toBe('override-winner');
    expect(result.origin?.file).toBe('compose.override.yaml');
    expect(result.candidates).toHaveLength(2);
  });

  it('returns ambiguous when more than one layer matches', () => {
    const result = correlateField(project([
      { file: 'compose.yaml', source: 'services:\n  api:\n    image: nginx:1\n' },
      { file: 'compose.override.yaml', source: 'services:\n  api:\n    image: nginx:1\n', kind: 'compose-override' },
    ]), 'api', 'image', 'nginx:1');
    expect(result.reason).toBe('ambiguous-multiple-sources');
    expect(result.origin).toBeUndefined();
  });

  it('returns ambiguous when several layers declare the field and none match', () => {
    const result = correlateField(project([
      { file: 'compose.yaml', source: 'services:\n  api:\n    image: nginx:1\n' },
      { file: 'compose.override.yaml', source: 'services:\n  api:\n    image: busybox:1\n', kind: 'compose-override' },
    ]), 'api', 'image', 'redis:7');
    expect(result.reason).toBe('ambiguous-multiple-sources');
  });

  it('recognizes short-form ports and $$ escapes as normalizations', () => {
    expect(normalizeForCompare('ports', '8080:80')).toBe(normalizeForCompare('ports', '8080:80/tcp'));
    const result = correlateField(project([{ file: 'compose.yaml', source: 'services:\n  api:\n    command: echo $$HOME\n' }]), 'api', 'command', 'echo $HOME');
    expect(result.reason).toBe('normalized');
    expect(result.origin?.file).toBe('compose.yaml');
  });

  it('returns interpolated and never claims a location', () => {
    const result = correlateField(project([{ file: 'compose.yaml', source: 'services:\n  api:\n    image: ${IMAGE}\n' }]), 'api', 'image', 'nginx:1');
    expect(result.reason).toBe('interpolated');
    expect(result.origin).toBeUndefined();
  });

  it('returns compose-tag for a lone !reset declaration', () => {
    const result = correlateField(project([{ file: 'compose.yaml', source: 'services:\n  api:\n    image: !reset null\n' }]), 'api', 'image');
    expect(result.reason).toBe('compose-tag');
    expect(result.origin).toBeUndefined();
  });

  it('explains a generated mesh layer instead of inventing an origin', () => {
    const result = correlateField(project([{ file: 'compose.yaml', source: 'services:\n  api:\n    image: nginx:1\n' }], ['mesh-override']), 'api', 'networks');
    expect(result.reason).toBe('generated-layer');
    expect(result.origin).toBeUndefined();
  });

  it('returns ambiguous-unparsed-source when no candidate exists and a layer failed to parse', () => {
    const result = correlateField(project([
      { file: 'compose.yaml', source: 'services:\n  api:\n    image: nginx:1\n' },
      { file: 'compose.override.yaml', source: 'services: [\n', kind: 'compose-override' },
    ]), 'api', 'restart');
    expect(result.reason).toBe('ambiguous-unparsed-source');
  });

  it('refuses a location when a declared layer is outside the managed boundary', () => {
    const base = project([{ file: 'compose.yaml', source: 'services:\n  api:\n    image: nginx:1\n' }]);
    const withOutside = {
      ...base,
      files: [
        ...base.files,
        { file: '../outside.yaml', kind: 'compose-additional' as const, writability: 'outside-boundary' as const, layerIndex: 1, state: 'outside-boundary' as const, nodes: new Map(), diagnostics: [] },
      ],
    };
    const result = correlateField(withOutside, 'api', 'image', 'nginx:1');
    expect(result.reason).toBe('ambiguous-unparsed-source');
    expect(result.origin).toBeUndefined();
    expect(result.ambiguity?.kind).toBe('outside-boundary');
  });

  it('returns no-authored-source when nothing is declared and nothing failed', () => {
    const result = correlateField(project([{ file: 'compose.yaml', source: 'services:\n  api:\n    image: nginx:1\n' }]), 'api', 'privileged');
    expect(result.reason).toBe('no-authored-source');
  });
});

describe('resolveEditOrigin', () => {
  it('returns an origin for an acting reason', () => {
    const result = resolveEditOrigin(
      project([{ file: 'compose.yaml', source: 'services:\n  api:\n    image: nginx:1\n' }]),
      'services.api.image',
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.origin.file).toBe('compose.yaml');
  });

  it('refuses every non-acting reason', () => {
    const projectWithGap = project([
      { file: 'compose.yaml', source: 'services:\n  api:\n    image: ${IMAGE}\n' },
    ]);
    const refused = resolveEditOrigin(projectWithGap, 'services.api.image');
    expect(refused).toEqual({ ok: false, reason: 'interpolated' });
    expect(resolveEditOrigin(projectWithGap, 'services.api.privileged')).toEqual({ ok: false, reason: 'no-authored-source' });
    expect(resolveEditOrigin(projectWithGap, 'not-a-path')).toEqual({ ok: false, reason: 'no-authored-source' });
  });

  it('refuses a label-file winner when a later outside label file could override it', () => {
    const base = project([{ file: 'compose.yaml', source: 'services:\n  api:\n    image: nginx:1\n' }]);
    const labels = new Map([['api', {
      service: 'api',
      contributions: [{
        key: 'a', source: 'label-file' as const, file: 'app.labels',
        range: { line: 1, column: 1, endLine: 1, endColumn: 4 },
        fileIndex: 0, layerIndex: 0, hasInterpolation: false, overridden: false, via: 'own' as const,
      }],
      winners: {
        a: {
          key: 'a', source: 'label-file' as const, file: 'app.labels',
          range: { line: 1, column: 1, endLine: 1, endColumn: 4 },
          fileIndex: 0, layerIndex: 0, hasInterpolation: false, overridden: false, via: 'own' as const,
        },
      },
      sharedFiles: [],
      ambiguity: {},
      unparsedLabelFiles: [],
      outsideLabelFiles: ['../outside.labels'],
    }]]);
    const result = correlateLabel({ ...base, labels }, 'api', 'a');
    expect(result.origin).toBeUndefined();
    expect(result.ambiguity?.kind).toBe('outside-boundary');
  });

  it('refuses an ambiguous label origin and accepts an acting one', () => {
    const labels = new Map([['api', {
      service: 'api',
      contributions: [],
      winners: {},
      sharedFiles: [],
      ambiguity: { a: 'duplicate-key' as const },
      unparsedLabelFiles: [],
      outsideLabelFiles: [],
    }]]);
    const base = project([{ file: 'compose.yaml', source: 'services:\n  api:\n    image: nginx:1\n' }]);
    const withLabels = { ...base, labels };
    expect(correlateLabel(withLabels, 'api', 'a').reason).toBe('ambiguous-multiple-sources');
    expect(resolveEditOrigin(withLabels, 'services.api.labels.a')).toEqual({ ok: false, reason: 'ambiguous-multiple-sources' });
  });
});
