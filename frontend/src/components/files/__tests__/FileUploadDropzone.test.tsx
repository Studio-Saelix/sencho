import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { FileUploadDropzone } from '../FileUploadDropzone';

const licenseState = { isPaid: true };

vi.mock('@/context/LicenseContext', () => ({
  useLicense: () => licenseState,
}));

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
  beforeEach(() => {
    licenseState.isPaid = true;
  });

  it('renders upload control for paid users with stack edit permission', () => {
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

  it('hides upload control on Community tier', () => {
    licenseState.isPaid = false;

    render(
      <FileUploadDropzone
        stackName="app"
        currentDir=""
        canEdit
        onUploaded={vi.fn()}
      />,
    );

    expect(screen.queryByRole('button', { name: /upload file/i })).not.toBeInTheDocument();
  });
});
