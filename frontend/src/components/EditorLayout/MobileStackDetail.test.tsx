import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { useState, type ReactNode } from 'react';
import { MobileStackDetail } from './MobileStackDetail';
import type { EditorViewProps } from './EditorView';

// The detail's heavy children stream logs, parse compose, and render container
// stats; stub them with markers so this test focuses on segment behavior and the
// mobile editing flow.
vi.mock('./editor-view-blocks', () => ({
    StackIdentityHeader: () => <div>identity-header</div>,
    ContainersHealth: () => <div>health-pane</div>,
    StackLogsSection: () => <div>logs-pane</div>,
}));
// Prop-aware so the edit affordance (canEdit + onEditCompose) is exercised, not
// just the read-only marker.
vi.mock('../StackAnatomyPanel', () => ({
    default: ({ canEdit, onEditCompose }: { canEdit: boolean; onEditCompose: () => void }) => (
        <div>
            compose-pane
            {canEdit && (
                <button type="button" onClick={onEditCompose}>
                    edit-compose
                </button>
            )}
        </div>
    ),
}));
vi.mock('../ErrorBoundary', () => ({ default: ({ children }: { children: ReactNode }) => <>{children}</> }));
// The inline operation banner pulls in the deploy-feedback context; this suite
// covers segment + editor behavior, so stub it (it renders nothing in the
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
        envExists: false,
        envFiles: [],
        selectedEnvFile: '',
        isFileLoading: false,
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
        activeTab: 'compose',
        editingCompose: false,
        copiedDigestTimerRef: { current: null },
        deployStack: vi.fn(),
        restartStack: vi.fn(),
        stopStack: vi.fn(),
        updateStack: vi.fn(),
        rollbackStack: vi.fn(),
        scanStackConfig: vi.fn(),
        requestSave: vi.fn(),
        requestSaveAndDeploy: vi.fn(),
        setContent: vi.fn(),
        setEnvContent: vi.fn(),
        changeEnvFile: vi.fn(),
        openLogViewer: vi.fn(),
        openBashModal: vi.fn(),
        serviceAction: vi.fn(),
        setLogsMode: vi.fn(),
        setActiveTab: vi.fn(),
        setEditingCompose: vi.fn(),
        setGitSourceOpen: vi.fn(),
        setCopiedDigest: vi.fn(),
        requestDeleteStack: vi.fn(),
        onMobileBack: vi.fn(),
        onCloseEditor: vi.fn(),
        hasUnsavedChanges: () => false,
        ...over,
    } as unknown as EditorViewProps;
}

// Controlled wrapper so clicking the edit affordance and the compose/.env toggle
// actually flips the editingCompose / activeTab state the parent owns.
function ControlledDetail({ over = {} }: { over?: Partial<EditorViewProps> }) {
    const [editingCompose, setEditingCompose] = useState(Boolean(over.editingCompose));
    const [activeTab, setActiveTab] = useState<'compose' | 'env' | 'files'>(over.activeTab ?? 'compose');
    return (
        <MobileStackDetail
            {...makeProps({
                ...over,
                editingCompose,
                setEditingCompose,
                activeTab,
                setActiveTab,
            })}
        />
    );
}

describe('MobileStackDetail segments', () => {
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
});

