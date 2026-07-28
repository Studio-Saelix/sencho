import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { ReactNode } from 'react';
import { EditorView } from '../EditorView';
import type { EditorViewProps } from '../EditorView';

// Capture Monaco language/value/readOnly props.
let lastLanguage: string | undefined;
let lastValue: string | undefined;
let lastReadOnly: boolean | undefined;
vi.mock('@/lib/monacoLoader', () => ({
  Editor: ({ language, value, options }: { language?: string; value?: string; options?: { readOnly?: boolean } }) => {
    lastLanguage = language;
    lastValue = value;
    lastReadOnly = options?.readOnly;
    return <div data-testid="monaco-editor" />;
  },
}));

// Capture StackLogsSection props for showServiceChips wiring tests.
let lastShowServiceChips: boolean | undefined;
vi.mock('../editor-view-blocks', () => ({
  StackIdentityHeader: () => <div>identity-header</div>,
  ContainersHealth: () => <div>health-pane</div>,
  StackLogsSection: ({ showServiceChips }: { showServiceChips: boolean }) => {
    lastShowServiceChips = showServiceChips;
    return <div>logs-pane</div>;
  },
}));
vi.mock('../../StackAnatomyPanel', () => ({
  default: () => <div>anatomy-pane</div>,
}));
vi.mock('../StackOperationBanner', () => ({ StackOperationBanner: () => null }));
vi.mock('../../ErrorBoundary', () => ({ default: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock('@/hooks/use-is-mobile', () => ({ useIsMobile: () => false }));
vi.mock('../../files/StackFileExplorer', () => ({
  StackFileExplorer: () => <div data-testid="file-explorer" />,
}));

function makeProps(over: Partial<EditorViewProps> = {}): EditorViewProps {
  return {
    stackName: 'web',
    isDarkMode: false,
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
    backupInfo: { exists: false, timestamp: null },
    gitSourcePendingMap: {},
    notifications: [],
    loadingAction: null,
    stackMisconfigScanning: false,
    activeTab: 'compose',
    isEditing: false,
    editingCompose: false,
    logsMode: 'structured',
    can: () => true,
    isAdmin: false,
    trivy: { available: false },
    deployStack: vi.fn(),
    restartStack: vi.fn(),
    stopStack: vi.fn(),
    updateStack: vi.fn(),
    rollbackStack: vi.fn(),
    scanStackConfig: vi.fn(),
    openComposeEditor: vi.fn(),
    closeComposeEditor: vi.fn(),
    requestSave: vi.fn(),
    requestSaveAndDeploy: vi.fn(),
    discardChanges: vi.fn(),
    setContent: vi.fn(),
    setEnvContent: vi.fn(),
    changeEnvFile: vi.fn(),
    openLogViewer: vi.fn(),
    openBashModal: vi.fn(),
    serviceAction: vi.fn(),
    setActiveTab: vi.fn(),
    setLogsMode: vi.fn(),
    setEditingCompose: vi.fn(),
    setGitSourceOpen: vi.fn(),
    requestDeleteStack: vi.fn(),
    requestTakeDownStack: vi.fn(),
    showTakeDown: false,
    onRefreshState: vi.fn(),
    onDismissRecovery: vi.fn(),
    panelStartedAt: null,
    onMobileBack: vi.fn(),
    onCloseEditor: vi.fn(),
    hasUnsavedChanges: () => false,
    ...over,
  };
}

describe('EditorView Monaco language prop', () => {
  afterEach(() => {
    lastLanguage = undefined;
    lastValue = undefined;
    lastReadOnly = undefined;
    lastShowServiceChips = undefined;
  });

  it('passes language="ini" when the env tab is active', () => {
    render(
      <EditorView
        {...makeProps({
          editingCompose: true,
          activeTab: 'env',
          envExists: true,
          envContent: 'KEY=val\n# a comment',
        })}
      />,
    );
    expect(lastLanguage).toBe('ini');
    expect(lastValue).toBe('KEY=val\n# a comment');
  });

  it('passes language="yaml" when the compose tab is active', () => {
    render(
      <EditorView
        {...makeProps({
          editingCompose: true,
          activeTab: 'compose',
          content: 'services:\n  web:\n    image: nginx',
        })}
      />,
    );
    expect(lastLanguage).toBe('yaml');
    expect(lastValue).toBe('services:\n  web:\n    image: nginx');
  });

  it('does not mount Monaco when the files tab is active', () => {
    render(
      <EditorView
        {...makeProps({
          editingCompose: true,
          activeTab: 'files',
        })}
      />,
    );
    // StackFileExplorer replaces Monaco in the files tab path.
    expect(lastLanguage).toBeUndefined();
    expect(lastValue).toBeUndefined();
  });
});

describe('EditorView single edit gate', () => {
  afterEach(() => {
    lastLanguage = undefined;
    lastValue = undefined;
    lastReadOnly = undefined;
    lastShowServiceChips = undefined;
  });

  it('shows Save & Deploy immediately without an Edit button when compose editor is open', () => {
    render(<EditorView {...makeProps({ editingCompose: true, activeTab: 'compose' })} />);
    expect(screen.getByRole('button', { name: 'Save & Deploy' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Edit$/ })).not.toBeInTheDocument();
    expect(lastReadOnly).toBe(false);
  });

  it('shows Save & Reapply when the self-stack is eligible for compose reapply', () => {
    render(<EditorView {...makeProps({
      editingCompose: true,
      activeTab: 'compose',
      isSelfStack: true,
      canSaveAndReapply: true,
    })} />);
    expect(screen.getByRole('button', { name: 'Save & Reapply' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save & Deploy' })).not.toBeInTheDocument();
  });

  it('disables the env file selector when hasUnsavedChanges is true', () => {
    render(
      <EditorView
        {...makeProps({
          editingCompose: true,
          activeTab: 'env',
          envExists: true,
          envFiles: ['.env', '.env.prod'],
          selectedEnvFile: '.env',
          hasUnsavedChanges: () => true,
        })}
      />,
    );
    // Radix Select trigger is a button; disabled when dirty.
    const trigger = screen.getByRole('combobox');
    expect(trigger).toBeDisabled();
  });

  it('routes Close through closeComposeEditor', () => {
    const closeComposeEditor = vi.fn();
    render(
      <EditorView
        {...makeProps({
          editingCompose: true,
          activeTab: 'compose',
          closeComposeEditor,
        })}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Close editor' }));
    expect(closeComposeEditor).toHaveBeenCalledTimes(1);
  });
});

function containerStub(id: string, name: string): EditorViewProps['containers'][number] {
  return {
    Id: id,
    Names: [name],
    State: 'running',
    Status: 'Up 1 minute',
  };
}

function serviceStub(name: string) {
  return {
    name,
    declaredImage: `${name}:latest`,
    hasBuild: false,
    expectedReplicas: 1,
    dependsOn: [] as string[],
    hasHealthcheck: false,
  };
}

describe('EditorView showServiceChips wiring', () => {
  afterEach(() => {
    lastShowServiceChips = undefined;
  });

  it('passes false for one container and one declared service', () => {
    render(
      <EditorView
        {...makeProps({
          containers: [containerStub('c1', '/web')],
          effectiveServices: [serviceStub('web')],
        })}
      />,
    );
    expect(lastShowServiceChips).toBe(false);
  });

  it('passes true for two containers', () => {
    render(
      <EditorView
        {...makeProps({
          containers: [containerStub('c1', '/web'), containerStub('c2', '/db')],
          effectiveServices: [serviceStub('web')],
        })}
      />,
    );
    expect(lastShowServiceChips).toBe(true);
  });

  it('passes true for one container and two declared services', () => {
    render(
      <EditorView
        {...makeProps({
          containers: [containerStub('c1', '/web')],
          effectiveServices: [serviceStub('web'), serviceStub('db')],
        })}
      />,
    );
    expect(lastShowServiceChips).toBe(true);
  });
});
