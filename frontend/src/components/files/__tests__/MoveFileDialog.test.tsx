/**
 * Coverage for MoveFileDialog's destination gating and confirm behaviour.
 *
 * The folder picker must never offer an invalid destination: the entry's own
 * current parent (a no-op), the entry itself or a descendant (for a directory),
 * or the stack root when the entry's name is reserved there (compose/.env).
 * listStackDirectory is mocked; the real path helpers are kept so the gating
 * logic under test runs for real.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { FileEntry } from '@/lib/stackFilesApi';

const listMock = vi.hoisted(() => vi.fn<(stack: string, dir: string) => Promise<FileEntry[]>>());

vi.mock('@/lib/stackFilesApi', async (orig) => ({
  ...(await orig<typeof import('@/lib/stackFilesApi')>()),
  listStackDirectory: listMock,
}));

vi.mock('@/components/ui/toast-store', () => ({
  toast: { error: vi.fn(), success: vi.fn(), loading: vi.fn(() => 'id'), dismiss: vi.fn() },
}));

import { MoveFileDialog } from '../MoveFileDialog';

function dir(name: string): FileEntry {
  return { name, type: 'directory', size: 0, mtime: 0, isProtected: false };
}

function file(name: string, type: FileEntry['type'] = 'file'): FileEntry {
  return { name, type, size: 1, mtime: 0, isProtected: false };
}

function labelButton(name: string): HTMLButtonElement {
  const btn = screen.getByText(name).closest('button');
  if (!btn) throw new Error(`no button for ${name}`);
  return btn as HTMLButtonElement;
}

beforeEach(() => {
  listMock.mockReset();
});

describe('MoveFileDialog', () => {
  it('disables the current parent and confirms a valid destination, closing on success', async () => {
    listMock.mockResolvedValue([dir('configs'), dir('services'), dir('logs')]);
    const onMove = vi.fn().mockResolvedValue(true);
    const onOpenChange = vi.fn();
    const user = userEvent.setup();

    render(
      <MoveFileDialog
        open
        onOpenChange={onOpenChange}
        stackName="my-stack"
        relPath="configs/app.conf"
        entry={file('app.conf')}
        onMove={onMove}
      />,
    );

    await screen.findByText('services');

    // Move is disabled until a destination is chosen.
    const moveBtn = screen.getByRole('button', { name: /^move$/i });
    expect(moveBtn).toBeDisabled();

    // The entry's current parent is a no-op destination and is disabled.
    expect(labelButton('configs')).toBeDisabled();
    // The stack root is valid here (app.conf is not a reserved root name).
    expect(labelButton('Stack root')).toBeEnabled();

    await user.click(labelButton('services'));
    expect(moveBtn).toBeEnabled();

    await user.click(moveBtn);
    expect(onMove).toHaveBeenCalledWith('configs/app.conf', 'app.conf', 'services');
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it('stays open when the move is blocked or fails', async () => {
    listMock.mockResolvedValue([dir('services')]);
    const onMove = vi.fn().mockResolvedValue(false);
    const onOpenChange = vi.fn();
    const user = userEvent.setup();

    render(
      <MoveFileDialog
        open
        onOpenChange={onOpenChange}
        stackName="my-stack"
        relPath="configs/app.conf"
        entry={file('app.conf')}
        onMove={onMove}
      />,
    );

    await screen.findByText('services');
    await user.click(labelButton('services'));
    await user.click(screen.getByRole('button', { name: /^move$/i }));

    expect(onMove).toHaveBeenCalledWith('configs/app.conf', 'app.conf', 'services');
    // A falsy result must not dismiss the picker.
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it('disables the stack root when the entry name is reserved there', async () => {
    listMock.mockResolvedValue([dir('configs')]);

    render(
      <MoveFileDialog
        open
        onOpenChange={vi.fn()}
        stackName="my-stack"
        relPath="configs/.env"
        entry={file('.env')}
        onMove={vi.fn()}
      />,
    );

    await screen.findByText('configs');
    expect(labelButton('Stack root')).toBeDisabled();
  });

  it('disables a directory destination that is the source itself', async () => {
    listMock.mockResolvedValue([dir('parent'), dir('other')]);

    render(
      <MoveFileDialog
        open
        onOpenChange={vi.fn()}
        stackName="my-stack"
        relPath="parent"
        entry={file('parent', 'directory')}
        onMove={vi.fn()}
      />,
    );

    await screen.findByText('other');
    // Source-into-itself is blocked; an unrelated sibling stays selectable.
    expect(labelButton('parent')).toBeDisabled();
    expect(labelButton('other')).toBeEnabled();
    // Root is the source's current parent here, so it is also a no-op.
    expect(labelButton('Stack root')).toBeDisabled();
  });
});
