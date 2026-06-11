import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DeployFeedbackPortal } from '../DeployFeedbackPortal';
import type { DeployPanelState } from '@/context/DeployFeedbackContext';

let mockPanelState: DeployPanelState;
let mockStyle: 'modal' | 'inline';

vi.mock('@/context/DeployFeedbackContext', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/context/DeployFeedbackContext')>();
    return {
        ...actual,
        useDeployFeedback: () => ({
            panelState: mockPanelState,
            minimized: true,
            setMinimized: vi.fn(),
            onTerminalReady: vi.fn(),
            onTerminalError: vi.fn(),
            onMessage: vi.fn(),
            healthGate: null,
            logRows: [],
            lastOutputAt: 0,
            runWithLog: vi.fn(),
            onPanelClose: vi.fn(),
        }),
    };
});
vi.mock('@/hooks/use-deploy-feedback-style', () => ({
    useDeployFeedbackStyle: () => [mockStyle, vi.fn()],
}));
vi.mock('../DeployFeedbackModal', () => ({ DeployFeedbackModal: () => <div data-testid="modal-marker" /> }));
vi.mock('../DeployFeedbackPill', () => ({
    DeployFeedbackPill: ({ isVisible }: { isVisible: boolean }) => (isVisible ? <div data-testid="pill-marker" /> : null),
}));
vi.mock('../Terminal', () => ({ default: () => <div data-testid="portal-terminal" /> }));

function panel(over: Partial<DeployPanelState> = {}): DeployPanelState {
    return {
        isOpen: false, stackName: '', nodeId: null, action: 'deploy', status: 'preparing',
        progressUnavailable: false, deploySessionId: '', sessionId: 0, ...over,
    };
}

beforeEach(() => {
    mockStyle = 'inline';
    mockPanelState = panel();
});

// Exactly one terminal owns the per-session socket: the portal mounts it in
// Inline style (the modal stays closed there), and the modal owns it in Modal
// style. This pins the portal's half of that invariant.
describe('DeployFeedbackPortal', () => {
    it('mounts the progress terminal in inline style while a session is open', () => {
        mockStyle = 'inline';
        mockPanelState = panel({ isOpen: true });
        render(<DeployFeedbackPortal />);
        expect(screen.getByTestId('portal-terminal')).toBeInTheDocument();
    });

    it('does not mount the portal terminal in modal style (the modal owns it)', () => {
        mockStyle = 'modal';
        mockPanelState = panel({ isOpen: true });
        render(<DeployFeedbackPortal />);
        expect(screen.queryByTestId('portal-terminal')).toBeNull();
    });

    it('does not mount the portal terminal when no session is open', () => {
        mockStyle = 'inline';
        mockPanelState = panel({ isOpen: false });
        render(<DeployFeedbackPortal />);
        expect(screen.queryByTestId('portal-terminal')).toBeNull();
    });

    it('shows the minimize pill only in modal style when open and minimized', () => {
        mockStyle = 'modal';
        mockPanelState = panel({ isOpen: true });
        render(<DeployFeedbackPortal />);
        expect(screen.getByTestId('pill-marker')).toBeInTheDocument();
    });

    it('hides the pill in inline style (the banner is the surface)', () => {
        mockStyle = 'inline';
        mockPanelState = panel({ isOpen: true });
        render(<DeployFeedbackPortal />);
        expect(screen.queryByTestId('pill-marker')).toBeNull();
    });
});
