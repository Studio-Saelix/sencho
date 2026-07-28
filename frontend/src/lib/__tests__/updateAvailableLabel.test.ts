import { describe, it, expect } from 'vitest';
import { updateAvailableLabel } from '@/lib/updateAvailableLabel';

describe('updateAvailableLabel', () => {
  it('uses the generic label when no services are named', () => {
    expect(updateAvailableLabel()).toBe('Update available');
    expect(updateAvailableLabel([])).toBe('Update available');
  });

  it('names one or a few outdated services', () => {
    expect(updateAvailableLabel(['api'])).toBe('Update available: api');
    expect(updateAvailableLabel(['api', 'db', 'worker'])).toBe('Update available: api, db, worker');
  });

  it('summarizes larger service sets by count', () => {
    expect(updateAvailableLabel(['a', 'b', 'c', 'd'])).toBe('Update available: 4 services');
  });
});
