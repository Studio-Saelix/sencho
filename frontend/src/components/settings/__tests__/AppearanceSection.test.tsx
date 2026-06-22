import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent, act, renderHook } from '@testing-library/react';
import { AppearanceSection } from '../AppearanceSection';
import { useTheme } from '@/hooks/use-theme';

// AppearanceSection drives the shared theme store. Reset it to a known Signature
// baseline (readability off, effects full) before each test so the disabled-state
// assertions start from a clean, undimmed state.
function resetTheme() {
    const { result } = renderHook(() => useTheme());
    act(() => {
        result.current.setReadability(false);
        result.current.setVisualStyle('signature');
        result.current.setContrast(0);
        result.current.setGlow(0.16);
    });
}

describe('AppearanceSection', () => {
    beforeEach(() => resetTheme());

    it('renders the four refresh sections above Theme', () => {
        render(<AppearanceSection />);
        expect(screen.getByText('Visual style')).toBeTruthy();
        expect(screen.getByText('Security visualization')).toBeTruthy();
        expect(screen.getByText('Readability')).toBeTruthy();
        expect(screen.getByText('Motion & effects')).toBeTruthy();
    });

    it('selecting the Calm card applies the calm resolution to <html>', () => {
        render(<AppearanceSection />);
        fireEvent.click(screen.getByRole('button', { name: /Calm/i }));
        expect(document.documentElement.dataset.headings).toBe('clean');
        expect(document.documentElement.dataset.chartStyle).toBe('muted');
    });

    it('readability locks the header + chart controls and disables the glow slider', () => {
        const { container } = render(<AppearanceSection />);
        // Baseline: nothing reduced, so no slider is disabled.
        expect(container.querySelectorAll('[data-disabled]').length).toBe(0);
        expect(screen.getByRole('radiogroup', { name: 'Header style' }).getAttribute('aria-disabled')).toBeNull();

        fireEvent.click(screen.getByRole('switch', { name: 'Readability mode' }));

        expect(screen.getByRole('radiogroup', { name: 'Header style' }).getAttribute('aria-disabled')).toBe('true');
        expect(screen.getByRole('radiogroup', { name: 'Chart palette' }).getAttribute('aria-disabled')).toBe('true');
        expect((screen.getByRole('switch', { name: 'Reduced effects' }) as HTMLButtonElement).disabled).toBe(true);
        // Effective reduced (readability || reducedEffects) disables the glow slider
        // even though reducedEffects itself is still off.
        expect(container.querySelectorAll('[data-disabled]').length).toBeGreaterThan(0);
    });

    it('de-selects both visual-style cards when a custom sub-axis is chosen', () => {
        render(<AppearanceSection />);
        // Baseline is Signature, so the Signature card reads selected.
        expect(screen.getByRole('button', { name: /Today's look/i }).getAttribute('aria-pressed')).toBe('true');
        // A custom chart palette (Heat) makes the trio match no preset.
        fireEvent.click(screen.getByRole('radio', { name: 'Heat' }));
        expect(screen.getByRole('button', { name: /Today's look/i }).getAttribute('aria-pressed')).toBe('false');
        expect(screen.getByRole('button', { name: /readable default/i }).getAttribute('aria-pressed')).toBe('false');
    });

    it('de-selects when only the header style diverges (not just the chart palette)', () => {
        render(<AppearanceSection />);
        // Baseline Signature; flipping only Header style to Clean breaks the match.
        fireEvent.click(screen.getByRole('radio', { name: 'Clean' }));
        expect(screen.getByRole('button', { name: /Today's look/i }).getAttribute('aria-pressed')).toBe('false');
        expect(screen.getByRole('button', { name: /readable default/i }).getAttribute('aria-pressed')).toBe('false');
    });

    it('reset to default restores Calm and locks while readability is on', () => {
        render(<AppearanceSection />);
        fireEvent.click(screen.getByRole('radio', { name: 'Heat' }));
        expect(document.documentElement.dataset.chartStyle).toBe('heat');

        fireEvent.click(screen.getByRole('button', { name: 'Reset to default' }));
        expect(document.documentElement.dataset.headings).toBe('clean');
        expect(document.documentElement.dataset.chartStyle).toBe('muted');
        expect(screen.getByRole('button', { name: /readable default/i }).getAttribute('aria-pressed')).toBe('true');

        fireEvent.click(screen.getByRole('switch', { name: 'Readability mode' }));
        expect((screen.getByRole('button', { name: 'Reset to default' }) as HTMLButtonElement).disabled).toBe(true);
    });
});
