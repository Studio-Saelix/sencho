/**
 * Guards against frontend/backend capability-registry drift.
 *
 * The capability list is maintained as two hand-written constants:
 * backend/src/services/CapabilityRegistry.ts and frontend/src/lib/capabilities.ts.
 * They MUST be identical, because the frontend gates features on the flags the
 * backend advertises. A capability present on only one side either makes a gate
 * impossible to express (frontend missing it) or advertises a feature the
 * frontend never gates (backend missing it). This test fails the moment the two
 * lists diverge so the drift is caught at CI time, not in production.
 */
import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

import { CAPABILITIES } from '../services/CapabilityRegistry';

function extractCapabilities(source: string): string[] {
  const start = source.indexOf('CAPABILITIES = [');
  if (start === -1) throw new Error('Could not locate CAPABILITIES array in frontend source');
  const end = source.indexOf(']', start);
  if (end === -1) throw new Error('Could not locate end of CAPABILITIES array in frontend source');
  const block = source.slice(start, end);
  return [...block.matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

describe('capability list parity (frontend <-> backend)', () => {
  it('frontend lib/capabilities.ts matches backend CapabilityRegistry exactly', () => {
    const frontendPath = path.resolve(__dirname, '../../../frontend/src/lib/capabilities.ts');
    const frontendSource = fs.readFileSync(frontendPath, 'utf8');
    const frontendCaps = extractCapabilities(frontendSource);

    expect([...frontendCaps].sort()).toEqual([...CAPABILITIES].sort());
  });
});
