import { describe, it, expect, beforeEach, vi } from 'vitest';

// The store reads localStorage once at module import, so the read/validate/migrate
// path can only be exercised by re-importing the module after seeding storage.
// vi.resetModules() + a dynamic import gives a fresh store per test.

const KEY = 'sencho.appearance.theme';

describe('use-theme read / validate / migrate', () => {
    beforeEach(() => {
        vi.resetModules();
        localStorage.clear();
        const root = document.documentElement;
        root.removeAttribute('style');
        root.removeAttribute('data-theme');
        root.removeAttribute('data-accent');
        root.classList.remove('dark');
    });

    async function applyStored(): Promise<HTMLElement> {
        const mod = await import('./use-theme');
        mod.initializeTheme();
        return document.documentElement;
    }

    it('clamps out-of-range knobs and rejects non-finite / non-number values', async () => {
        localStorage.setItem(KEY, JSON.stringify({ glow: 999, contrast: 'nope', typeScale: 0, borderBoost: NaN }));
        const root = await applyStored();
        expect(root.style.getPropertyValue('--glow')).toBe('0.4');        // 999 clamped to max
        expect(root.style.getPropertyValue('--contrast')).toBe('0');      // 'nope' -> default
        expect(root.style.getPropertyValue('--type-scale')).toBe('0.88'); // 0 clamped to min
        expect(root.style.getPropertyValue('--border-boost')).toBe('0');  // NaN serializes to null -> default
    });

    it('falls back to defaults for unknown mode / accent (e.g. the removed teal)', async () => {
        localStorage.setItem(KEY, JSON.stringify({ theme: 'banana', accent: 'teal' }));
        const root = await applyStored();
        expect(root.dataset.theme).toBe('dim');
        expect(root.dataset.accent).toBe('cyan');
    });

    it('migrates the legacy sencho-theme key (dark -> dim)', async () => {
        localStorage.setItem('sencho-theme', 'dark');
        const root = await applyStored();
        expect(root.dataset.theme).toBe('dim');
        expect(root.classList.contains('dark')).toBe(true);
    });

    it('migrates the legacy light value through to the light theme', async () => {
        localStorage.setItem('sencho-theme', 'light');
        const root = await applyStored();
        expect(root.dataset.theme).toBe('light');
        expect(root.classList.contains('dark')).toBe(false);
    });
});
