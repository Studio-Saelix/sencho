import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, act, renderHook, within } from '@testing-library/react';
import { AppearanceSection } from '../AppearanceSection';
import { useTheme } from '@/hooks/use-theme';
import { SETTINGS_ITEMS } from '../registry';
import { SIDEBAR_WIDTH, SIDEBAR_MODE_KEY, SIDEBAR_WIDTH_KEY } from '@/hooks/use-sidebar-layout';
import { ANATOMY_WIDTH, ANATOMY_MODE_KEY, ANATOMY_WIDTH_KEY } from '@/hooks/use-anatomy-layout';
import { subscribeToPreferenceWrites } from '@/lib/preferences/preferenceEvents';
import { SENCHO_SETTINGS_CHANGED } from '@/lib/events';

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
    beforeEach(() => {
        localStorage.clear();
        resetTheme();
    });

    it('renders the four refresh sections above Theme', () => {
        render(<AppearanceSection onResetAppearance={() => {}} onResetNavigation={() => {}} />);
        expect(screen.getByText('Visual style')).toBeTruthy();
        expect(screen.getByText('Security visualization')).toBeTruthy();
        expect(screen.getByText('Readability')).toBeTruthy();
        expect(screen.getByText('Motion & effects')).toBeTruthy();
    });

    it('selecting the Calm card applies the calm resolution to <html>', () => {
        render(<AppearanceSection onResetAppearance={() => {}} onResetNavigation={() => {}} />);
        fireEvent.click(screen.getByRole('button', { name: /Calm/i }));
        expect(document.documentElement.dataset.headings).toBe('clean');
        expect(document.documentElement.dataset.chartStyle).toBe('muted');
        expect(document.documentElement.dataset.effects).toBe('reduced');
        expect(document.documentElement.dataset.motion).toBe('reduced');
    });

    it('Calm and Signature preset apply write reducedMotion; Effects alone does not', () => {
        render(<AppearanceSection onResetAppearance={() => {}} onResetNavigation={() => {}} />);
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
        render(<AppearanceSection onResetAppearance={() => {}} onResetNavigation={() => {}} />);
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
        render(<AppearanceSection onResetAppearance={() => {}} onResetNavigation={() => {}} />);
        expect(
            screen.getByText(/Applies to service chips on multi-service or multi-container stacks/i),
        ).toBeTruthy();
    });

    it('readability locks the header + chart controls and disables the glow slider', () => {
        const { container } = render(<AppearanceSection onResetAppearance={() => {}} onResetNavigation={() => {}} />);
        // Fixed mode leaves the pane width sliders unapplied; the
        // readability-gated controls are all active.
        const glowLocked = () => !!container.querySelector('[aria-label="Ambient glow"][data-disabled]');
        const sidebarLocked = () => !!container.querySelector('[aria-label="Sidebar width"][data-disabled]');
        const anatomyLocked = () => !!container.querySelector('[aria-label="Anatomy panel width"][data-disabled]');
        expect(glowLocked()).toBe(false);
        expect(sidebarLocked()).toBe(true);
        expect(anatomyLocked()).toBe(true);
        expect(screen.getByRole('radiogroup', { name: 'Header style' }).getAttribute('aria-disabled')).toBeNull();

        fireEvent.click(screen.getByRole('switch', { name: 'Readability mode' }));

        expect(screen.getByRole('radiogroup', { name: 'Header style' }).getAttribute('aria-disabled')).toBe('true');
        expect(screen.getByRole('radiogroup', { name: 'Chart palette' }).getAttribute('aria-disabled')).toBe('true');
        expect((screen.getByRole('switch', { name: 'Reduced effects' }) as HTMLButtonElement).disabled).toBe(true);
        // Effective reduced (readability || reducedEffects) disables the glow slider
        // even though reducedEffects itself is still off.
        expect(glowLocked()).toBe(true);
    });

    it('reduced motion is independent of readability and toggles data-motion on <html>', () => {
        render(<AppearanceSection onResetAppearance={() => {}} onResetNavigation={() => {}} />);
        const motion = () => screen.getByRole('switch', { name: 'Reduced motion' }) as HTMLButtonElement;
        expect(document.documentElement.dataset.motion).toBeUndefined();
        // Readability flattens effects but must not disable the motion toggle.
        fireEvent.click(screen.getByRole('switch', { name: 'Readability mode' }));
        expect(motion().disabled).toBe(false);
        fireEvent.click(motion());
        expect(document.documentElement.dataset.motion).toBe('reduced');
    });

    it('readability also locks the Visual style cards and the Border brightness slider', () => {
        const { container } = render(<AppearanceSection onResetAppearance={() => {}} onResetNavigation={() => {}} />);
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
        render(<AppearanceSection onResetAppearance={() => {}} onResetNavigation={() => {}} />);
        // Baseline is Signature, so the Signature card reads selected.
        expect(screen.getByRole('button', { name: /Today's look/i }).getAttribute('aria-pressed')).toBe('true');
        // A custom chart palette (Heat) makes the trio match no preset.
        fireEvent.click(screen.getByRole('radio', { name: 'Heat' }));
        expect(screen.getByRole('button', { name: /Today's look/i }).getAttribute('aria-pressed')).toBe('false');
        expect(screen.getByRole('button', { name: /readable default/i }).getAttribute('aria-pressed')).toBe('false');
    });

    it('de-selects when only the header style diverges (not just the chart palette)', () => {
        render(<AppearanceSection onResetAppearance={() => {}} onResetNavigation={() => {}} />);
        // Baseline Signature; flipping only Header style to Clean breaks the match.
        fireEvent.click(screen.getByRole('radio', { name: 'Clean' }));
        expect(screen.getByRole('button', { name: /Today's look/i }).getAttribute('aria-pressed')).toBe('false');
        expect(screen.getByRole('button', { name: /readable default/i }).getAttribute('aria-pressed')).toBe('false');
    });

    it('reset to default restores Calm and locks while readability is on', () => {
        render(<AppearanceSection onResetAppearance={() => {}} onResetNavigation={() => {}} />);
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
        render(<AppearanceSection onResetAppearance={() => {}} onResetNavigation={() => {}} />);
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
        render(<AppearanceSection onResetAppearance={() => {}} onResetNavigation={() => {}} />);
        const options = screen.getAllByRole('radio', { name: /bar|launcher/i }).map((el) => el.textContent);
        expect(options).toEqual(['Compact launcher', 'Smart bar']);
        expect(screen.queryByRole('radio', { name: 'Classic bar' })).toBeNull();
        expect(screen.queryByText('Classic bar retiring')).toBeNull();
    });

    it('disables Reset to defaults while default eligibility has not settled', () => {
        localStorage.clear();
        render(<AppearanceSection quickLinkCandidates={[]} defaultQuickLinkEligibility={null} onResetAppearance={() => {}} onResetNavigation={() => {}} />);
        expect((screen.getByRole('button', { name: 'Reset to defaults' }) as HTMLButtonElement).disabled).toBe(true);
    });

    it('enables Reset to defaults once default eligibility has settled', () => {
        localStorage.clear();
        render(<AppearanceSection quickLinkCandidates={[]} defaultQuickLinkEligibility={['dashboard']} onResetAppearance={() => {}} onResetNavigation={() => {}} />);
        expect((screen.getByRole('button', { name: 'Reset to defaults' }) as HTMLButtonElement).disabled).toBe(false);
    });

    it('the complete-domain reset buttons call the shared domain-reset handlers', () => {
        const onResetAppearance = vi.fn();
        const onResetNavigation = vi.fn();
        render(<AppearanceSection onResetAppearance={onResetAppearance} onResetNavigation={onResetNavigation} />);

        fireEvent.click(screen.getByRole('button', { name: 'Reset all appearance preferences' }));
        expect(onResetAppearance).toHaveBeenCalledTimes(1);
        expect(onResetNavigation).not.toHaveBeenCalled();

        fireEvent.click(screen.getByRole('button', { name: 'Reset all navigation preferences' }));
        expect(onResetNavigation).toHaveBeenCalledTimes(1);
        expect(onResetAppearance).toHaveBeenCalledTimes(1);
    });

    it('the account-synced footer and reset helpers state the account scope', () => {
        render(<AppearanceSection onResetAppearance={() => {}} onResetNavigation={() => {}} />);
        expect(screen.getByText(/saved to your account · every device picks it up on sign-in/i)).toBeTruthy();
        expect(screen.getAllByText(/for your account on every device/i).length).toBe(2);
        // The retired browser-local wording must not resurface.
        expect(screen.queryByText(/this browser/i)).toBeNull();
    });
});

describe('AppearanceSection sidebar layout', () => {
    beforeEach(() => {
        localStorage.clear();
        resetTheme();
    });

    // Radix puts the passed aria-label on the slider ROOT span (the element
    // that also carries data-disabled and the keyboard handler); the visible
    // thumb is a descendant with role="slider" and the value attributes.
    const sliderRoot = (container: HTMLElement) =>
        container.querySelector<HTMLElement>('[aria-label="Sidebar width"]');
    const sliderThumb = (container: HTMLElement) =>
        sliderRoot(container)?.querySelector<HTMLElement>('[role="slider"]');

    it('renders the sidebar layout rows with Fixed as the default and the width slider locked', () => {
        const { container } = render(<AppearanceSection onResetAppearance={() => {}} onResetNavigation={() => {}} />);
        expect(screen.getByText('Sidebar layout')).toBeTruthy();
        const modeGroup = screen.getByRole('radiogroup', { name: 'Sidebar mode' });
        expect(within(modeGroup).getByRole('radio', { name: 'Fixed' }).getAttribute('aria-checked')).toBe('true');
        expect(within(modeGroup).getByRole('radio', { name: 'Resizable' }).getAttribute('aria-checked')).toBe('false');
        // Fixed mode leaves the width preference unapplied, so the slider locks.
        expect(sliderRoot(container)?.getAttribute('data-disabled')).not.toBeNull();
        expect(sliderThumb(container)?.getAttribute('aria-valuenow')).toBe('256');
    });

    it('switching to Resizable unlocks the width slider without writing the width field', () => {
        localStorage.setItem(SIDEBAR_WIDTH_KEY, '340');
        const { container } = render(<AppearanceSection onResetAppearance={() => {}} onResetNavigation={() => {}} />);
        const notify = vi.fn();
        const unsub = subscribeToPreferenceWrites(notify);

        fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Sidebar mode' })).getByRole('radio', { name: 'Resizable' }));
        expect(sliderRoot(container)?.getAttribute('data-disabled')).toBeNull();
        expect(notify).toHaveBeenCalledTimes(1);
        expect(notify).toHaveBeenCalledWith('appearance', ['sidebarMode']);
        // The mode write never changes the width field: the stored 340 survives
        // and the slider keeps showing it.
        expect(localStorage.getItem(SIDEBAR_WIDTH_KEY)).toBe('340');
        expect(sliderThumb(container)?.getAttribute('aria-valuenow')).toBe('340');
        unsub();
    });

    it('the width slider drafts locally and writes once on commit', () => {
        localStorage.setItem(SIDEBAR_MODE_KEY, 'resizable');
        const { container } = render(<AppearanceSection onResetAppearance={() => {}} onResetNavigation={() => {}} />);
        const notify = vi.fn();
        const unsub = subscribeToPreferenceWrites(notify);
        expect(sliderRoot(container)?.getAttribute('data-disabled')).toBeNull();

        // Radix commits keyboard steps immediately (drag commits on release);
        // onValueCommit is the single write path for both.
        fireEvent.keyDown(sliderRoot(container)!, { key: 'End' });
        expect(notify).toHaveBeenCalledTimes(1);
        expect(notify).toHaveBeenCalledWith('appearance', ['sidebarWidth']);
        expect(Number(sliderThumb(container)?.getAttribute('aria-valuenow'))).toBe(SIDEBAR_WIDTH.max);
        expect(localStorage.getItem(SIDEBAR_WIDTH_KEY)).toBe(String(SIDEBAR_WIDTH.max));
        unsub();
    });

    it('a targeted sidebar reset restores Fixed and the default width, leaving other fields untouched', () => {
        localStorage.setItem(SIDEBAR_MODE_KEY, 'resizable');
        localStorage.setItem(SIDEBAR_WIDTH_KEY, '400');
        localStorage.setItem('sencho.appearance.density', 'compact');
        const { container } = render(<AppearanceSection onResetAppearance={() => {}} onResetNavigation={() => {}} />);

        fireEvent.click(screen.getByRole('button', { name: 'Reset sidebar layout' }));
        expect(localStorage.getItem(SIDEBAR_MODE_KEY)).toBe('fixed');
        expect(localStorage.getItem(SIDEBAR_WIDTH_KEY)).toBe(String(SIDEBAR_WIDTH.default));
        // Unrelated appearance fields survive the targeted reset.
        expect(localStorage.getItem('sencho.appearance.density')).toBe('compact');
        // The slider re-locks and the thumb lands on the default width.
        expect(sliderRoot(container)?.getAttribute('data-disabled')).not.toBeNull();
        expect(sliderThumb(container)?.getAttribute('aria-valuenow')).toBe(String(SIDEBAR_WIDTH.default));
    });

    it('the width draft re-syncs from the shared preference without issuing a write', () => {
        localStorage.setItem(SIDEBAR_MODE_KEY, 'resizable');
        localStorage.setItem(SIDEBAR_WIDTH_KEY, '300');
        const { container } = render(<AppearanceSection onResetAppearance={() => {}} onResetNavigation={() => {}} />);
        const notify = vi.fn();
        const unsub = subscribeToPreferenceWrites(notify);
        expect(sliderThumb(container)?.getAttribute('aria-valuenow')).toBe('300');

        // An apply-path change (targeted reset, hydration, another tab) lands
        // via the settings-changed event; the slider follows it with no write.
        localStorage.setItem(SIDEBAR_WIDTH_KEY, '352');
        act(() => {
            window.dispatchEvent(new CustomEvent(SENCHO_SETTINGS_CHANGED));
        });
        expect(sliderThumb(container)?.getAttribute('aria-valuenow')).toBe('352');
        expect(notify).not.toHaveBeenCalled();
        unsub();
    });

    it('registers the sidebar search keywords on the appearance entry', () => {
        const appearance = SETTINGS_ITEMS.find((item) => item.id === 'appearance');
        expect(appearance).toBeTruthy();
        for (const term of ['sidebar', 'resize', 'resizable', 'pane', 'width', 'layout']) {
            expect(appearance?.keywords, `keyword ${term}`).toContain(term);
        }
    });

    it('dragging the slider drafts locally and writes only on pointer release', () => {
        localStorage.setItem(SIDEBAR_MODE_KEY, 'resizable');
        localStorage.setItem(SIDEBAR_WIDTH_KEY, '300');
        const { container } = render(<AppearanceSection onResetAppearance={() => {}} onResetNavigation={() => {}} />);
        const notify = vi.fn();
        const unsub = subscribeToPreferenceWrites(notify);
        const root = sliderRoot(container)!;
        expect(root.getAttribute('data-disabled')).toBeNull();

        // Radix's pointer handlers consult the captured pointer position
        // against the slider rect; pin both so the drag math is deterministic.
        const rect: DOMRect = { width: 216, height: 20, top: 0, left: 0, bottom: 20, right: 216, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
        vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
            if (root.contains(this)) return rect;
            return { width: 0, height: 0, top: 0, left: 0, bottom: 0, right: 0, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
        });
        vi.spyOn(HTMLElement.prototype, 'hasPointerCapture').mockReturnValue(true);
        vi.spyOn(HTMLElement.prototype, 'setPointerCapture').mockImplementation(() => {});
        vi.spyOn(HTMLElement.prototype, 'releasePointerCapture').mockImplementation(() => {});
        // Radix maps pointer x onto [min, max] over the track rect, then snaps
        // to the 4px step. Compute the expected value the same way.
        const valueAt = (x: number) => Math.min(SIDEBAR_WIDTH.max, Math.max(SIDEBAR_WIDTH.min,
            Math.round((SIDEBAR_WIDTH.min + (x / 216) * (SIDEBAR_WIDTH.max - SIDEBAR_WIDTH.min)) / 4) * 4));

        fireEvent.pointerDown(root, { pointerId: 1, clientX: 108, button: 0 });
        const mid = valueAt(140);
        fireEvent.pointerMove(root, { pointerId: 1, clientX: 140 });
        // Mid-drag: the draft follows the pointer but nothing is queued.
        expect(Number(sliderThumb(container)?.getAttribute('aria-valuenow'))).toBe(mid);
        expect(notify).not.toHaveBeenCalled();
        expect(localStorage.getItem(SIDEBAR_WIDTH_KEY)).toBe('300');

        fireEvent.pointerUp(root, { pointerId: 1, clientX: 140 });
        // Release commits exactly once: one bus notify and one localStorage write.
        expect(notify).toHaveBeenCalledTimes(1);
        expect(notify).toHaveBeenCalledWith('appearance', ['sidebarWidth']);
        expect(localStorage.getItem(SIDEBAR_WIDTH_KEY)).toBe(String(mid));
        unsub();
        vi.restoreAllMocks();
    });
});

describe('AppearanceSection Anatomy layout', () => {
    beforeEach(() => {
        localStorage.clear();
        resetTheme();
    });

    const sliderRoot = (container: HTMLElement) =>
        container.querySelector<HTMLElement>('[aria-label="Anatomy panel width"]');
    const sliderThumb = (container: HTMLElement) =>
        sliderRoot(container)?.querySelector<HTMLElement>('[role="slider"]');

    it('keeps the Anatomy width inactive in Fixed mode and unlocks it in Resizable mode', () => {
        const { container } = render(<AppearanceSection onResetAppearance={() => {}} onResetNavigation={() => {}} />);
        const modeGroup = screen.getByRole('radiogroup', { name: 'Anatomy panel mode' });
        expect(within(modeGroup).getByRole('radio', { name: 'Fixed' }).getAttribute('aria-checked')).toBe('true');
        expect(sliderRoot(container)?.getAttribute('data-disabled')).not.toBeNull();

        fireEvent.click(within(modeGroup).getByRole('radio', { name: 'Resizable' }));

        expect(sliderRoot(container)?.getAttribute('data-disabled')).toBeNull();
        expect(localStorage.getItem(ANATOMY_MODE_KEY)).toBe('resizable');
    });

    it('commits the Anatomy width without changing the sidebar width', () => {
        localStorage.setItem(ANATOMY_MODE_KEY, 'resizable');
        localStorage.setItem(SIDEBAR_WIDTH_KEY, '400');
        const { container } = render(<AppearanceSection onResetAppearance={() => {}} onResetNavigation={() => {}} />);
        const notify = vi.fn();
        const unsub = subscribeToPreferenceWrites(notify);

        fireEvent.keyDown(sliderRoot(container)!, { key: 'End' });

        expect(notify).toHaveBeenCalledTimes(1);
        expect(notify).toHaveBeenCalledWith('appearance', ['anatomyWidth']);
        expect(sliderThumb(container)?.getAttribute('aria-valuenow')).toBe(String(ANATOMY_WIDTH.max));
        expect(localStorage.getItem(ANATOMY_WIDTH_KEY)).toBe(String(ANATOMY_WIDTH.max));
        expect(localStorage.getItem(SIDEBAR_WIDTH_KEY)).toBe('400');
        unsub();
    });

    it('resets only the Anatomy layout preferences', () => {
        localStorage.setItem(ANATOMY_MODE_KEY, 'resizable');
        localStorage.setItem(ANATOMY_WIDTH_KEY, '800');
        localStorage.setItem(SIDEBAR_WIDTH_KEY, '400');
        const { container } = render(<AppearanceSection onResetAppearance={() => {}} onResetNavigation={() => {}} />);

        fireEvent.click(screen.getByRole('button', { name: 'Reset Anatomy panel layout' }));

        expect(localStorage.getItem(ANATOMY_MODE_KEY)).toBe('fixed');
        expect(localStorage.getItem(ANATOMY_WIDTH_KEY)).toBe(String(ANATOMY_WIDTH.default));
        expect(localStorage.getItem(SIDEBAR_WIDTH_KEY)).toBe('400');
        expect(sliderRoot(container)?.getAttribute('data-disabled')).not.toBeNull();
        expect(sliderThumb(container)?.getAttribute('aria-valuenow')).toBe(String(ANATOMY_WIDTH.default));
    });
});
