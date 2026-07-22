import type React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { StackList } from '../StackList';
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
