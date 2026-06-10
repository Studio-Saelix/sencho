import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { RecoveryChip } from '../RecoveryChip';
import type { StackActionResult } from '../EditorView';

vi.mock('@/lib/clipboard', () => ({ copyToClipboard: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/components/ui/toast-store', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const baseResult: StackActionResult = {
  action: 'update',
  rolledBack: false,
  errorMessage: 'pull failed: connection reset',
  startedAt: 1000,
  endedAt: 4000,
};

function setup(over: Partial<Parameters<typeof RecoveryChip>[0]> = {}) {
  const props = {
    stackName: 'web',
    result: baseResult,
    activeNode: null,
    backupInfo: { exists: false, timestamp: null },
    canDeploy: true,
    onRetry: vi.fn(),
    onRestart: vi.fn(),
    onRollback: vi.fn(),
    onRefreshState: vi.fn(),
    onDismiss: vi.fn(),
    ...over,
  };
  render(<RecoveryChip {...props} />);
  return props;
}

describe('RecoveryChip', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renders a chip with the failed action and keeps actions hidden until opened', () => {
    setup();
    expect(screen.getByTestId('recovery-chip')).toBeInTheDocument();
    expect(screen.getByText(/Update failed/)).toBeInTheDocument();
    expect(screen.queryByText('Retry update')).not.toBeInTheDocument();
  });

  it('reveals the recovery actions when the chip is clicked', () => {
    const props = setup();
    fireEvent.click(screen.getByTestId('recovery-chip'));
    expect(screen.getByText('Retry update')).toBeInTheDocument();
    expect(screen.getByText('Refresh')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Retry update'));
    expect(props.onRetry).toHaveBeenCalledTimes(1);
  });

  it('dismisses from inside the popover', () => {
    const props = setup();
    fireEvent.click(screen.getByTestId('recovery-chip'));
    fireEvent.click(screen.getByText('Dismiss'));
    expect(props.onDismiss).toHaveBeenCalledTimes(1);
  });
});
