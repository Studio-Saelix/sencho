import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MobileStackDetail } from './MobileStackDetail';
import type { EditorViewProps } from './EditorView';

// The detail's heavy children stream logs, parse compose, and render container
// stats; stub them with markers so this test focuses on the segmented-control
// behavior (default segment + switching).
vi.mock('./editor-view-blocks', () => ({
    StackIdentityHeader: () => <div>identity-header</div>,
    ContainersHealth: () => <div>health-pane</div>,
    StackLogsSection: () => <div>logs-pane</div>,
}));
vi.mock('../StackAnatomyPanel', () => ({ default: () => <div>compose-pane</div> }));
vi.mock('../ErrorBoundary', () => ({ default: ({ children }: { children: ReactNode }) => <>{children}</> }));
// The inline operation banner pulls in the deploy-feedback context; this suite
// covers the segmented-control behavior, so stub it (it renders nothing in the
// default Modal style anyway).
vi.mock('./StackOperationBanner', () => ({ StackOperationBanner: () => null }));

function makeProps(over: Partial<EditorViewProps> = {}): EditorViewProps {
    return {
        stackName: 'web',
        activeNode: null,
        containers: [],
        containerStats: {},
        containerStatsError: null,
        content: '',
        envContent: '',
        selectedEnvFile: '',
        gitSourcePendingMap: {},
        notifications: [],
        copiedDigest: null,
        loadingAction: null,
        stackMisconfigScanning: false,
        can: () => true,
        isAdmin: false,
        trivy: { available: false },
        backupInfo: { exists: false, timestamp: null },
        logsMode: 'structured',
        copiedDigestTimerRef: { current: null },
        deployStack: vi.fn(),
        restartStack: vi.fn(),
        stopStack: vi.fn(),
        updateStack: vi.fn(),
        rollbackStack: vi.fn(),
        scanStackConfig: vi.fn(),
        openLogViewer: vi.fn(),
        openBashModal: vi.fn(),
        serviceAction: vi.fn(),
        setLogsMode: vi.fn(),
        setGitSourceOpen: vi.fn(),
        setCopiedDigest: vi.fn(),
        requestDeleteStack: vi.fn(),
        onMobileBack: vi.fn(),
        ...over,
    } as unknown as EditorViewProps;
}

describe('MobileStackDetail', () => {
    it('defaults to the Logs segment', () => {
        render(<MobileStackDetail {...makeProps()} />);
        expect(screen.getByText('logs-pane')).toBeInTheDocument();
        expect(screen.queryByText('health-pane')).not.toBeInTheDocument();
        expect(screen.queryByText('compose-pane')).not.toBeInTheDocument();
        expect(screen.getByText('identity-header')).toBeInTheDocument();
    });

    it('switches to Health and Compose segments', () => {
        render(<MobileStackDetail {...makeProps()} />);
        fireEvent.click(screen.getByRole('tab', { name: 'Health' }));
        expect(screen.getByText('health-pane')).toBeInTheDocument();
        expect(screen.queryByText('logs-pane')).not.toBeInTheDocument();

        fireEvent.click(screen.getByRole('tab', { name: 'Compose' }));
        expect(screen.getByText('compose-pane')).toBeInTheDocument();
    });

    it('marks the active segment with aria-selected and round-trips back to Logs', () => {
        render(<MobileStackDetail {...makeProps()} />);
        expect(screen.getByRole('tab', { name: 'Logs' })).toHaveAttribute('aria-selected', 'true');
        fireEvent.click(screen.getByRole('tab', { name: 'Health' }));
        expect(screen.getByRole('tab', { name: 'Health' })).toHaveAttribute('aria-selected', 'true');
        expect(screen.getByRole('tab', { name: 'Logs' })).toHaveAttribute('aria-selected', 'false');
        fireEvent.click(screen.getByRole('tab', { name: 'Logs' }));
        expect(screen.getByRole('tab', { name: 'Logs' })).toHaveAttribute('aria-selected', 'true');
        expect(screen.getByText('logs-pane')).toBeInTheDocument();
    });

    it('invokes the back handler', () => {
        const onMobileBack = vi.fn();
        render(<MobileStackDetail {...makeProps({ onMobileBack })} />);
        fireEvent.click(screen.getByRole('button', { name: 'Back to stacks' }));
        expect(onMobileBack).toHaveBeenCalledTimes(1);
    });

    it('shows the edit-on-desktop nudge in Compose when the user can edit', () => {
        render(<MobileStackDetail {...makeProps({ can: () => true })} />);
        fireEvent.click(screen.getByRole('tab', { name: 'Compose' }));
        expect(screen.getByText(/Editing compose is available on a larger screen/i)).toBeInTheDocument();
    });

    it('hides the nudge when the user cannot edit', () => {
        render(<MobileStackDetail {...makeProps({ can: () => false })} />);
        fireEvent.click(screen.getByRole('tab', { name: 'Compose' }));
        expect(screen.queryByText(/Editing compose is available/i)).not.toBeInTheDocument();
    });
});
