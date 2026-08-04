import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('@/lib/stackFilesApi', () => {
  class MockNotEmptyError extends Error {
    readonly code = 'NOT_EMPTY' as const;
    constructor(message: string) {
      super(message);
      this.name = 'NotEmptyError';
    }
  }
  return {
    deleteStackPath: vi.fn(),
    NotEmptyError: MockNotEmptyError,
  };
});

vi.mock('@/components/ui/toast-store', () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
    loading: vi.fn(() => 'loading-id'),
    dismiss: vi.fn(),
  },
}));

import { DeleteFileConfirm } from '../DeleteFileConfirm';
import { deleteStackPath, NotEmptyError } from '@/lib/stackFilesApi';
import { toast } from '@/components/ui/toast-store';

const mockDelete = deleteStackPath as unknown as ReturnType<typeof vi.fn>;
const mockToastError = toast.error as unknown as ReturnType<typeof vi.fn>;

const defaultProps = {
  open: true,
  onOpenChange: vi.fn(),
  stackName: 'my-stack',
  relPath: 'data/logs',
  entry: {
    name: 'logs',
    type: 'directory' as const,
    size: 4096,
    mtime: Date.now(),
    isProtected: false,
  },
  rootId: 'stack-source',
  onDeleted: vi.fn(),
};

beforeEach(() => {
  mockDelete.mockReset();
  mockToastError.mockReset();
});

describe('DeleteFileConfirm', () => {
  it('shows the Delete button for a regular file', () => {
    render(<DeleteFileConfirm {...defaultProps} />);
    expect(screen.getByTestId('delete-confirm-btn')).toHaveTextContent('Delete');
  });

  it('switches to "Delete all" and shows warning on NOT_EMPTY error', async () => {
    mockDelete.mockRejectedValueOnce(new NotEmptyError('Directory is not empty'));
    render(<DeleteFileConfirm {...defaultProps} />);
    const btn = screen.getByTestId('delete-confirm-btn');

    await userEvent.click(btn);

    await waitFor(() => {
      expect(screen.getByText(/This folder is not empty/)).toBeInTheDocument();
    });
    expect(btn).toHaveTextContent('Delete all');
    expect(screen.getByText('NON-EMPTY FOLDER')).toBeInTheDocument();
    expect(mockToastError).not.toHaveBeenCalled();
  });

  it('sends recursive delete on the second click after NOT_EMPTY', async () => {
    mockDelete.mockRejectedValueOnce(new NotEmptyError('Directory is not empty'));
    mockDelete.mockResolvedValueOnce(undefined);
    const onDeleted = vi.fn();
    const onOpenChange = vi.fn();

    render(
      <DeleteFileConfirm
        {...defaultProps}
        onDeleted={onDeleted}
        onOpenChange={onOpenChange}
      />,
    );
    const btn = screen.getByTestId('delete-confirm-btn');

    // First click triggers NOT_EMPTY, button becomes "Delete all"
    await userEvent.click(btn);
    await waitFor(() => {
      expect(btn).toHaveTextContent('Delete all');
    });

    // Second click sends recursive delete
    await userEvent.click(btn);

    await waitFor(() => {
      expect(mockDelete).toHaveBeenLastCalledWith(
        'my-stack',
        'data/logs',
        true,
        'stack-source',
      );
    });
    await waitFor(() => {
      expect(onDeleted).toHaveBeenCalledTimes(1);
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
  });

  it('toasts on a non-NOT_EMPTY error and keeps "Delete" label', async () => {
    mockDelete.mockRejectedValueOnce(new Error('Permission denied'));
    render(<DeleteFileConfirm {...defaultProps} />);
    const btn = screen.getByTestId('delete-confirm-btn');

    await userEvent.click(btn);

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith('Permission denied');
    });
    expect(btn).toHaveTextContent('Delete');
    expect(screen.queryByText(/This folder is not empty/)).not.toBeInTheDocument();
  });
});
