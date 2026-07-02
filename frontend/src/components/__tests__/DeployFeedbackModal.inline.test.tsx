import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DeployFeedbackModal } from '../DeployFeedbackModal';
import type { DeployPanelState } from '@/context/DeployFeedbackContext';

const onPanelClose = vi.fn();
const onMinimize = vi.fn();
let mockStyle: 'modal' | 'inline';
let mockPanelState: DeployPanelState;

vi.mock('@/context/DeployFeedbackContext', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/context/DeployFeedbackContext')>();
    return {
        ...actual,
        useDeployFeedback: () => ({
            panelState: mockPanelState,
            healthGate: null,
            logRows: [],
            lastOutputAt: 0,
            onTerminalReady: vi.fn(),
            onTerminalError: vi.fn(),
            onMessage: vi.fn(),
            onPanelClose,
            runWithLog: vi.fn(),
            minimized: false,
            setMinimized: vi.fn(),
        }),
    };
});
vi.mock('@/hooks/use-deploy-feedback-style', () => ({
    useDeployFeedbackStyle: () => [mockStyle, vi.fn()],
}));
vi.mock('@/components/Terminal', () => ({ default: () => <div data-testid="modal-terminal" /> }));

function panel(over: Partial<DeployPanelState> = {}): DeployPanelState {
    return {
        isOpen: true, stackName: 'web', nodeId: null, action: 'update', status: 'streaming',
        progressUnavailable: false, deploySessionId: 'abc', sessionId: 1, ...over,
    };
}

beforeEach(() => {
    onPanelClose.mockClear();
    onMinimize.mockClear();
    mockStyle = 'inline';
    mockPanelState = panel();
});

function clickClose() {
    // Both the header icon and the footer button are named "Close" and route
    // through the same handler; either click exercises it.
    fireEvent.click(screen.getAllByRole('button', { name: 'Close' })[0]);
}

describe('DeployFeedbackModal Inline vs Modal style', () => {
    it('inline style: closing only hides the modal (keeps the session for the banner)', () => {
        mockStyle = 'inline';
        render(<DeployFeedbackModal isMinimized={false} onMinimize={onMinimize} />);
        clickClose();
        expect(onMinimize).toHaveBeenCalledTimes(1);
        expect(onPanelClose).not.toHaveBeenCalled();
    });

    it('inline style: closing a failed op ends the session (the banner has stepped aside)', () => {
        mockStyle = 'inline';
        mockPanelState = panel({ status: 'failed' });
        render(<DeployFeedbackModal isMinimized={false} onMinimize={onMinimize} />);
        clickClose();
        expect(onPanelClose).toHaveBeenCalledTimes(1);
        expect(onMinimize).not.toHaveBeenCalled();
    });

    it('modal style: closing ends the session', () => {
        mockStyle = 'modal';
        render(<DeployFeedbackModal isMinimized={false} onMinimize={onMinimize} />);
        clickClose();
        expect(onPanelClose).toHaveBeenCalledTimes(1);
        expect(onMinimize).not.toHaveBeenCalled();
    });

    it('inline style: succeeded state shows no auto-close countdown label', () => {
        mockStyle = 'inline';
        mockPanelState = panel({ status: 'succeeded' });
        render(<DeployFeedbackModal isMinimized={false} onMinimize={onMinimize} />);
        expect(screen.queryByText(/closes in/i)).toBeNull();
    });

    it('modal style: succeeded state shows auto-close countdown label', () => {
        mockStyle = 'modal';
        mockPanelState = panel({ status: 'succeeded' });
        render(<DeployFeedbackModal isMinimized={false} onMinimize={onMinimize} />);
        expect(screen.getByText(/closes in/i)).toBeInTheDocument();
    });

    it('modal style owns the live terminal; inline style renders no terminal (single socket)', () => {
        mockStyle = 'modal';
        const view = render(<DeployFeedbackModal isMinimized={false} onMinimize={onMinimize} />);
        expect(screen.getByTestId('modal-terminal')).toBeInTheDocument();
        view.unmount();

        mockStyle = 'inline';
        render(<DeployFeedbackModal isMinimized={false} onMinimize={onMinimize} />);
        expect(screen.queryByTestId('modal-terminal')).toBeNull();
    });
});
