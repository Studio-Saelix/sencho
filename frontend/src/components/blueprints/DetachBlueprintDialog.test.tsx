import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import type { BindingPreview } from '@/lib/blueprintsApi';

vi.mock('@/lib/blueprintsApi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/blueprintsApi')>();
  return {
    ...actual,
    previewDetachContentBinding: vi.fn(),
    detachContentBinding: vi.fn(),
  };
});

vi.mock('@/components/ui/toast-store', () => ({
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn(), loading: vi.fn(), dismiss: vi.fn() },
}));

import {
  detachContentBinding,
  previewDetachContentBinding,
} from '@/lib/blueprintsApi';
import { DetachBlueprintDialog } from './DetachBlueprintDialog';

const preview: BindingPreview = {
  transition: 'detach',
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
  rollbackLimitations: ['Detach restores the frozen Inline snapshot; later Git commits are not written back.'],
};

beforeEach(() => {
  vi.mocked(previewDetachContentBinding).mockResolvedValue(preview);
  vi.mocked(detachContentBinding).mockResolvedValue({
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

describe('DetachBlueprintDialog', () => {
  it('previews then detaches Git-managed content', async () => {
    const onDetached = vi.fn();
    render(
      <DetachBlueprintDialog open onOpenChange={vi.fn()} blueprintId={3} onDetached={onDetached} />,
    );

    await screen.findByText('Detach restores the frozen Inline snapshot; later Git commits are not written back.');
    expect(previewDetachContentBinding).toHaveBeenCalledWith(3);
    expect(screen.getByRole('button', { name: 'Detach' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Detach' }));
    await waitFor(() => {
      expect(detachContentBinding).toHaveBeenCalledWith(3);
      expect(onDetached).toHaveBeenCalled();
    });
  });
});
