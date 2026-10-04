/**
 * Other surfaces (the GitOps workplace) open this tab on one Blueprint's
 * detail or on the create dialog: a tab mounting because of it starts there,
 * and a tab already mounted hears the request.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { clearBlueprintIntent, openBlueprintIntent } from '@/lib/blueprintIntent';
import { addNodeLabel, createBlueprint } from '@/lib/blueprintsApi';
import { toast } from '@/components/ui/toast-store';
import { DeploymentsTab } from './DeploymentsTab';

const grants = { create: true };

vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({ can: (permission: string) => permission !== 'stack:create' || grants.create }),
}));
vi.mock('@/lib/blueprintsApi', () => ({
  listBlueprints: vi.fn(async () => []),
  listAllNodeLabels: vi.fn(async () => ({})),
  createBlueprint: vi.fn(async () => ({ id: 9 })),
  addNodeLabel: vi.fn(async () => ({ nodeId: 2, label: 'edge', gitopsRevisions: [] })),
}));
vi.mock('@/components/ui/toast-store', () => ({
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() },
}));
vi.mock('./BlueprintDetail', () => ({
  BlueprintDetail: ({ blueprintId, reviewOnOpen }: { blueprintId: number; reviewOnOpen?: boolean }) => (
    <div data-testid="blueprint-detail" data-review={String(reviewOnOpen)}>{blueprintId}</div>
  ),
}));
vi.mock('./BlueprintEditor', () => ({
  BlueprintEditor: ({ onSubmit }: { onSubmit: (input: unknown, options: unknown) => Promise<void> }) => (
    <div data-testid="blueprint-editor">
      <button type="button" onClick={() => void onSubmit({ name: 'web' }, { intent: 'review', staged: [{ nodeId: 2, label: 'edge' }] })}>review</button>
      <button type="button" onClick={() => void onSubmit({ name: 'web' }, { intent: 'save', staged: [] })}>draft</button>
    </div>
  ),
}));

afterEach(() => {
  clearBlueprintIntent();
  grants.create = true;
});

describe('DeploymentsTab intents', () => {
  it('mounts on the Blueprint another surface asked for', async () => {
    openBlueprintIntent({ kind: 'open', blueprintId: 5 });
    render(<DeploymentsTab />);
    expect(await screen.findByTestId('blueprint-detail')).toHaveTextContent('5');
  });

  it('opens the create dialog when already mounted', async () => {
    render(<DeploymentsTab />);
    await act(async () => { openBlueprintIntent({ kind: 'create' }); });
    expect(await screen.findByTestId('blueprint-editor')).toBeInTheDocument();
  });

  it('never opens the create dialog for a role that cannot create', async () => {
    grants.create = false;
    openBlueprintIntent({ kind: 'create' });
    render(<DeploymentsTab />);
    await act(async () => {});
    expect(screen.queryByTestId('blueprint-editor')).toBeNull();
  });
});

describe('DeploymentsTab create', () => {
  it('writes staged labels after creating, then opens the new Blueprint on its review', async () => {
    render(<DeploymentsTab />);
    await act(async () => { openBlueprintIntent({ kind: 'create' }); });
    fireEvent.click(await screen.findByRole('button', { name: 'review' }));
    const detail = await screen.findByTestId('blueprint-detail');
    expect(detail).toHaveTextContent('9');
    expect(detail).toHaveAttribute('data-review', 'true');
    expect(vi.mocked(createBlueprint)).toHaveBeenCalledWith({ name: 'web' });
    expect(vi.mocked(addNodeLabel)).toHaveBeenCalledWith(2, 'edge');
    expect(vi.mocked(createBlueprint).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(addNodeLabel).mock.invocationCallOrder[0]);
  });

  it('opens a draft without a review and writes no labels', async () => {
    vi.mocked(addNodeLabel).mockClear();
    render(<DeploymentsTab />);
    await act(async () => { openBlueprintIntent({ kind: 'create' }); });
    fireEvent.click(await screen.findByRole('button', { name: 'draft' }));
    await waitFor(() => expect(screen.getByTestId('blueprint-detail')).toHaveAttribute('data-review', 'false'));
    expect(vi.mocked(addNodeLabel)).not.toHaveBeenCalled();
  });

  it('opens the sheet without the auto-preview when a staged label could not be written', async () => {
    vi.mocked(addNodeLabel).mockRejectedValueOnce(new Error('forbidden'));
    render(<DeploymentsTab />);
    await act(async () => { openBlueprintIntent({ kind: 'create' }); });
    fireEvent.click(await screen.findByRole('button', { name: 'review' }));
    const detail = await screen.findByTestId('blueprint-detail');
    expect(detail).toHaveAttribute('data-review', 'false');
  });

  it('keeps the form open and writes no labels when the Blueprint cannot be created', async () => {
    vi.mocked(addNodeLabel).mockClear();
    vi.mocked(createBlueprint).mockRejectedValueOnce(new Error('name taken'));
    render(<DeploymentsTab />);
    await act(async () => { openBlueprintIntent({ kind: 'create' }); });
    fireEvent.click(await screen.findByRole('button', { name: 'review' }));
    await waitFor(() => expect(vi.mocked(toast.error)).toHaveBeenCalledWith('name taken'));
    expect(screen.getByTestId('blueprint-editor')).toBeInTheDocument();
    expect(screen.queryByTestId('blueprint-detail')).toBeNull();
    expect(vi.mocked(addNodeLabel)).not.toHaveBeenCalled();
  });
});
