/**
 * Guards the move of the stack-workflow controls out of Appearance into Stacks,
 * and the addition of the Deploy Guardrails node-scoped backend settings.
 *
 * The three Workflow controls (Deploy progress, Progress style, Diff preview before
 * save) are browser-local localStorage preferences. The three Deploy Guardrails
 * controls (Observe health after updates, Observation window, Block deploy on
 * missing required env vars) are node-scoped backend settings fetched and saved
 * via /api/settings.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { StacksSection } from '../StacksSection';
import { AppearanceSection } from '../AppearanceSection';
import { DEPLOY_FEEDBACK_KEY } from '@/hooks/use-deploy-feedback-enabled';
import { DEPLOY_FEEDBACK_STYLE_KEY } from '@/hooks/use-deploy-feedback-style';
import { COMPOSE_DIFF_PREVIEW_KEY } from '@/hooks/use-compose-diff-preview-enabled';

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }));
vi.mock('@/components/ui/toast-store', () => ({
    toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn(), loading: vi.fn(), dismiss: vi.fn() },
}));
const useAuthMock = vi.fn(() => ({ isAdmin: true }));
vi.mock('@/context/AuthContext', () => ({ useAuth: () => useAuthMock() }));
vi.mock('@/context/NodeContext', () => ({ useNodes: () => ({ activeNode: { id: 'local' } }) }));
vi.mock('@/context/LicenseContext', () => ({ useLicense: vi.fn(() => ({ isPaid: true })) }));
vi.mock('../MastheadStatsContext', () => ({ useMastheadStats: () => {} }));

import { apiFetch } from '@/lib/api';

const mockedFetch = apiFetch as unknown as ReturnType<typeof vi.fn>;

const FULL_SETTINGS: Record<string, string> = {
    health_gate_enabled: '1',
    health_gate_window_seconds: '90',
    env_block_deploy_on_missing_required: '0',
};

beforeEach(() => {
    window.localStorage.clear();
    mockedFetch.mockReset();
    mockedFetch.mockResolvedValue({ ok: true, json: async () => ({ ...FULL_SETTINGS }) });
    useAuthMock.mockReturnValue({ isAdmin: true });
});

afterEach(() => {
    window.localStorage.clear();
});

describe('StacksSection', () => {
    it('renders the three workflow controls (Progress style while deploy progress is on)', async () => {
        render(<StacksSection />);
        expect(screen.getByText('Deploy progress')).toBeInTheDocument();
        // Deploy progress defaults on, so Progress style is visible.
        expect(screen.getByText('Progress style')).toBeInTheDocument();
        expect(screen.getByText('Diff preview before save')).toBeInTheDocument();
        // Wait for guardrails to load so the test doesn't leave a hanging update.
        await waitFor(() => expect(screen.getByText('Deploy Guardrails')).toBeInTheDocument());
    });

    it('flips the deploy-progress key and hides Progress style when disabled', async () => {
        const { container } = render(<StacksSection />);
        await waitFor(() => expect(screen.getByText('Deploy Guardrails')).toBeInTheDocument());
        const toggle = container.querySelector('#deploy-feedback') as HTMLElement;
        // Default on => no stored value yet.
        expect(window.localStorage.getItem(DEPLOY_FEEDBACK_KEY)).toBeNull();
        fireEvent.click(toggle);
        expect(window.localStorage.getItem(DEPLOY_FEEDBACK_KEY)).toBe('false');
        // Progress style is gated on the enabled state and drops out.
        expect(screen.queryByText('Progress style')).not.toBeInTheDocument();
    });

    it('round-trips the progress-style key between Inline and Modal', async () => {
        render(<StacksSection />);
        await waitFor(() => expect(screen.getByText('Deploy Guardrails')).toBeInTheDocument());
        fireEvent.click(screen.getByRole('radio', { name: 'Inline' }));
        expect(window.localStorage.getItem(DEPLOY_FEEDBACK_STYLE_KEY)).toBe('inline');
        fireEvent.click(screen.getByRole('radio', { name: 'Modal' }));
        expect(window.localStorage.getItem(DEPLOY_FEEDBACK_STYLE_KEY)).toBe('modal');
    });

    it('hydrates each control from its stored value (read path survives the move)', async () => {
        window.localStorage.setItem(DEPLOY_FEEDBACK_KEY, 'false');
        window.localStorage.setItem(COMPOSE_DIFF_PREVIEW_KEY, 'true');
        const { container } = render(<StacksSection />);
        await waitFor(() => expect(screen.getByText('Deploy Guardrails')).toBeInTheDocument());
        // Deploy progress reads its stored 'false': checkbox unchecked, Progress style hidden.
        expect(container.querySelector('#deploy-feedback')?.getAttribute('aria-checked')).toBe('false');
        expect(screen.queryByText('Progress style')).not.toBeInTheDocument();
        // Diff preview reads its stored 'true': checkbox checked.
        expect(container.querySelector('#compose-diff-preview')?.getAttribute('aria-checked')).toBe('true');
    });

    it('flips the diff-preview key when enabled', async () => {
        const { container } = render(<StacksSection />);
        await waitFor(() => expect(screen.getByText('Deploy Guardrails')).toBeInTheDocument());
        const toggle = container.querySelector('#compose-diff-preview') as HTMLElement;
        expect(window.localStorage.getItem(COMPOSE_DIFF_PREVIEW_KEY)).toBeNull();
        fireEvent.click(toggle);
        expect(window.localStorage.getItem(COMPOSE_DIFF_PREVIEW_KEY)).toBe('true');
    });

    it('renders the Deploy Guardrails subsection with three controls', async () => {
        render(<StacksSection />);
        await waitFor(() => expect(screen.getByText('Deploy Guardrails')).toBeInTheDocument());
        expect(screen.getByText('Observe health after updates')).toBeInTheDocument();
        expect(screen.getByText('Observation window')).toBeInTheDocument();
        expect(screen.getByText('Block deploy on missing required env vars')).toBeInTheDocument();
        expect(screen.getByText('Save settings')).toBeInTheDocument();
    });

    it('disables guardrails for non-admin while Workflow controls remain enabled', async () => {
        useAuthMock.mockReturnValue({ isAdmin: false });
        render(<StacksSection />);
        await waitFor(() => expect(screen.getByText('Deploy Guardrails')).toBeInTheDocument());

        // The guardrail subsection is wrapped in a disabled fieldset; the workflow
        // controls are not. At least one disabled fieldset should exist.
        const disabledFieldsets = document.querySelectorAll('fieldset[disabled]');
        expect(disabledFieldsets.length).toBeGreaterThan(0);

        // Workflow controls: the deploy-progress checkbox should still be clickable
        // (its fieldset is NOT disabled).
        const deployCheckbox = document.querySelector('#deploy-feedback') as HTMLElement;
        expect(deployCheckbox).not.toBeNull();
        fireEvent.click(deployCheckbox);
        expect(window.localStorage.getItem(DEPLOY_FEEDBACK_KEY)).toBe('false');
    });

    it('shows the workflow browser-local footer and the deploy guardrails node kicker', async () => {
        render(<StacksSection />);
        await waitFor(() => expect(screen.getByText('Deploy Guardrails')).toBeInTheDocument());
        // Workflow: browser-local
        expect(screen.getByText(/saved to this browser only/)).toBeInTheDocument();
        // The SettingsSection headers carry the kicker text.
        expect(screen.getByText('this browser')).toBeInTheDocument();
        expect(screen.getByText('this node')).toBeInTheDocument();
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
