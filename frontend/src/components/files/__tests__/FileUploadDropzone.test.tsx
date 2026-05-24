import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

vi.mock('@/lib/stackFilesApi', () => ({
  uploadStackFile: vi.fn(),
}));

vi.mock('@/components/ui/toast-store', () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
    loading: vi.fn(() => 'loading-id'),
    dismiss: vi.fn(),
  },
}));

import { FileUploadDropzone } from '../FileUploadDropzone';
import { uploadStackFile } from '@/lib/stackFilesApi';
import { toast } from '@/components/ui/toast-store';

const mockUpload = uploadStackFile as unknown as ReturnType<typeof vi.fn>;
const mockToastError = toast.error as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockUpload.mockReset();
  mockToastError.mockReset();
});

describe('FileUploadDropzone', () => {
  it('renders upload control for users with stack edit permission', () => {
    render(<FileUploadDropzone stackName="app" currentDir="" canEdit onUploaded={vi.fn()} />);
    expect(screen.getByRole('button', { name: /upload or drop file/i })).toBeInTheDocument();
  });

  it('hides upload control when the user cannot edit the stack', () => {
    render(<FileUploadDropzone stackName="app" currentDir="" canEdit={false} onUploaded={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /upload or drop file/i })).not.toBeInTheDocument();
  });

  it('uploads via the same pipeline when a file is dropped onto the zone', async () => {
    mockUpload.mockResolvedValueOnce(undefined);
    const onUploaded = vi.fn();
    render(<FileUploadDropzone stackName="app" currentDir="config" canEdit onUploaded={onUploaded} />);
    const zone = screen.getByRole('button', { name: /upload or drop file/i });

    const file = new File(['hello'], 'drop.txt', { type: 'text/plain' });
    const dataTransfer = {
      files: [file],
      types: ['Files'],
      dropEffect: 'copy',
    } as unknown as DataTransfer;

    fireEvent.dragOver(zone, { dataTransfer });
    expect(screen.getByText(/drop to upload/i)).toBeInTheDocument();

    fireEvent.drop(zone, { dataTransfer });
    await waitFor(() => expect(mockUpload).toHaveBeenCalledTimes(1));
    expect(mockUpload).toHaveBeenCalledWith('app', 'config', file);
    await waitFor(() => expect(onUploaded).toHaveBeenCalledTimes(1));
  });

  it('rejects a multi-file drop with a clear toast and does not upload', async () => {
    render(<FileUploadDropzone stackName="app" currentDir="" canEdit onUploaded={vi.fn()} />);
    const zone = screen.getByRole('button', { name: /upload or drop file/i });

    const a = new File(['a'], 'a.txt');
    const b = new File(['b'], 'b.txt');
    const dataTransfer = {
      files: [a, b],
      types: ['Files'],
      dropEffect: 'copy',
    } as unknown as DataTransfer;

    fireEvent.drop(zone, { dataTransfer });
    expect(mockToastError).toHaveBeenCalledWith(expect.stringMatching(/one file at a time/i));
    expect(mockUpload).not.toHaveBeenCalled();
  });

  it('ignores drag events that do not carry files (e.g. text selection)', () => {
    render(<FileUploadDropzone stackName="app" currentDir="" canEdit onUploaded={vi.fn()} />);
    const zone = screen.getByRole('button', { name: /upload or drop file/i });

    const dataTransfer = {
      files: [],
      types: ['text/plain'],
      dropEffect: 'none',
    } as unknown as DataTransfer;

    fireEvent.dragOver(zone, { dataTransfer });
    // Zone never enters the active "Drop to upload" state.
    expect(screen.queryByText(/drop to upload/i)).not.toBeInTheDocument();
  });
});
