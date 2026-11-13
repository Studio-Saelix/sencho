import { describe, it, expect, vi } from 'vitest';
import { useRef, useState } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DismissedCountButton, DismissedSheet, type DismissedItem } from '../dismissed-sheet';

const item = (over: Partial<DismissedItem> = {}): DismissedItem => ({ id: 1, title: 'Port exposure unclear', meta: 'dismissed by alice', ...over });

/** The real arrangement on every surface: a count outside the sheet, and a region that outlives a restore. */
function FocusHarness({ initialItems }: { initialItems: DismissedItem[] }) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState(initialItems);
  const openerRef = useRef<HTMLButtonElement>(null);
  const fallbackRef = useRef<HTMLDivElement>(null);
  return (
    <div>
      <DismissedCountButton ref={openerRef} count={items.length} onClick={() => setOpen(true)} />
      <div ref={fallbackRef} tabIndex={-1} data-testid="surviving-region">Surface that survives</div>
      <DismissedSheet
        open={open}
        onOpenChange={setOpen}
        openerRef={openerRef}
        fallbackFocusRef={fallbackRef}
        crumb={['Networking', 'Findings']}
        items={items.map(row => ({ ...row, onRestore: () => setItems(current => current.filter(candidate => candidate.id !== row.id)) }))}
      />
    </div>
  );
}

async function openWithKeyboard(user: ReturnType<typeof userEvent.setup>) {
  const opener = screen.getByRole('button', { name: '1 dismissed' });
  opener.focus();
  await user.keyboard('{Enter}');
  await screen.findByRole('dialog');
  return opener;
}

describe('DismissedCountButton', () => {
  it('renders nothing at zero', () => {
    const { container } = render(<DismissedCountButton count={0} onClick={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('names the count and opens on click', async () => {
    const onClick = vi.fn();
    render(<DismissedCountButton count={3} onClick={onClick} />);
    const button = screen.getByRole('button', { name: '3 dismissed' });
    expect(button).toHaveAttribute('aria-haspopup', 'dialog');
    await userEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

describe('DismissedSheet', () => {
  it('lists each row with Restore only where the account may restore', async () => {
    const onRestore = vi.fn();
    render(
      <DismissedSheet
        open
        onOpenChange={() => {}}
        crumb={['Networking', 'Findings']}
        items={[item({ id: 1, onRestore }), item({ id: 2, title: 'Read-only row' }), item({ id: 3, title: 'Busy row', onRestore, restoring: true })]}
      />,
    );
    expect(screen.getByText('Dismissed findings')).toBeInTheDocument();
    expect(screen.getByText('3 set aside · still counted, never hidden')).toBeInTheDocument();
    const restores = screen.getAllByRole('button', { name: 'Restore' });
    expect(restores).toHaveLength(2);
    expect(restores[1]).toBeDisabled();
    await userEvent.click(restores[0]);
    expect(onRestore).toHaveBeenCalledTimes(1);
  });

  it('says it is updating instead of listing or counting while the list is re-read', () => {
    render(<DismissedSheet open onOpenChange={() => {}} crumb={['Networking', 'Findings']} items={[item({ onRestore: () => {} })]} loading />);
    expect(screen.getByText('Updating…')).toBeInTheDocument();
    expect(screen.getByText('Updating the list…')).toBeInTheDocument();
    expect(screen.queryByText('Port exposure unclear')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Restore' })).toBeNull();
    expect(screen.queryByText(/set aside/)).toBeNull();
  });

  it('says so when nothing is dismissed', () => {
    render(<DismissedSheet open onOpenChange={() => {}} crumb={['Security', 'Overview']} items={[]} />);
    expect(screen.getByText('Nothing is dismissed.')).toBeInTheDocument();
  });
});

describe('DismissedSheet focus return', () => {
  it.each([
    ['Escape', async (user: ReturnType<typeof userEvent.setup>) => { await user.keyboard('{Escape}'); }],
    ['the Close control', async (user: ReturnType<typeof userEvent.setup>) => {
      await user.click(screen.getByRole('button', { name: 'Close' }));
    }],
    ['the first breadcrumb', async (user: ReturnType<typeof userEvent.setup>) => {
      await user.click(screen.getByRole('button', { name: 'Networking' }));
    }],
  ])('returns focus to the originating count after %s', async (_control, close) => {
    const user = userEvent.setup();
    render(<FocusHarness initialItems={[item()]} />);
    const opener = await openWithKeyboard(user);

    await close(user);

    await waitFor(() => expect(opener).toHaveFocus());
  });

  it('returns focus to the surviving region when restoring the last item removes the count', async () => {
    const user = userEvent.setup();
    render(<FocusHarness initialItems={[item()]} />);
    await openWithKeyboard(user);

    await user.click(screen.getByRole('button', { name: 'Restore' }));
    expect(screen.queryByRole('button', { name: /dismissed/ })).toBeNull();

    await user.keyboard('{Escape}');

    await waitFor(() => expect(screen.getByTestId('surviving-region')).toHaveFocus());
  });
});
