import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import type { BindingPreview, DirectGitSourceOption } from '@/lib/blueprintsApi';

vi.mock('@/lib/blueprintsApi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/blueprintsApi')>();
  return {
    ...actual,
    listDirectGitSourceOptions: vi.fn(),
    previewConvertContentBinding: vi.fn(),
    convertContentBinding: vi.fn(),
  };
});

vi.mock('@/components/ui/toast-store', () => ({
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn(), loading: vi.fn(), dismiss: vi.fn() },
}));

import {
  convertContentBinding,
  listDirectGitSourceOptions,
  previewConvertContentBinding,
} from '@/lib/blueprintsApi';
import { ConvertBlueprintDialog } from './ConvertBlueprintDialog';

const option: DirectGitSourceOption = {
  applicationId: 'app-web',
  stackName: 'web',
  repoUrl: 'https://github.com/example/web.git',
  ref: 'main',
};

const preview: BindingPreview = {
  transition: 'convert',
  currentOrigin: 'inline',
  proposedOrigin: 'git',
  application: {
    id: 'app-web',
    stackName: 'web',
    repoUrl: option.repoUrl,
    ref: 'main',
    composePaths: ['compose.yaml'],
    contextDir: null,
    sourcePolicy: 'manual',
    lifecycleStatus: 'active',
  },
  blueprintPreview: null,
  markers: [],
  rollbackLimitations: ['Conversion moves a live Git source onto this Blueprint. Credentials stay with that source.'],
};

beforeEach(() => {
  vi.mocked(listDirectGitSourceOptions).mockResolvedValue([option]);
  vi.mocked(previewConvertContentBinding).mockResolvedValue(preview);
  vi.mocked(convertContentBinding).mockResolvedValue({
    contentOrigin: 'git',
    applicationId: 'app-web',
    repoUrl: option.repoUrl,
    ref: 'main',
    composePaths: ['compose.yaml'],
    contextDir: null,
    sourcePolicy: 'manual',
    lifecycleStatus: 'active',
    blockedRollout: true,
    snapshotPresent: true,
  });
});

describe('ConvertBlueprintDialog', () => {
  it('previews then converts a selected Direct source', async () => {
    const onConverted = vi.fn();
    render(
      <ConvertBlueprintDialog open onOpenChange={vi.fn()} blueprintId={3} onConverted={onConverted} />,
    );

    await screen.findByText('Live Git source');
    expect(screen.getByRole('button', { name: 'Convert' })).toBeDisabled();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'app-web' } });
    await screen.findByText('Conversion moves a live Git source onto this Blueprint. Credentials stay with that source.');
    fireEvent.click(screen.getByRole('button', { name: 'Convert' }));
    await waitFor(() => {
      expect(convertContentBinding).toHaveBeenCalledWith(3, 'app-web');
      expect(onConverted).toHaveBeenCalled();
    });
  });
});
