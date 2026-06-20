/**
 * buildStorageSummary + storageSection: the pure dossier-export helpers. They
 * omit unrenderable or mount-less stacks, coerce an unknown status, and render a
 * Markdown section that always carries the config-vs-data snapshot caveat.
 */
import { describe, it, expect } from 'vitest';
import { buildStorageSummary, storageSection } from './storageSummary';

describe('buildStorageSummary', () => {
  it('returns null when the model is unrenderable or there are no mounts', () => {
    expect(buildStorageSummary(null)).toBeNull();
    expect(buildStorageSummary({ renderable: false })).toBeNull();
    expect(buildStorageSummary({ renderable: true, mounts: [] })).toBeNull();
  });

  it('keeps only well-formed mounts and coerces an unknown status', () => {
    const summary = buildStorageSummary({
      renderable: true,
      stateful: true,
      portability: { status: 'not-a-status', reasons: ['r'] },
      mounts: [
        { service: 'web', type: 'bind', source: '/srv', target: '/data', readOnly: true },
        { service: 'web', type: 'nonsense', target: '/x' }, // dropped: bad type
        { type: 'named', target: '/y' }, // dropped: no service
      ],
    });
    expect(summary).not.toBeNull();
    expect(summary!.status).toBe('unknown');
    expect(summary!.mounts).toEqual([{ service: 'web', type: 'bind', source: '/srv', target: '/data', readOnly: true }]);
  });
});

describe('storageSection', () => {
  it('returns null for a null summary', () => {
    expect(storageSection(null)).toBeNull();
  });

  it('renders the status, mounts, and the config-vs-data caveat', () => {
    const md = storageSection({
      status: 'node-bound',
      reasons: ['Binds /mnt/media outside the stack directory.'],
      stateful: true,
      mounts: [{ service: 'web', type: 'bind', source: '/mnt/media', target: '/media', readOnly: false }],
    });
    expect(md).toContain('## Storage portability');
    expect(md).toContain('**Status:** Node-bound');
    expect(md).toContain('/mnt/media → /media');
    expect(md).toContain('Snapshots capture Compose and env files, not the data');
  });
});
