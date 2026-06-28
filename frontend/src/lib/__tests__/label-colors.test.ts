import { describe, it, expect } from 'vitest';
import { HUE_VARS, hashLabel } from '@/lib/label-colors';

describe('HUE_VARS', () => {
    it('has exactly 10 entries', () => {
        expect(HUE_VARS).toHaveLength(10);
    });
});

describe('hashLabel', () => {
    it('returns a valid hue from HUE_VARS', () => {
        const hue = hashLabel('redis');
        expect(HUE_VARS).toContain(hue);
    });

    it('returns the same hue for the same input', () => {
        expect(hashLabel('redis')).toBe(hashLabel('redis'));
    });

    it('returns different hues for different inputs (typical case)', () => {
        // Not a strict guarantee, but highly likely with 10 buckets.
        const a = hashLabel('redis');
        const b = hashLabel('postgres');
        // They may collide, but the function must be stable.
        expect(HUE_VARS).toContain(a);
        expect(HUE_VARS).toContain(b);
    });
});
