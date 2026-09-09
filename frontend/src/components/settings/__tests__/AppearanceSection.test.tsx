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
        result.current.setReducedMotion(false);
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
        expect(document.documentElement.dataset.effects).toBe('reduced');
        expect(document.documentElement.dataset.motion).toBe('reduced');
    });

    it('Calm and Signature preset apply write reducedMotion; Effects alone does not', () => {
        render(<AppearanceSection />);
        // Baseline Signature clears Motion.
        expect(document.documentElement.dataset.motion).toBeUndefined();

        fireEvent.click(screen.getByRole('switch', { name: 'Reduced motion' }));
        expect(document.documentElement.dataset.motion).toBe('reduced');
        // Re-applying Signature clears a manually enabled Motion.
        fireEvent.click(screen.getByRole('button', { name: /Today's look|Signature/i }));
        expect(document.documentElement.dataset.motion).toBeUndefined();

        fireEvent.click(screen.getByRole('button', { name: /Calm|readable default/i }));
        expect(document.documentElement.dataset.motion).toBe('reduced');
        fireEvent.click(screen.getByRole('switch', { name: 'Reduced motion' }));
        expect(document.documentElement.dataset.motion).toBeUndefined();
        // Calm card stays selected with Motion off.
        expect(screen.getByRole('button', { name: /readable default/i }).getAttribute('aria-pressed')).toBe('true');
        // Re-applying Calm turns Motion back on.
        fireEvent.click(screen.getByRole('button', { name: /readable default/i }));
        expect(document.documentElement.dataset.motion).toBe('reduced');

        // Individual Effects toggle preserves Motion.
        fireEvent.click(screen.getByRole('switch', { name: 'Reduced motion' }));
        expect(document.documentElement.dataset.motion).toBeUndefined();
        fireEvent.click(screen.getByRole('switch', { name: 'Reduced effects' }));
        expect(document.documentElement.dataset.motion).toBeUndefined();
    });

    it('shows the constrained-graphics callout when Reduced motion is off, and hides it when on', () => {
        render(<AppearanceSection />);
        expect(screen.getByText('Constrained graphics')).toBeTruthy();

        // Reduced effects alone must not hide the Motion guidance.
        fireEvent.click(screen.getByRole('switch', { name: 'Reduced effects' }));
        expect(screen.getByText('Constrained graphics')).toBeTruthy();

        fireEvent.click(screen.getByRole('switch', { name: 'Reduced motion' }));
        expect(screen.queryByText('Constrained graphics', { exact: true })).toBeNull();

        fireEvent.click(screen.getByRole('switch', { name: 'Reduced motion' }));
        expect(screen.getByText('Constrained graphics')).toBeTruthy();

        // Readability does not enable Motion, so the callout stays.
        fireEvent.click(screen.getByRole('switch', { name: 'Readability mode' }));
        expect(screen.getByText('Constrained graphics')).toBeTruthy();
    });

    it('states that log chip color applies on multi-service or multi-container stacks', () => {
        render(<AppearanceSection />);
        expect(
            screen.getByText(/Applies to service chips on multi-service or multi-container stacks/i),
        ).toBeTruthy();
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

    it('reduced motion is independent of readability and toggles data-motion on <html>', () => {
        render(<AppearanceSection />);
        const motion = () => screen.getByRole('switch', { name: 'Reduced motion' }) as HTMLButtonElement;
        expect(document.documentElement.dataset.motion).toBeUndefined();
        // Readability flattens effects but must not disable the motion toggle.
        fireEvent.click(screen.getByRole('switch', { name: 'Readability mode' }));
        expect(motion().disabled).toBe(false);
        fireEvent.click(motion());
        expect(document.documentElement.dataset.motion).toBe('reduced');
    });

    it('readability also locks the Visual style cards and the Border brightness slider', () => {
        const { container } = render(<AppearanceSection />);
        const calmCard = () => screen.getByRole('button', { name: /readable default/i }) as HTMLButtonElement;
        const sigCard = () => screen.getByRole('button', { name: /Today's look/i }) as HTMLButtonElement;
        const borderLocked = () => !!container.querySelector('[aria-label="Border brightness"][data-disabled]');
        expect(calmCard().disabled).toBe(false);
        expect(borderLocked()).toBe(false);

        fireEvent.click(screen.getByRole('switch', { name: 'Readability mode' }));

        // Both cards lock (the topbar disables the same control), matching the
        // "turn readability off to choose a style" guidance.
        expect(calmCard().disabled).toBe(true);
        expect(sigCard().disabled).toBe(true);
        // Border brightness is forced to +0.03 under readability, so its slider locks.
        expect(borderLocked()).toBe(true);
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
        expect(document.documentElement.dataset.motion).toBe('reduced');
        expect(screen.getByRole('button', { name: /readable default/i }).getAttribute('aria-pressed')).toBe('true');

        fireEvent.click(screen.getByRole('switch', { name: 'Readability mode' }));
        expect((screen.getByRole('button', { name: 'Reset to default' }) as HTMLButtonElement).disabled).toBe(true);
    });

    it('shows Navigation style and mode-conditional controls', () => {
        localStorage.clear();
        render(<AppearanceSection />);
        expect(screen.getByText('Navigation')).toBeTruthy();
        const navigationStyle = screen.getByRole('radiogroup', { name: 'Navigation style' });
        expect(navigationStyle).toBeTruthy();
        // Compact is the default: shows quick links, hides label/alignment controls.
        expect(screen.getByText('Quick links')).toBeTruthy();
        expect(screen.queryByText('Top navigation labels')).toBeNull();

        fireEvent.click(screen.getByRole('radio', { name: 'Smart bar' }));
        expect(screen.getByText('Top navigation labels')).toBeTruthy();
        expect(screen.queryByText('Quick links')).toBeNull();

        fireEvent.click(screen.getByRole('radio', { name: 'Compact launcher' }));
        expect(screen.getByText('Quick links')).toBeTruthy();
        expect(screen.queryByText('Top navigation labels')).toBeNull();
    });

    it('offers only Compact launcher and Smart bar, with Compact first', () => {
        localStorage.clear();
        render(<AppearanceSection />);
        const options = screen.getAllByRole('radio', { name: /bar|launcher/i }).map((el) => el.textContent);
        expect(options).toEqual(['Compact launcher', 'Smart bar']);
        expect(screen.queryByRole('radio', { name: 'Classic bar' })).toBeNull();
        expect(screen.queryByText('Classic bar retiring')).toBeNull();
    });

    it('disables Reset to defaults while default eligibility has not settled', () => {
        localStorage.clear();
        render(<AppearanceSection quickLinkCandidates={[]} defaultQuickLinkEligibility={null} />);
        expect((screen.getByRole('button', { name: 'Reset to defaults' }) as HTMLButtonElement).disabled).toBe(true);
    });

    it('enables Reset to defaults once default eligibility has settled', () => {
        localStorage.clear();
        render(<AppearanceSection quickLinkCandidates={[]} defaultQuickLinkEligibility={['dashboard']} />);
        expect((screen.getByRole('button', { name: 'Reset to defaults' }) as HTMLButtonElement).disabled).toBe(false);
    });
});
