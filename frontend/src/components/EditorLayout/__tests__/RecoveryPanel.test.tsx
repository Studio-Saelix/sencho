import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { RecoveryPanel } from '../RecoveryPanel';
import type { StackActionResult } from '../EditorView';

vi.mock('@/lib/clipboard', () => ({ copyToClipboard: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/components/ui/toast-store', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { copyToClipboard } from '@/lib/clipboard';

const baseResult: StackActionResult = {
  action: 'update',
  rolledBack: false,
  errorMessage: 'pull failed: connection reset',
  startedAt: 1000,
  endedAt: 4000,
};

function setup(over: Partial<Parameters<typeof RecoveryPanel>[0]> = {}) {
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
  render(<RecoveryPanel {...props} />);
  return props;
}

describe('RecoveryPanel', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows the failed action title and error message', () => {
    setup();
    expect(screen.getByText(/Update failed/)).toBeInTheDocument();
    expect(screen.getByText(/pull failed: connection reset/)).toBeInTheDocument();
  });

  it('calls onRetry from the retry button', () => {
    const props = setup();
    fireEvent.click(screen.getByText('Retry update'));
    expect(props.onRetry).toHaveBeenCalledTimes(1);
  });

  it('hides retry/restart/rollback without the deploy permission', () => {
    setup({ canDeploy: false, backupInfo: { exists: true, timestamp: 1 } });
    expect(screen.queryByText('Retry update')).not.toBeInTheDocument();
    expect(screen.queryByText('Restart')).not.toBeInTheDocument();
    expect(screen.queryByText('Roll back')).not.toBeInTheDocument();
    // Read-level actions remain available.
    expect(screen.getByText('Refresh')).toBeInTheDocument();
    expect(screen.getByText('Copy details')).toBeInTheDocument();
  });

  it('offers rollback only when a backup exists', () => {
    setup({ backupInfo: { exists: false, timestamp: null } });
    expect(screen.queryByText('Roll back')).not.toBeInTheDocument();
    setup({ backupInfo: { exists: true, timestamp: 123 } });
    expect(screen.getByText('Roll back')).toBeInTheDocument();
  });

  it('does not show a redundant restart button when the failed action was a restart', () => {
    setup({ result: { ...baseResult, action: 'restart' } });
    expect(screen.getByText('Retry restart')).toBeInTheDocument();
    expect(screen.queryByText('Restart')).not.toBeInTheDocument();
  });

  it('copies session-safe diagnostics including stack and error', () => {
    setup({ result: { ...baseResult, lastOutputLine: 'pulling app ...' } });
    fireEvent.click(screen.getByText('Copy details'));
    expect(copyToClipboard).toHaveBeenCalledTimes(1);
    const blob = vi.mocked(copyToClipboard).mock.calls[0][0];
    expect(blob).toContain('Stack: web');
    expect(blob).toContain('pull failed: connection reset');
    expect(blob).toContain('Last output: pulling app ...');
  });

  it('renders the failure classification label and suggestion when present', () => {
    setup({
      result: {
        ...baseResult,
        failure: {
          reason: 'port_conflict',
          label: 'Host port conflict',
          suggestion: 'Free the conflicting host port, then retry.',
        },
      },
    });
    expect(screen.getByText('Host port conflict')).toBeInTheDocument();
    expect(screen.getByText('Free the conflicting host port, then retry.')).toBeInTheDocument();
  });

  it('renders no classification block without a failure field', () => {
    setup();
    expect(screen.queryByText('Host port conflict')).not.toBeInTheDocument();
  });

  it('includes the classification in copied diagnostics', () => {
    setup({
      result: {
        ...baseResult,
        failure: {
          reason: 'env_missing',
          label: 'Missing environment variable',
          suggestion: 'Define the missing variable, then retry.',
        },
      },
    });
    fireEvent.click(screen.getByText('Copy details'));
    const blob = vi.mocked(copyToClipboard).mock.calls[0][0];
    expect(blob).toContain('Classified: Missing environment variable');
    expect(blob).toContain('Suggestion: Define the missing variable, then retry.');
  });

  it('wires refresh and dismiss callbacks', () => {
    const props = setup();
    fireEvent.click(screen.getByText('Refresh'));
    fireEvent.click(screen.getByLabelText('Dismiss recovery panel'));
    expect(props.onRefreshState).toHaveBeenCalledTimes(1);
    expect(props.onDismiss).toHaveBeenCalledTimes(1);
  });
});