describe('MobileStackDetail mobile editing', () => {
    it('exposes the edit affordance in Compose only when the user can edit', () => {
        const { rerender } = render(<MobileStackDetail {...makeProps({ can: () => true })} />);
        fireEvent.click(screen.getByRole('tab', { name: 'Compose' }));
        expect(screen.getByRole('button', { name: 'edit-compose' })).toBeInTheDocument();

        rerender(<MobileStackDetail {...makeProps({ can: () => false })} />);
        fireEvent.click(screen.getByRole('tab', { name: 'Compose' }));
        expect(screen.queryByRole('button', { name: 'edit-compose' })).not.toBeInTheDocument();
    });

    it('opens the full-screen editor from the Compose edit affordance', () => {
        render(<ControlledDetail />);
        fireEvent.click(screen.getByRole('tab', { name: 'Compose' }));
        fireEvent.click(screen.getByRole('button', { name: 'edit-compose' }));
        expect(screen.getByTestId('mobile-compose-editor')).toBeInTheDocument();
        // The full-screen editor replaces the segmented detail.
        expect(screen.queryByText('logs-pane')).not.toBeInTheDocument();
    });

    it('falls back to the read-only detail when editingCompose is set but the user cannot edit', () => {
        render(<MobileStackDetail {...makeProps({ editingCompose: true, can: () => false })} />);
        expect(screen.queryByTestId('mobile-compose-editor')).not.toBeInTheDocument();
        expect(screen.getByText('logs-pane')).toBeInTheDocument();
    });

    it('shows the compose buffer and routes edits to the right setter per tab', () => {
        const setContent = vi.fn();
        const setEnvContent = vi.fn();
        render(
            <ControlledDetail
                over={{
                    editingCompose: true,
                    content: 'compose-body',
                    envContent: 'env-body',
                    envExists: true,
                    envFiles: ['.env'],
                    selectedEnvFile: '.env',
                    setContent,
                    setEnvContent,
                }}
            />,
        );
        const textarea = screen.getByTestId('mobile-compose-editor') as HTMLTextAreaElement;
        expect(textarea.value).toBe('compose-body');
        fireEvent.change(textarea, { target: { value: 'compose-edited' } });
        expect(setContent).toHaveBeenCalledWith('compose-edited');

        fireEvent.click(screen.getByRole('tab', { name: '.env' }));
        const envArea = screen.getByTestId('mobile-compose-editor') as HTMLTextAreaElement;
        expect(envArea.value).toBe('env-body');
        fireEvent.change(envArea, { target: { value: 'env-edited' } });
        expect(setEnvContent).toHaveBeenCalledWith('env-edited');
    });

    it('disables the env-file selector while there are unsaved changes', () => {
        render(
            <ControlledDetail
                over={{
                    editingCompose: true,
                    activeTab: 'env',
                    envExists: true,
                    envFiles: ['.env', '.env.prod'],
                    selectedEnvFile: '.env',
                    hasUnsavedChanges: () => true,
                }}
            />,
        );
        expect(screen.getByRole('combobox')).toBeDisabled();
    });

    it('disables save actions while a deploy is running', () => {
        render(<MobileStackDetail {...makeProps({ editingCompose: true, loadingAction: 'deploy' })} />);
        expect(screen.getByTestId('mobile-editor-save')).toBeDisabled();
        expect(screen.getByTestId('mobile-editor-save-deploy')).toBeDisabled();
    });

    it('routes Cancel through the close handler even after a save and a fresh edit', () => {
        const requestSave = vi.fn();
        const onCloseEditor = vi.fn();
        render(
            <ControlledDetail
                over={{
                    editingCompose: true,
                    content: 'compose-body',
                    requestSave,
                    onCloseEditor,
                }}
            />,
        );
        const textarea = screen.getByTestId('mobile-compose-editor');
        fireEvent.change(textarea, { target: { value: 'first-edit' } });
        fireEvent.click(screen.getByTestId('mobile-editor-save'));
        expect(requestSave).toHaveBeenCalledTimes(1);

        // Save clears isEditing on the real hook; Cancel must not depend on it.
        fireEvent.change(textarea, { target: { value: 'second-edit' } });
        fireEvent.click(screen.getByTestId('mobile-editor-close'));
        expect(onCloseEditor).toHaveBeenCalledTimes(1);
    });

    it('triggers save-and-deploy from the deploy action', () => {
        const requestSaveAndDeploy = vi.fn();
        render(<MobileStackDetail {...makeProps({ editingCompose: true, requestSaveAndDeploy })} />);
        fireEvent.click(screen.getByTestId('mobile-editor-save-deploy'));
        expect(requestSaveAndDeploy).toHaveBeenCalledTimes(1);
    });
});
