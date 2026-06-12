/**
 * Guards the move of the stack-workflow controls out of Appearance into Stacks.
 *
 * The three controls (Deploy progress, Progress style, Diff preview before save)
 * are browser-local localStorage preferences. Moving the JSX must not change the
 * storage keys they write, so the deploy/editor consumers keep reading the same
 * values. These tests assert the controls render in Stacks, still flip the same
 * keys, and no longer render in Appearance.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { StacksSection } from '../StacksSection';
import { AppearanceSection } from '../AppearanceSection';
import { DEPLOY_FEEDBACK_KEY } from '@/hooks/use-deploy-feedback-enabled';
import { DEPLOY_FEEDBACK_STYLE_KEY } from '@/hooks/use-deploy-feedback-style';
import { COMPOSE_DIFF_PREVIEW_KEY } from '@/hooks/use-compose-diff-preview-enabled';

beforeEach(() => {
    window.localStorage.clear();
});

afterEach(() => {
    window.localStorage.clear();
});

describe('StacksSection', () => {
    it('renders the three workflow controls (Progress style while deploy progress is on)', () => {
        render(<StacksSection />);
        expect(screen.getByText('Deploy progress')).toBeInTheDocument();
        // Deploy progress defaults on, so Progress style is visible.
        expect(screen.getByText('Progress style')).toBeInTheDocument();
        expect(screen.getByText('Diff preview before save')).toBeInTheDocument();
    });

    it('flips the deploy-progress key and hides Progress style when disabled', () => {
        const { container } = render(<StacksSection />);
        const toggle = container.querySelector('#deploy-feedback') as HTMLElement;
        // Default on => no stored value yet.
        expect(window.localStorage.getItem(DEPLOY_FEEDBACK_KEY)).toBeNull();
        fireEvent.click(toggle);
        expect(window.localStorage.getItem(DEPLOY_FEEDBACK_KEY)).toBe('false');
        // Progress style is gated on the enabled state and drops out.
        expect(screen.queryByText('Progress style')).not.toBeInTheDocument();
    });

    it('round-trips the progress-style key between Inline and Modal', () => {
        render(<StacksSection />);
        fireEvent.click(screen.getByRole('radio', { name: 'Inline' }));
        expect(window.localStorage.getItem(DEPLOY_FEEDBACK_STYLE_KEY)).toBe('inline');
        fireEvent.click(screen.getByRole('radio', { name: 'Modal' }));
        expect(window.localStorage.getItem(DEPLOY_FEEDBACK_STYLE_KEY)).toBe('modal');
    });

    it('hydrates each control from its stored value (read path survives the move)', () => {
        window.localStorage.setItem(DEPLOY_FEEDBACK_KEY, 'false');
        window.localStorage.setItem(COMPOSE_DIFF_PREVIEW_KEY, 'true');
        const { container } = render(<StacksSection />);
        // Deploy progress reads its stored 'false': checkbox unchecked, Progress style hidden.
        expect(container.querySelector('#deploy-feedback')?.getAttribute('aria-checked')).toBe('false');
        expect(screen.queryByText('Progress style')).not.toBeInTheDocument();
        // Diff preview reads its stored 'true': checkbox checked.
        expect(container.querySelector('#compose-diff-preview')?.getAttribute('aria-checked')).toBe('true');
    });

    it('flips the diff-preview key when enabled', () => {
        const { container } = render(<StacksSection />);
        const toggle = container.querySelector('#compose-diff-preview') as HTMLElement;
        expect(window.localStorage.getItem(COMPOSE_DIFF_PREVIEW_KEY)).toBeNull();
        fireEvent.click(toggle);
        expect(window.localStorage.getItem(COMPOSE_DIFF_PREVIEW_KEY)).toBe('true');
    });
});

describe('AppearanceSection no longer owns stack-workflow controls', () => {
    it('does not render Deploy progress, Progress style, or Diff preview before save', () => {
        render(<AppearanceSection />);
        expect(screen.queryByText('Deploy progress')).not.toBeInTheDocument();
        expect(screen.queryByText('Progress style')).not.toBeInTheDocument();
        expect(screen.queryByText('Diff preview before save')).not.toBeInTheDocument();
    });
});
