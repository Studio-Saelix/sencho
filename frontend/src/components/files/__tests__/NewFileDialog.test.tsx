/**
 * Coverage for NewFileDialog create semantics.
 *
 * Creating a file routes through createEmptyStackFile (a zero-byte upload with
 * no overwrite), so the server decides collisions. A fresh name creates and
 * fires onCreated; an existing name comes back as UploadConflictError and must
 * surface inline without clobbering the existing file or closing the dialog.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const h = vi.hoisted(() => ({
  createMock: vi.fn<(stack: string, dir: string, name: string, opts?: { rootId?: string }) => Promise<void>>(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

// Keep the real module (UploadConflictError must stay a real class for
// instanceof to hold) and swap only the create call.
vi.mock('@/lib/stackFilesApi', async (orig) => ({
  ...(await orig<typeof import('@/lib/stackFilesApi')>()),
  createEmptyStackFile: h.createMock,
}));

vi.mock('@/components/ui/toast-store', () => ({
  toast: { error: h.toastError, success: h.toastSuccess, loading: vi.fn(() => 'id'), dismiss: vi.fn() },
}));

import { NewFileDialog } from '../NewFileDialog';
import { UploadConflictError } from '@/lib/stackFilesApi';

function setup(currentDir = 'configs') {
  const onCreated = vi.fn();
  const onOpenChange = vi.fn();
  render(
    <NewFileDialog
      open
      onOpenChange={onOpenChange}
      stackName="my-stack"
      currentDir={currentDir}
      rootId="stack-source"
      onCreated={onCreated}
    />,
  );
  return { onCreated, onOpenChange };
}

beforeEach(() => {
  h.createMock.mockReset();
  h.toastError.mockReset();
  h.toastSuccess.mockReset();
});

describe('NewFileDialog', () => {
  it('creates a blank file in the current dir and reports success', async () => {
    h.createMock.mockResolvedValue(undefined);
    const user = userEvent.setup();
    const { onCreated, onOpenChange } = setup('configs');

    await user.type(screen.getByLabelText(/file name/i), 'app.conf');
    await user.click(screen.getByRole('button', { name: /^create$/i }));

    await waitFor(() =>
      expect(h.createMock).toHaveBeenCalledWith('my-stack', 'configs', 'app.conf', { rootId: 'stack-source' }),
    );
    expect(onCreated).toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(h.toastSuccess).toHaveBeenCalledWith('File created.');
  });

  it('surfaces an inline error and does not overwrite when the name already exists', async () => {
    h.createMock.mockRejectedValueOnce(new UploadConflictError('app.conf already exists.'));
    const user = userEvent.setup();
    const { onCreated, onOpenChange } = setup('configs');

    await user.type(screen.getByLabelText(/file name/i), 'app.conf');
    await user.click(screen.getByRole('button', { name: /^create$/i }));

    expect(await screen.findByText(/a file with that name already exists/i)).toBeInTheDocument();
    // The dialog stays open and the create is not treated as a success.
    expect(onCreated).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    expect(h.toastSuccess).not.toHaveBeenCalled();
  });

  it('rejects an invalid name client-side without calling the server', async () => {
    const user = userEvent.setup();
    setup('configs');

    await user.type(screen.getByLabelText(/file name/i), 'bad/name');
    await user.click(screen.getByRole('button', { name: /^create$/i }));

    expect(await screen.findByText(/must not be empty/i)).toBeInTheDocument();
    expect(h.createMock).not.toHaveBeenCalled();
  });

  it('routes an unexpected failure to a toast', async () => {
    h.createMock.mockRejectedValueOnce(new Error('disk full'));
    const user = userEvent.setup();
    const { onCreated } = setup('configs');

    await user.type(screen.getByLabelText(/file name/i), 'app.conf');
    await user.click(screen.getByRole('button', { name: /^create$/i }));

    await waitFor(() => expect(h.toastError).toHaveBeenCalledWith('disk full'));
    expect(onCreated).not.toHaveBeenCalled();
  });
});
