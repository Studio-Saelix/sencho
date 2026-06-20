import { describe, it, expect } from 'vitest';
import { buildEnvChecklistMarkdown, type EnvInventory } from '../envChecklist';

const inv: EnvInventory = {
  stackName: 'demo',
  renderable: true,
  items: [
    { key: 'DB_PASSWORD', sources: ['env-file'], usedForInterpolation: false, injectedIntoService: true, required: false, hasDefault: false, likelySecret: true, status: 'present' },
    { key: 'MISSING_VAR', sources: ['compose-ref'], usedForInterpolation: true, injectedIntoService: false, required: true, hasDefault: false, likelySecret: false, status: 'missing' },
  ],
  envFiles: [],
  summary: { total: 2, missing: 1, unused: 0, duplicate: 0, unpersisted: 0, likelySecret: 1 },
};

describe('buildEnvChecklistMarkdown', () => {
  it('lists names, status, and source, and marks likely secrets without a value', () => {
    const md = buildEnvChecklistMarkdown(inv);
    expect(md).toContain('# Environment checklist · demo');
    expect(md).toContain('No values are included');
    expect(md).toContain('DB_PASSWORD');
    expect(md).toContain('likely secret (value hidden)');
    expect(md).toContain('status: missing');
    expect(md).toMatch(/- \[x\] DB_PASSWORD/); // present → checked
    expect(md).toMatch(/- \[ \] MISSING_VAR/); // actionable → unchecked
  });

  it('notes partial data when the model could not be rendered', () => {
    expect(buildEnvChecklistMarkdown({ ...inv, renderable: false })).toContain('could not be rendered');
  });

  it('handles an empty inventory', () => {
    const md = buildEnvChecklistMarkdown({ ...inv, items: [], summary: { total: 0, missing: 0, unused: 0, duplicate: 0, unpersisted: 0, likelySecret: 0 } });
    expect(md).toContain('None referenced or defined.');
  });
});
