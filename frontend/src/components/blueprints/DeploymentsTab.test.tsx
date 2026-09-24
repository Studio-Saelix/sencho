/**
 * Other surfaces (the GitOps workplace) open this tab on one Blueprint's
 * detail or on the create dialog: a tab mounting because of it starts there,
 * and a tab already mounted hears the request.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { clearBlueprintIntent, openBlueprintIntent } from '@/lib/blueprintIntent';
import { DeploymentsTab } from './DeploymentsTab';

const grants = { create: true };

vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({ can: (permission: string) => permission !== 'stack:create' || grants.create }),
}));
vi.mock('@/lib/blueprintsApi', () => ({
  listBlueprints: vi.fn(async () => []),
  listDistinctLabels: vi.fn(async () => []),
  createBlueprint: vi.fn(),
}));
vi.mock('./BlueprintDetail', () => ({
  BlueprintDetail: ({ blueprintId }: { blueprintId: number }) => <div data-testid="blueprint-detail">{blueprintId}</div>,
}));
vi.mock('./BlueprintEditor', () => ({
  BlueprintEditor: () => <div data-testid="blueprint-editor" />,
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
