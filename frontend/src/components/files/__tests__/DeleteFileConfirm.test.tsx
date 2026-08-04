/**
 * Coverage for DeleteFileConfirm two-step delete semantics.
 *
 * Deleting a non-empty directory without the recursive flag returns HTTP 409
 * with code NOT_EMPTY from the server. The dialog catches this via
 * NotEmptyError and promotes the confirm button to "Delete all" so the user
 * can confirm recursive deletion. Other errors surface as toasts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const h = vi.hoisted(() => ({
  deleteMock: vi.fn<(stack: string, path: string, recursive?: boolean, rootId?: string) => Promise<void>>(),
  toastError: vi.fn(),
}));

// Keep the real module so NotEmptyError stays a real class for instanceof.
vi.mock('@/lib/stackFilesApi', async (orig) => ({
  ...(await orig<typeof import('@/lib/stackFilesApi')>()),
  deleteStackPath: h.deleteMock,
}));

vi.mock('@/components/ui/toast-store', () => ({
  toast: { error: h.toastError, success: vi.fn(), loading: vi.fn(() => 'id'), dismiss: vi.fn() },
}));

import { DeleteFileConfirm } from '../DeleteFileConfirm';
import { NotEmptyError } from '@/lib/stackFilesApi';
import type { FileEntry } from '@/lib/stackFilesApi';

const dirEntry: FileEntry = {
  name: 'nonempty',
  type: 'directory',
  size: 0,
  mtime: 0,
  isProtected: false,
};

const fileEntry: FileEntry = {
  name: 'app.conf',
  type: 'file',
  size: 1024,
  mtime: 1700000000000,
  isProtected: false,
};

const protectedEntry: FileEntry = {
  name: 'compose.yaml',
  type: 'file',
  size: 2048,
  mtime: 1700000000000,
  isProtected: true,
};

function setup(entry: FileEntry = dirEntry) {
  const onDeleted = vi.fn();
  const onOpenChange = vi.fn();
  render(
    <DeleteFileConfirm
      open
      onOpenChange={onOpenChange}
      stackName="my-stack"
      relPath={entry.name}
      entry={entry}
      rootId="stack-source"
      onDeleted={onDeleted}
    />,
  );
  return { onDeleted, onOpenChange };
}

beforeEach(() => {
  h.deleteMock.mockReset();
  h.toastError.mockReset();
});

describe('DeleteFileConfirm', () => {
  it('deletes the entry and reports success', async () => {
    h.deleteMock.mockResolvedValue(undefined);
    const user = userEvent.setup();
    const { onDeleted, onOpenChange } = setup(fileEntry);

    await user.click(screen.getByTestId('delete-confirm-btn'));

    await waitFor(() =>
      expect(h.deleteMock).toHaveBeenCalledWith('my-stack', 'app.conf', false, 'stack-source'),
    );
    expect(onDeleted).toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('shows the not-empty warning and retries with recursive on second click', async () => {
    h.deleteMock
      .mockRejectedValueOnce(new NotEmptyError('Directory is not empty'))
      .mockResolvedValueOnce(undefined);
    const user = userEvent.setup();
    const { onDeleted, onOpenChange } = setup(dirEntry);

    // First click: non-recursive, receives NotEmptyError.
    await user.click(screen.getByTestId('delete-confirm-btn'));

    // The warning banner and "Delete all" button appear.
    expect(await screen.findByText(/this folder is not empty/i)).toBeInTheDocument();
    expect(screen.getByTestId('delete-confirm-btn')).toHaveTextContent('Delete all');

    // The first attempt was non-recursive.
    expect(h.deleteMock).toHaveBeenCalledTimes(1);
    expect(h.deleteMock).toHaveBeenLastCalledWith('my-stack', 'nonempty', false, 'stack-source');

    // Second click: retries with recursive=true.
    await user.click(screen.getByTestId('delete-confirm-btn'));

    await waitFor(() => expect(h.deleteMock).toHaveBeenCalledTimes(2));
    expect(h.deleteMock).toHaveBeenLastCalledWith('my-stack', 'nonempty', true, 'stack-source');
    expect(onDeleted).toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('routes an unrelated error to a toast and does not change the button label', async () => {
    h.deleteMock.mockRejectedValueOnce(new Error('disk full'));
    const user = userEvent.setup();
    const { onDeleted, onOpenChange } = setup(fileEntry);

    await user.click(screen.getByTestId('delete-confirm-btn'));

    await waitFor(() => expect(h.toastError).toHaveBeenCalledWith('disk full'));
    expect(onDeleted).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    // The button stays "Delete", not "Delete all".
    expect(screen.getByTestId('delete-confirm-btn')).not.toHaveTextContent('Delete all');
    expect(screen.getByTestId('delete-confirm-btn')).toHaveTextContent('Delete');
    // No not-empty warning.
    expect(screen.queryByText(/this folder is not empty/i)).toBeNull();
  });

  it('toasts when a recursive retry still fails with NotEmptyError instead of re-promoting', async () => {
    h.deleteMock
      .mockRejectedValueOnce(new NotEmptyError('Directory is not empty'))
      .mockRejectedValueOnce(new NotEmptyError('Directory is not empty'));
    const user = userEvent.setup();
    const { onDeleted } = setup(dirEntry);

    // First click: non-recursive, receives NotEmptyError, promotes to "Delete all".
    await user.click(screen.getByTestId('delete-confirm-btn'));
    expect(await screen.findByText(/this folder is not empty/i)).toBeInTheDocument();

    // Second click: recursive, still fails with NotEmptyError (race condition).
    // The !recursive guard should route this to a toast instead of re-promoting.
    await user.click(screen.getByTestId('delete-confirm-btn'));

    await waitFor(() => expect(h.toastError).toHaveBeenCalledWith('Directory is not empty'));
    expect(onDeleted).not.toHaveBeenCalled();
    // The recursive guard (!recursive) correctly routes to toast instead of
    // re-calling setNotEmpty. The warning stays visible (the directory is still
    // not empty) and the user can retry or cancel.
    expect(h.toastError).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('delete-confirm-btn')).toHaveTextContent('Delete all');
  });

  it('disables the delete button until the correct filename is typed for protected files', async () => {
    h.deleteMock.mockResolvedValue(undefined);
    const user = userEvent.setup();
    setup(protectedEntry);

    // Button is disabled because the confirm input is empty.
    expect(screen.getByTestId('delete-confirm-btn')).toBeDisabled();

    // Typing a wrong name keeps it disabled.
    await user.type(screen.getByLabelText(/type compose.yaml to confirm/i), 'wrong');
    expect(screen.getByTestId('delete-confirm-btn')).toBeDisabled();

    // Typing the correct name enables it.
    await user.clear(screen.getByLabelText(/type compose.yaml to confirm/i));
    await user.type(screen.getByLabelText(/type compose.yaml to confirm/i), 'compose.yaml');
    expect(screen.getByTestId('delete-confirm-btn')).toBeEnabled();
  });

  it('resets the notEmpty state when the dialog is reopened', async () => {
    const user = userEvent.setup();
    const baseProps = {
      open: true,
      onOpenChange: vi.fn(),
      stackName: 'my-stack',
      relPath: 'nonempty',
      entry: dirEntry,
      onDeleted: vi.fn(),
    };
    const { rerender } = render(<DeleteFileConfirm {...baseProps} />);

    // Trigger the not-empty state.
    h.deleteMock.mockRejectedValueOnce(new NotEmptyError('Directory is not empty'));
    await user.click(screen.getByTestId('delete-confirm-btn'));
    expect(await screen.findByText(/this folder is not empty/i)).toBeInTheDocument();

    // Close and reopen: the state should reset.
    rerender(<DeleteFileConfirm {...baseProps} open={false} />);
    rerender(<DeleteFileConfirm {...baseProps} open />);

    // After reopening, the warning should be gone and button should say "Delete".
    await waitFor(() =>
      expect(screen.queryByText(/this folder is not empty/i)).toBeNull(),
    );
    expect(screen.getByTestId('delete-confirm-btn')).toHaveTextContent('Delete');
  });
});
