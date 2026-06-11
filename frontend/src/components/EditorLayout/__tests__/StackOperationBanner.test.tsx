import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { StackOperationBanner } from '../StackOperationBanner';
import type { DeployPanelState, HealthGateUiState } from '@/context/DeployFeedbackContext';
import type { ParsedLogRow, LogStage } from '@/components/log-rendering/composeLogParser';
import type { Node } from '@/context/NodeContext';

const setMinimized = vi.fn();
const onPanelClose = vi.fn();
let mockPanelState: DeployPanelState;
let mockHealthGate: HealthGateUiState | null;
let mockLogRows: ParsedLogRow[];
let mockStyle: 'modal' | 'inline';
let mockMinimized: boolean;

vi.mock('@/context/DeployFeedbackContext', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/context/DeployFeedbackContext')>();
    return {
        ...actual,
        useDeployFeedback: () => ({
            panelState: mockPanelState,
            healthGate: mockHealthGate,
            logRows: mockLogRows,
            setMinimized,
            onPanelClose,
            // Unused by the banner but part of the context shape.
            runWithLog: vi.fn(),
            minimized: mockMinimized,
            lastOutputAt: 0,
            onTerminalReady: vi.fn(),
            onTerminalError: vi.fn(),
            onMessage: vi.fn(),
        }),
    };
});

vi.mock('@/hooks/use-deploy-feedback-style', () => ({
    useDeployFeedbackStyle: () => [mockStyle, vi.fn()],
}));

function panel(over: Partial<DeployPanelState> = {}): DeployPanelState {
    return {
        isOpen: true,
        stackName: 'web',
        nodeId: null,
        action: 'update',
        status: 'streaming',
        progressUnavailable: false,
        deploySessionId: '',
        sessionId: 1,
        ...over,
    };
}

const row = (message: string, stage: LogStage = 'LOG'): ParsedLogRow => ({
    id: `r-${message}`, timestamp: '', stage, level: 'info', message, raw: message,
});

const node = (id: number) => ({ id } as Node);

beforeEach(() => {
    setMinimized.mockClear();
    onPanelClose.mockClear();
    mockStyle = 'inline';
    mockMinimized = true; // inline sessions default to the banner (modal hidden)
    mockPanelState = panel();
    mockHealthGate = null;
    mockLogRows = [];
});

const passedGate = (): HealthGateUiState => ({
    stackName: 'web', gateId: 'g', trigger: 'update', status: 'passed', reason: null, windowSeconds: 90, startedAt: Date.now() - 90_000,
});

function renderBanner(activeNode: Node | null = null, panelStartedAt: number | null = Date.now() - 12_000) {
    return render(
        <StackOperationBanner stackName="web" activeNode={activeNode} panelStartedAt={panelStartedAt} variant="band" />,
    );
}

