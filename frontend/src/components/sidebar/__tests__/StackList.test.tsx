import type React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SOURCE_STATE } from '@/lib/gitopsState';
import { StackList } from '../StackList';
import { Command } from '@/components/ui/command';
import { isStacksListSettled, isStacksListLoading } from '../stacksLoadUi';

type StackListRenderProps = React.ComponentProps<typeof StackList>;

vi.mock('../DiscoveryEmptyState', () => ({
  DiscoveryEmptyState: () => <div data-testid="discovery-empty">No compose projects yet</div>,
}));

vi.mock('@/hooks/useStackKeyboardShortcuts', () => ({
  useStackKeyboardShortcuts: () => {},
}));

vi.mock('@/hooks/useMuteRuleActions', () => ({
  useLabelMuteActions: () => ({ canMute: false }),
}));

function baseProps(over: Partial<StackListRenderProps> = {}): StackListRenderProps {
  return {
    files: [],
    isLoading: false,
    selectedFile: null,
    searchQuery: '',
    stackLabelMap: {},
    stackStatuses: {},
    stackCounts: {},
    stackUpdates: {},
    gitSourcePendingMap: {},
    pinnedFiles: [],
    isCollapsed: () => false,
    toggleCollapse: () => {},
    isBusy: () => false,
    getDisplayName: (f) => f,
    onSelectFile: () => {},
    buildMenuCtx: () => ({}) as never,
    remoteResults: [],
    remoteLoading: false,
    remoteFailedNodes: [],
    onSelectRemoteFile: () => {},
    filterChip: 'all',
    stacksLoadStatus: 'idle',
    stacksLoadError: null,
    bulkMode: false,
    selectedFiles: new Set<string>(),
    onToggleSelect: () => {},
    ...over,
  };
}

describe('stacksLoadUi helpers', () => {
  it('treats success while isLoading as unsettled', () => {
    expect(isStacksListSettled(true, 'success')).toBe(false);
    expect(isStacksListLoading(true, 'success')).toBe(true);
  });

  it('settles only when not loading and status is success or error', () => {
    expect(isStacksListSettled(false, 'success')).toBe(true);
    expect(isStacksListSettled(false, 'error')).toBe(true);
    expect(isStacksListSettled(false, 'idle')).toBe(false);
    expect(isStacksListSettled(false, 'loading')).toBe(false);
  });
});

describe('StackList load gating', () => {
  it('does not mount discovery empty while idle', () => {
    render(<StackList {...baseProps({ stacksLoadStatus: 'idle', isLoading: false, files: [] })} />);
    expect(screen.queryByTestId('discovery-empty')).toBeNull();
  });

  it('does not mount discovery empty while loading even if status is already success', () => {
    render(
      <StackList
        {...baseProps({ stacksLoadStatus: 'success', isLoading: true, files: [] })}
      />,
    );
    expect(screen.queryByTestId('discovery-empty')).toBeNull();
  });

  it('mounts discovery empty only after successful empty load', () => {
    render(
      <StackList
        {...baseProps({ stacksLoadStatus: 'success', isLoading: false, files: [] })}
      />,
    );
    expect(screen.getByTestId('discovery-empty')).toBeInTheDocument();
  });

  it('shows retry on error with empty files', () => {
    render(
      <StackList
        {...baseProps({
          stacksLoadStatus: 'error',
          stacksLoadError: 'Could not load stacks for this node.',
          isLoading: false,
          files: [],
          onRetryStacksLoad: vi.fn(),
        })}
      />,
    );
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
    expect(screen.queryByTestId('discovery-empty')).toBeNull();
  });
});

describe('stacksLoadUi hydration sentinel', () => {
  it('settles a completed list error regardless of hydration state', () => {
    expect(isStacksListSettled(false, 'error', 'pending')).toBe(true);
  });

  it('does not settle a successful list while hydration is pending', () => {
    expect(isStacksListSettled(false, 'success', 'pending')).toBe(false);
  });

  it('settles a successful list once hydration is terminal', () => {
    expect(isStacksListSettled(false, 'success', 'ok')).toBe(true);
    expect(isStacksListSettled(false, 'success', 'error')).toBe(true);
  });
});

describe('StackList hydration display', () => {
    const minimalCtx = {
      stackStatus: 'running',
      ready: true,
      isSelfStack: false,
      canOpenApp: false,
      isBusy: false,
      isAdmin: false,
      canDelete: false,
      canDeploy: true,
      canEditLabels: false,
      canCreateLabels: false,
      isPinned: false,
      labels: [],
      assignedLabelIds: [],
      menuVisibility: { showDeploy: false, showStop: false, showRestart: false, showUpdate: false, showTakeDown: false },
      openAlertSheet: () => {},
      openAutoHeal: () => {},
      canViewMonitor: false,
      canCheckUpdates: false,
      checkUpdates: () => {},
      openStackApp: () => {},
      deploy: () => {},
      stop: () => {},
      restart: () => {},
      update: () => {},
      takeDown: () => {},
      remove: () => {},
      pin: () => {},
      unpin: () => {},
      toggleLabel: async () => {},
      openLabelManager: () => {},
      openScheduleTask: () => {},
      canMuteNotifications: false,
      muteStackAll: () => {},
      muteStackDeploySuccess: () => {},
      muteStackMonitor: () => {},
      openStackMuteRules: () => {},
    };

  it('renders rows with unknown indicators while hydration is pending', () => {
    render(
      <Command shouldFilter={false}>
        <StackList
          {...baseProps({
            stacksLoadStatus: 'success',
            isLoading: false,
            files: ['web.yml'],
            stackStatuses: { 'web.yml': 'running' },
            hydrationDisplay: 'pending',
            buildMenuCtx: () => minimalCtx as never,
          })}
        />
      </Command>,
    );
    const row = screen.getByTestId('stack-row');
    expect(row.textContent).toContain('--');
    expect(row.textContent).not.toContain('UP');
  });

  it('renders rows normally when hydration is current', () => {
    render(
      <Command shouldFilter={false}>
        <StackList
          {...baseProps({
            stacksLoadStatus: 'success',
            isLoading: false,
            files: ['web.yml'],
            stackStatuses: { 'web.yml': 'running' },
            hydrationDisplay: 'current',
            buildMenuCtx: () => minimalCtx as never,
          })}
        />
      </Command>,
    );
    const row = screen.getByTestId('stack-row');
    expect(row.textContent).toContain('UP');
  });

  it('passes a waiting Git state through to the row it belongs to', async () => {
    render(
      <Command shouldFilter={false}>
        <StackList
          {...baseProps({
            stacksLoadStatus: 'success',
            files: ['web.yml', 'api.yml'],
            stackStatuses: { 'web.yml': 'running', 'api.yml': 'running' },
            // Keyed by the API's stack_name, read here by the sidebar's file key.
            gitSourcePendingMap: { 'web.yml': 'source_conflict_blocker' },
            buildMenuCtx: () => minimalCtx as never,
          })}
        />
      </Command>,
    );
    const indicators = screen.getAllByTestId('stack-trailing-git-pending');
    expect(indicators).toHaveLength(1);
    // The state has to survive the trip, not just the fact that one is waiting.
    fireEvent.pointerMove(indicators[0]);
    expect(
      (await screen.findAllByText(SOURCE_STATE.source_conflict_blocker.line)).length,
    ).toBeGreaterThan(0);
  });
});
