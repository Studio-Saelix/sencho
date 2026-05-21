import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { FileUploadDropzone } from '../FileUploadDropzone';

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

describe('FileUploadDropzone', () => {
  it('renders upload control for users with stack edit permission', () => {
    render(
      <FileUploadDropzone
        stackName="app"
        currentDir=""
        canEdit
        onUploaded={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: /upload file/i })).toBeInTheDocument();
  });

  it('hides upload control when the user cannot edit the stack', () => {
    render(
      <FileUploadDropzone
        stackName="app"
        currentDir=""
        canEdit={false}
        onUploaded={vi.fn()}
      />,
    );

    expect(screen.queryByRole('button', { name: /upload file/i })).not.toBeInTheDocument();
  });
});
