import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useTheme, initializeTheme, THEME_MODES, ACCENTS, UI_FONTS, MONO_FONTS, TYPE_SIZES } from './use-theme';

const STORAGE_KEY = 'sencho.appearance.theme';

function readBlob(): Record<string, unknown> {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
}

describe('useTheme', () => {
    beforeEach(() => {
        // Sync <html> to the current store state (the pre-paint script does this
        // in the browser; tests have no pre-paint).
        initializeTheme();
    });

    afterEach(() => {
        // Reset the shared module store so tests stay order-independent.
        const { result } = renderHook(() => useTheme());
        act(() => {
            result.current.setTheme('dim');
            result.current.setAccent('cyan');
            result.current.setBorderBoost(0);
            result.current.setGlow(0.16);
            result.current.setContrast(0);
            result.current.setUiFont('Geist');
            result.current.setMonoFont('Geist Mono');
            result.current.setTypeScale(1);
        });
    });

    it('exposes four modes and the distinct eight accents (no teal/indigo)', () => {
        expect(THEME_MODES.map((m) => m.id)).toEqual(['dim', 'oled', 'light', 'auto']);
        expect(ACCENTS).toHaveLength(8);
        expect(ACCENTS.map((a) => a.id)).toEqual(
            expect.arrayContaining(['cyan', 'blue', 'violet', 'magenta', 'orange', 'amber', 'lime', 'steel']),
        );
        expect(ACCENTS.map((a) => a.id)).not.toContain('teal');
        expect(ACCENTS.map((a) => a.id)).not.toContain('indigo');
    });

    it('defaults to Dim with the dark class applied', () => {
        const { result } = renderHook(() => useTheme());
        expect(result.current.theme).toBe('dim');
        expect(result.current.accent).toBe('cyan');
        expect(result.current.isDarkMode).toBe(true);
        expect(document.documentElement.dataset.theme).toBe('dim');
        expect(document.documentElement.classList.contains('dark')).toBe(true);
    });

    it('light mode drops the dark class and persists', () => {
        const { result } = renderHook(() => useTheme());
        act(() => result.current.setTheme('light'));
        expect(result.current.isDarkMode).toBe(false);
        expect(document.documentElement.dataset.theme).toBe('light');
        expect(document.documentElement.classList.contains('dark')).toBe(false);
        expect(readBlob().theme).toBe('light');
    });

    it('OLED keeps the dark class', () => {
        const { result } = renderHook(() => useTheme());
        act(() => result.current.setTheme('oled'));
        expect(result.current.isDarkMode).toBe(true);
        expect(document.documentElement.dataset.theme).toBe('oled');
        expect(document.documentElement.classList.contains('dark')).toBe(true);
    });

    it('applies accent and the three knobs to <html> and persists them', () => {
        const { result } = renderHook(() => useTheme());
        act(() => {
            result.current.setAccent('violet');
            result.current.setBorderBoost(0.05);
            result.current.setGlow(0.3);
            result.current.setContrast(0.6);
        });
        expect(document.documentElement.dataset.accent).toBe('violet');
        expect(document.documentElement.style.getPropertyValue('--border-boost')).toBe('0.05');
        expect(document.documentElement.style.getPropertyValue('--glow')).toBe('0.3');
        expect(document.documentElement.style.getPropertyValue('--contrast')).toBe('0.6');
        const blob = readBlob();
        expect(blob.accent).toBe('violet');
        expect(blob.borderBoost).toBe(0.05);
        expect(blob.glow).toBe(0.3);
        expect(blob.contrast).toBe(0.6);
    });

    it('exposes 3 interface faces, 3 data faces, and 4 size presets with Geist defaults', () => {
        expect(UI_FONTS.map((f) => f.id)).toEqual(['Geist', 'IBM Plex Sans', 'Hanken Grotesk']);
        expect(MONO_FONTS.map((f) => f.id)).toEqual(['Geist Mono', 'IBM Plex Mono', 'Fira Code']);
        expect(TYPE_SIZES.map((s) => s.id)).toEqual(['S', 'M', 'L', 'XL']);
        const { result } = renderHook(() => useTheme());
        expect(result.current.uiFont).toBe('Geist');
        expect(result.current.monoFont).toBe('Geist Mono');
        expect(result.current.typeScale).toBe(1);
    });

    it('applies font faces and text scale to <html> and persists them', () => {
        const { result } = renderHook(() => useTheme());
        act(() => {
            result.current.setUiFont('IBM Plex Sans');
            result.current.setMonoFont('Fira Code');
            result.current.setTypeScale(1.16);
        });
        expect(document.documentElement.style.getPropertyValue('--ui-font')).toBe("'IBM Plex Sans'");
        expect(document.documentElement.style.getPropertyValue('--mono-font')).toBe("'Fira Code'");
        expect(document.documentElement.style.getPropertyValue('--type-scale')).toBe('1.16');
        const blob = readBlob();
        expect(blob.uiFont).toBe('IBM Plex Sans');
        expect(blob.monoFont).toBe('Fira Code');
        expect(blob.typeScale).toBe(1.16);
    });

    it('shares state across two consumers (one store)', () => {
        const a = renderHook(() => useTheme());
        const b = renderHook(() => useTheme());
        act(() => a.result.current.setAccent('lime'));
        expect(a.result.current.accent).toBe('lime');
        expect(b.result.current.accent).toBe('lime');
    });
});
