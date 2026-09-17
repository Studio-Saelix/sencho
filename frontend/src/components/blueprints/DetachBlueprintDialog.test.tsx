import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

vi.mock('@/lib/blueprintsApi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/blueprintsApi')>();
  return { ...actual, detachContentBinding: vi.fn() };
});

vi.mock('@/components/ui/toast-store', () => ({
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn(), loading: vi.fn(), dismiss: vi.fn() },
}));

import { detachContentBinding } from '@/lib/blueprintsApi';
import { DetachBlueprintDialog } from './DetachBlueprintDialog';

beforeEach(() => {
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
  it('detaches Git-managed content after confirm', async () => {
    const onDetached = vi.fn();
    render(
      <DetachBlueprintDialog open onOpenChange={vi.fn()} blueprintId={3} onDetached={onDetached} />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Detach' }));
    await waitFor(() => {
      expect(detachContentBinding).toHaveBeenCalledWith(3);
      expect(onDetached).toHaveBeenCalled();
    });
  });
});