describe('StackOperationBanner', () => {
    it('renders for the matching stack and node in inline style while in flight', () => {
        renderBanner();
        expect(screen.getByTestId('stack-operation-banner')).toBeInTheDocument();
        expect(screen.getByText('Updating')).toBeInTheDocument();
    });

    it('renders nothing in modal style', () => {
        mockStyle = 'modal';
        renderBanner();
        expect(screen.queryByTestId('stack-operation-banner')).toBeNull();
    });

    it('renders nothing for a different stack or a node mismatch', () => {
        mockPanelState = panel({ stackName: 'api' });
        const { unmount } = renderBanner();
        expect(screen.queryByTestId('stack-operation-banner')).toBeNull();
        unmount();

        mockPanelState = panel({ nodeId: 2 });
        renderBanner(node(5));
        expect(screen.queryByTestId('stack-operation-banner')).toBeNull();
    });

    it('renders when the panel node matches the active node', () => {
        mockPanelState = panel({ nodeId: 5 });
        renderBanner(node(5));
        expect(screen.getByTestId('stack-operation-banner')).toBeInTheDocument();
    });

    it('renders nothing when the operation or the gate failed (recovery takes over)', () => {
        mockPanelState = panel({ status: 'failed' });
        const { unmount } = renderBanner();
        expect(screen.queryByTestId('stack-operation-banner')).toBeNull();
        unmount();

        mockPanelState = panel({ status: 'succeeded' });
        mockHealthGate = { stackName: 'web', gateId: 'g', trigger: 'update', status: 'failed', reason: 'exited', windowSeconds: 90, startedAt: Date.now() };
        renderBanner();
        expect(screen.queryByTestId('stack-operation-banner')).toBeNull();
    });

    it('shows the live phase and latest output line while streaming', () => {
        mockLogRows = [row('=== Pulling latest images ==='), row('web-1 Pulling fs layer 41%', 'PULL')];
        renderBanner();
        expect(screen.getByText('Pulling images')).toBeInTheDocument();
        expect(screen.getByText('web-1 Pulling fs layer 41%')).toBeInTheDocument();
    });

    it('shows past tense once succeeded with no pending gate', () => {
        mockPanelState = panel({ status: 'succeeded' });
        renderBanner();
        expect(screen.getByText('Updated')).toBeInTheDocument();
    });

    it('shows the observing health gate and keeps present tense', () => {
        mockPanelState = panel({ status: 'succeeded' });
        mockHealthGate = { stackName: 'web', gateId: 'g', trigger: 'update', status: 'observing', reason: null, windowSeconds: 90, startedAt: Date.now() - 12_000 };
        renderBanner();
        expect(screen.getByText('Updating')).toBeInTheDocument();
        expect(screen.getByText('Verifying health')).toBeInTheDocument();
        expect(screen.getByText(/\d+s of 90s/)).toBeInTheDocument();
    });

    it('shows the passed health gate', () => {
        mockPanelState = panel({ status: 'succeeded' });
        mockHealthGate = { stackName: 'web', gateId: 'g', trigger: 'update', status: 'passed', reason: null, windowSeconds: 90, startedAt: Date.now() - 90_000 };
        renderBanner();
        expect(screen.getByText('Health gate passed')).toBeInTheDocument();
        expect(screen.getByText('Updated')).toBeInTheDocument();
    });

    it('shows the unknown health gate state with its reason', () => {
        mockPanelState = panel({ status: 'succeeded' });
        mockHealthGate = { stackName: 'web', gateId: 'g', trigger: 'update', status: 'unknown', reason: 'no healthcheck defined', windowSeconds: 90, startedAt: Date.now() };
        renderBanner();
        expect(screen.getByText('Health check unknown')).toBeInTheDocument();
        expect(screen.getByText('no healthcheck defined')).toBeInTheDocument();
    });

    it('freezes the elapsed once the operation is done', () => {
        vi.useFakeTimers();
        try {
            mockMinimized = false; // modal-open path, so auto-dismiss does not interfere
            const start = Date.now() - 5000;
            mockPanelState = panel({ status: 'streaming' });
            const view = render(<StackOperationBanner stackName="web" activeNode={null} panelStartedAt={start} variant="band" />);
            act(() => { vi.advanceTimersByTime(3000); }); // ~8s elapsed, still streaming

            // Complete the operation (succeeded, no gate) → elapsed should freeze.
            mockPanelState = panel({ status: 'succeeded' });
            view.rerender(<StackOperationBanner stackName="web" activeNode={null} panelStartedAt={start} variant="band" />);
            const frozenText = screen.getByTestId('stack-operation-banner').textContent;
            expect(frozenText).toMatch(/8s/);

            // Advancing time and re-rendering must not move the elapsed readout.
            act(() => { vi.advanceTimersByTime(10000); });
            view.rerender(<StackOperationBanner stackName="web" activeNode={null} panelStartedAt={start} variant="band" />);
            expect(screen.getByTestId('stack-operation-banner').textContent).toBe(frozenText);
        } finally {
            vi.useRealTimers();
        }
    });

    it('shows the live-progress-unavailable fallback', () => {
        mockPanelState = panel({ status: 'streaming', progressUnavailable: true });
        renderBanner();
        expect(screen.getByText('Live progress unavailable')).toBeInTheDocument();
        expect(screen.getByText(/continues running in the background/i)).toBeInTheDocument();
    });

    it('View output un-minimizes the modal', () => {
        renderBanner();
        fireEvent.click(screen.getByRole('button', { name: /view output/i }));
        expect(setMinimized).toHaveBeenCalledWith(false);
    });

    it('Dismiss clears the session without opening the modal', () => {
        renderBanner();
        fireEvent.click(screen.getByRole('button', { name: /dismiss progress/i }));
        expect(onPanelClose).toHaveBeenCalledTimes(1);
        expect(setMinimized).not.toHaveBeenCalled();
    });

    it('renders the card variant on mobile', () => {
        render(<StackOperationBanner stackName="web" activeNode={null} panelStartedAt={Date.now()} variant="card" />);
        expect(screen.getByTestId('stack-operation-banner')).toBeInTheDocument();
    });

    it('reserves a spacer slot when idle in the band variant, but nothing in the card variant', () => {
        mockStyle = 'modal'; // inactive
        const band = render(<StackOperationBanner stackName="web" activeNode={null} panelStartedAt={null} variant="band" />);
        expect(screen.queryByTestId('stack-operation-banner')).toBeNull();
        expect(band.container.firstChild).not.toBeNull();
        band.unmount();

        const card = render(<StackOperationBanner stackName="web" activeNode={null} panelStartedAt={null} variant="card" />);
        expect(card.container.firstChild).toBeNull();
    });

    it('auto-dismisses a few seconds after a clean completion', () => {
        vi.useFakeTimers();
        try {
            mockPanelState = panel({ status: 'succeeded' });
            mockHealthGate = passedGate();
            renderBanner();
            expect(screen.getByText('Updated')).toBeInTheDocument();
            expect(onPanelClose).not.toHaveBeenCalled();
            act(() => { vi.advanceTimersByTime(4000); });
            expect(onPanelClose).toHaveBeenCalledTimes(1);
        } finally {
            vi.useRealTimers();
        }
    });

    it('does not auto-dismiss while the modal is open over the banner', () => {
        vi.useFakeTimers();
        try {
            mockMinimized = false; // modal open over the banner
            mockPanelState = panel({ status: 'succeeded' });
            mockHealthGate = passedGate();
            renderBanner();
            act(() => { vi.advanceTimersByTime(8000); });
            expect(onPanelClose).not.toHaveBeenCalled();
        } finally {
            vi.useRealTimers();
        }
    });

    it('does not auto-dismiss while the health gate is still observing', () => {
        vi.useFakeTimers();
        try {
            mockPanelState = panel({ status: 'succeeded' });
            mockHealthGate = { stackName: 'web', gateId: 'g', trigger: 'update', status: 'observing', reason: null, windowSeconds: 90, startedAt: Date.now() };
            renderBanner();
            act(() => { vi.advanceTimersByTime(8000); });
            expect(onPanelClose).not.toHaveBeenCalled();
        } finally {
            vi.useRealTimers();
        }
    });
});
