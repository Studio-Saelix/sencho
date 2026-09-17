import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import type { BindingPreview } from '@/lib/blueprintsApi';

vi.mock('@/lib/blueprintsApi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/blueprintsApi')>();
  return {
    ...actual,
    previewRetireContentBinding: vi.fn(),
    retireContentBinding: vi.fn(),
  };
});

vi.mock('@/components/ui/toast-store', () => ({
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn(), loading: vi.fn(), dismiss: vi.fn() },
}));

import {
  previewRetireContentBinding,
  retireContentBinding,
} from '@/lib/blueprintsApi';
import { RetireBlueprintDialog } from './RetireBlueprintDialog';

const preview: BindingPreview = {
  transition: 'retire',
  currentOrigin: 'git',
  proposedOrigin: 'inline',
  application: {
    id: 'app-web',
    stackName: 'web',
    repoUrl: 'https://github.com/example/web.git',
    ref: 'main',
    composePaths: ['compose.yaml'],
    contextDir: null,
    sourcePolicy: 'manual',
    lifecycleStatus: 'active',
  },
  blueprintPreview: null,
  markers: [],
  rollbackLimitations: ['Retire restores Direct targeting using the Blueprint name as the stack identity.'],
};

beforeEach(() => {
  vi.mocked(previewRetireContentBinding).mockResolvedValue(preview);
  vi.mocked(retireContentBinding).mockResolvedValue({
    contentOrigin: 'inline',
    applicationId: null,
    repoUrl: null,
    ref: null,
    composePaths: null,
    contextDir: null,
    sourcePolicy: null,
    lifecycleStatus: null,
    blockedRollout: false,
    snapshotPresent: true,
  });
});

describe('RetireBlueprintDialog', () => {
  it('previews then retires Git-managed content', async () => {
    const onRetired = vi.fn();
    render(
      <RetireBlueprintDialog open onOpenChange={vi.fn()} blueprintId={3} onRetired={onRetired} />,
    );

    await screen.findByText('Retire restores Direct targeting using the Blueprint name as the stack identity.');
    expect(previewRetireContentBinding).toHaveBeenCalledWith(3);
    expect(screen.getByRole('button', { name: 'Retire' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Retire' }));
    await waitFor(() => {
      expect(retireContentBinding).toHaveBeenCalledWith(3);
      expect(onRetired).toHaveBeenCalled();
    });
  });
});
