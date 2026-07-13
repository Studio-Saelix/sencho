/**
 * Complete host-mode severity matrix as a pure-function unit test, so a
 * refactor that inverts one intent's severity is caught without the full route.
 */
import { describe, it, expect } from 'vitest';
import { hostModeSeverity } from '../services/network/networkingFindings';
import type { ExposureIntent } from '../services/network/types';

describe('hostModeSeverity matrix', () => {
  // Contradiction rows: high regardless of whether the Dossier documents access.
  const contradiction: (ExposureIntent | null)[] = ['internal', 'same-node', 'unknown', null];
  for (const intent of contradiction) {
    it(`${intent ?? 'unset'} is high with and without documentation`, () => {
      expect(hostModeSeverity(intent, false)).toBe('high');
      expect(hostModeSeverity(intent, true)).toBe('high');
    });
  }

  // Deliberate-exposure rows: medium undocumented, downgraded to info once a
  // Dossier access URL documents the exposure.
  const deliberate: ExposureIntent[] = ['lan', 'public', 'reverse-proxy', 'temporary'];
  for (const intent of deliberate) {
    it(`${intent} is medium undocumented and info once documented`, () => {
      expect(hostModeSeverity(intent, false)).toBe('medium');
      expect(hostModeSeverity(intent, true)).toBe('info');
    });
  }
});
