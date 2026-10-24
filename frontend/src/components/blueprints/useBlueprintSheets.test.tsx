/**
 * The Blueprint sheets are hosted by the Blueprints tab and by the GitOps
 * workplace; both must get the same handlers, so the behavior that matters is
 * pinned here once, through a bare host.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createBlueprint, listAllNodeLabels } from '@/lib/blueprintsApi';
import { useBlueprintSheets } from './useBlueprintSheets';

const grants = { create: true, deploy: true };

vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({
    can: (action: string) => (action === 'stack:create' ? grants.create : action === 'stack:deploy' ? grants.deploy : true),
  }),
}));
vi.mock('@/lib/blueprintsApi', () => ({
  listAllNodeLabels: vi.fn(async () => ({ 1: ['prod'] })),
  createBlueprint: vi.fn(async () => ({ id: 9 })),
  addNodeLabel: vi.fn(),
}));
vi.mock('@/components/ui/toast-store', () => ({ toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() } }));
vi.mock('./BlueprintDetail', () => ({
  BlueprintDetail: (props: { blueprintId: number; showPortfolioLink?: boolean; reviewOnOpen?: boolean; nodeLabels: object; onChanged: () => void }) => (
    <div data-testid="detail" data-link={String(props.showPortfolioLink)} data-review={String(props.reviewOnOpen)} data-labels={JSON.stringify(props.nodeLabels)}>
      {props.blueprintId}
      <button type="button" onClick={props.onChanged}>changed</button>
    </div>
  ),
}));
vi.mock('./BlueprintEditor', () => ({
  BlueprintEditor: ({ canReview, onSubmit }: { canReview: boolean; onSubmit: (i: unknown, o: unknown) => Promise<void> }) => (
    <div data-testid="editor" data-review={String(canReview)}>
      <button type="button" onClick={() => void onSubmit({ name: 'web' }, { intent: 'review', staged: [] })}>review</button>
    </div>
  ),
}));

function Host({ onChanged, showPortfolioLink }: { onChanged: () => Promise<boolean> | boolean; showPortfolioLink?: boolean }) {
  const { openBlueprint, openCreate, sheets } = useBlueprintSheets({ onChanged, showPortfolioLink });
  return (
    <>
      <button type="button" onClick={() => openBlueprint(5)}>open</button>
      <button type="button" onClick={openCreate}>create</button>
      {sheets}
    </>
  );
}

beforeEach(() => {
  grants.create = true;
  grants.deploy = true;
});
afterEach(() => {
  vi.mocked(listAllNodeLabels).mockClear();
  vi.mocked(createBlueprint).mockClear();
});

describe('useBlueprintSheets', () => {
  it('reads node labels only once a sheet opens', async () => {
    render(<Host onChanged={() => true} />);
    await act(async () => {});
    expect(listAllNodeLabels).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('open'));
    await waitFor(() => expect(listAllNodeLabels).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByTestId('detail').dataset.labels).toBe(JSON.stringify({ 1: ['prod'] })));
  });

  it('keeps the link back to GitOps except where the sheets already sit over it', () => {
    const { unmount } = render(<Host onChanged={() => true} />);
    fireEvent.click(screen.getByText('open'));
    expect(screen.getByTestId('detail').dataset.link).toBe('true');
    unmount();
    render(<Host onChanged={() => true} showPortfolioLink={false} />);
    fireEvent.click(screen.getByText('open'));
    expect(screen.getByTestId('detail').dataset.link).toBe('false');
  });

  it('tells the host and rereads labels when a Blueprint changes', async () => {
    const onChanged = vi.fn(async () => true);
    render(<Host onChanged={onChanged} />);
    fireEvent.click(screen.getByText('open'));
    await waitFor(() => expect(listAllNodeLabels).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByText('changed'));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(listAllNodeLabels).toHaveBeenCalledTimes(2));
  });

  it('opens a created Blueprint on its review once the host has reread', async () => {
    render(<Host onChanged={async () => true} />);
    fireEvent.click(screen.getByText('create'));
    fireEvent.click(await screen.findByText('review'));
    const detail = await screen.findByTestId('detail');
    expect(detail).toHaveTextContent('9');
    expect(detail.dataset.review).toBe('true');
  });

  it('does not open a created Blueprint over a host that could not reread', async () => {
    render(<Host onChanged={async () => false} />);
    fireEvent.click(screen.getByText('create'));
    fireEvent.click(await screen.findByText('review'));
    await waitFor(() => expect(createBlueprint).toHaveBeenCalled());
    expect(screen.queryByTestId('detail')).toBeNull();
  });

  it('opens nothing for create when the session cannot create, and offers review only with deploy rights', async () => {
    grants.create = false;
    const { unmount } = render(<Host onChanged={() => true} />);
    fireEvent.click(screen.getByText('create'));
    expect(screen.queryByTestId('editor')).toBeNull();
    unmount();
    grants.create = true;
    grants.deploy = false;
    render(<Host onChanged={() => true} />);
    fireEvent.click(screen.getByText('create'));
    expect((await screen.findByTestId('editor')).dataset.review).toBe('false');
  });

  it('opens nothing over a host whose refresh threw, and says why in the log', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<Host onChanged={async () => { throw new Error('boom'); }} />);
    fireEvent.click(screen.getByText('create'));
    fireEvent.click(await screen.findByText('review'));
    await waitFor(() => expect(spy).toHaveBeenCalled());
    expect(screen.queryByTestId('detail')).toBeNull();
    spy.mockRestore();
  });

  it('tells the operator when node labels could not be read, and keeps the last good map', async () => {
    const { toast } = await import('@/components/ui/toast-store');
    vi.mocked(listAllNodeLabels).mockRejectedValueOnce(new Error('offline'));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<Host onChanged={() => true} />);
    fireEvent.click(screen.getByText('open'));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Could not load node labels. Label targets may show as empty.'));
    spy.mockRestore();
  });

  it('keeps the newest labels when an older read finishes last', async () => {
    let first: (v: Record<number, string[]>) => void = () => {};
    vi.mocked(listAllNodeLabels)
      .mockImplementationOnce(() => new Promise(r => { first = r; }))
      .mockResolvedValueOnce({ 2: ['newer'] });
    render(<Host onChanged={() => true} />);
    fireEvent.click(screen.getByText('open'));
    await waitFor(() => expect(listAllNodeLabels).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByText('changed'));
    await waitFor(() => expect(screen.getByTestId('detail').dataset.labels).toBe(JSON.stringify({ 2: ['newer'] })));
    await act(async () => { first({ 1: ['older'] }); });
    expect(screen.getByTestId('detail').dataset.labels).toBe(JSON.stringify({ 2: ['newer'] }));
  });
});
