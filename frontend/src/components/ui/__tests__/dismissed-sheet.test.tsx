import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DismissedCountButton, DismissedSheet, type DismissedItem } from '../dismissed-sheet';

const item = (over: Partial<DismissedItem> = {}): DismissedItem => ({ id: 1, title: 'Port exposure unclear', meta: 'dismissed by alice', ...over });

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

  it('says so when nothing is dismissed', () => {
    render(<DismissedSheet open onOpenChange={() => {}} crumb={['Security', 'Overview']} items={[]} />);
    expect(screen.getByText('Nothing is dismissed.')).toBeInTheDocument();
  });
});
