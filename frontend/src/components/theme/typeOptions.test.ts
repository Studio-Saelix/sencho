import { describe, it, expect } from 'vitest';
import { sizeIdForScale, SIZE_OPTIONS, UI_FONT_OPTIONS, MONO_FONT_OPTIONS } from './typeOptions';

describe('sizeIdForScale', () => {
    it('maps each exact preset scale to its id', () => {
        expect(sizeIdForScale(0.92)).toBe('S');
        expect(sizeIdForScale(1.0)).toBe('M');
        expect(sizeIdForScale(1.08)).toBe('L');
        expect(sizeIdForScale(1.16)).toBe('XL');
    });

    it('returns "" for off-preset scales so the popover shows no false selection', () => {
        expect(sizeIdForScale(0.96)).toBe('');
        expect(sizeIdForScale(1.04)).toBe('');
        expect(sizeIdForScale(1.2)).toBe('');
    });

    it('tolerates tiny floating-point drift within epsilon', () => {
        expect(sizeIdForScale(1.0 + 0.0005)).toBe('M');
        expect(sizeIdForScale(1.08 - 0.0005)).toBe('L');
    });
});

describe('type option sets', () => {
    it('exposes 3 interface faces, 3 data faces, and the four size presets', () => {
        expect(UI_FONT_OPTIONS).toHaveLength(3);
        expect(MONO_FONT_OPTIONS).toHaveLength(3);
        expect(SIZE_OPTIONS.map((o) => o.id)).toEqual(['S', 'M', 'L', 'XL']);
    });
});
