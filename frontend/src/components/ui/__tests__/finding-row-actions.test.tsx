import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FindingRowActions, type FindingRowMoreItem } from '../finding-row-actions';

const SUBJECT = 'Shared network';

function renderRow({
  verb = true,
  canDismiss = true,
  more,
  onDismiss = vi.fn(),
  pending = false,
}: { verb?: boolean; canDismiss?: boolean; more?: FindingRowMoreItem[]; onDismiss?: () => void; pending?: boolean } = {}) {
  return render(
    <FindingRowActions dismissPolicy="any" canDismiss={canDismiss} more={more} pending={pending} subject={SUBJECT} onDismiss={onDismiss}>
      {verb && <button type="button">Create network</button>}
    </FindingRowActions>,
  );
}

/** The accessible names of the controls a desktop viewer sees, in visual order. The phone menu is hidden at md and up. */
function desktopOrder(): string[] {
  return screen
    .getAllByRole('button')
    .map(button => button.getAttribute('aria-label') ?? button.textContent ?? '')
    .filter(name => name !== `Actions: ${SUBJECT}` && name !== 'Dismiss options');
}

const MORE: FindingRowMoreItem[] = [
  { label: 'Copy Docker command', onSelect: vi.fn() },
  { label: 'Open stack editor', onSelect: vi.fn() },
];

describe('FindingRowActions', () => {
  it('orders the verb, then Dismiss, then the overflow menu at the trailing edge', () => {
    renderRow({ more: MORE });
    expect(desktopOrder()).toEqual(['Create network', `Dismiss: ${SUBJECT}`, 'More ways to dismiss', `More actions: ${SUBJECT}`]);
  });

  it('keeps the overflow menu last when the verb is absent', () => {
    renderRow({ verb: false, more: MORE });
    expect(desktopOrder()).toEqual([`Dismiss: ${SUBJECT}`, 'More ways to dismiss', `More actions: ${SUBJECT}`]);
  });

  it('keeps the overflow menu last when Dismiss is not offered', () => {
    renderRow({ canDismiss: false, more: MORE });
    expect(desktopOrder()).toEqual(['Create network', `More actions: ${SUBJECT}`]);
  });

  it('keeps the trailing slot empty on a row with no secondary verbs, so Dismiss stays aligned', () => {
    renderRow({ more: [] });
    expect(desktopOrder()).toEqual(['Create network', `Dismiss: ${SUBJECT}`, 'More ways to dismiss']);
    expect(screen.queryByRole('button', { name: /More actions/ })).not.toBeInTheDocument();
    const slot = screen.getByTestId('finding-row-more-slot');
    expect(slot.previousElementSibling).toBe(screen.getByRole('button', { name: `Dismiss: ${SUBJECT}` }).parentElement);
  });

  it('reserves no slot on a surface without an overflow menu', () => {
    renderRow();
    expect(screen.queryByTestId('finding-row-more-slot')).not.toBeInTheDocument();
  });

  it('runs a secondary verb chosen from the overflow menu', async () => {
    const onSelect = vi.fn();
    renderRow({ more: [{ label: 'Copy Docker command', onSelect }] });
    await userEvent.click(screen.getByRole('button', { name: `More actions: ${SUBJECT}` }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Copy Docker command' }));
    expect(onSelect).toHaveBeenCalledOnce();
  });

  it('folds the secondary verbs and Dismiss into one trailing menu on a phone', async () => {
    const onDismiss = vi.fn();
    renderRow({ more: MORE, onDismiss });
    const buttons = screen.getAllByRole('button');
    expect(buttons[buttons.length - 1]).toHaveAccessibleName(`Actions: ${SUBJECT}`);
    await userEvent.click(screen.getByRole('button', { name: `Actions: ${SUBJECT}` }));
    const items = (await screen.findAllByRole('menuitem')).map(item => item.textContent);
    expect(items).toEqual([
      'Copy Docker command',
      'Open stack editor',
      'Dismiss until it changes',
      'Dismiss for 7 days',
      'Dismiss permanently',
    ]);
    await userEvent.click(screen.getByRole('menuitem', { name: 'Dismiss until it changes' }));
    expect(onDismiss).toHaveBeenCalledWith('until_change');
  });

  it.each([
    ['omitted', undefined],
    ['empty', [] as FindingRowMoreItem[]],
  ])('keeps the dismiss-only phone menu when `more` is %s', (_label, more) => {
    renderRow({ more });
    expect(screen.getByRole('button', { name: 'Dismiss options' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: `Actions: ${SUBJECT}` })).not.toBeInTheDocument();
  });

  it('offers only the secondary verbs on the phone when Dismiss is not allowed', async () => {
    renderRow({ canDismiss: false, more: MORE });
    await userEvent.click(screen.getByRole('button', { name: `Actions: ${SUBJECT}` }));
    const items = (await screen.findAllByRole('menuitem')).map(item => item.textContent);
    expect(items).toEqual(['Copy Docker command', 'Open stack editor']);
    expect(screen.queryByRole('separator')).not.toBeInTheDocument();
  });

  it('locks only Dismiss while one is in flight; the secondary verbs stay reachable', async () => {
    renderRow({ more: MORE, pending: true });
    expect(screen.getByRole('button', { name: `More actions: ${SUBJECT}` })).toBeEnabled();
    const phoneMenu = screen.getByRole('button', { name: `Actions: ${SUBJECT}` });
    expect(phoneMenu).toBeEnabled();
    await userEvent.click(phoneMenu);
    expect(await screen.findByRole('menuitem', { name: 'Copy Docker command' })).not.toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByRole('menuitem', { name: 'Dismiss for 7 days' })).toHaveAttribute('aria-disabled', 'true');
  });

  it('locks the dismiss-only phone menu while a dismiss is in flight', () => {
    renderRow({ pending: true });
    expect(screen.getByRole('button', { name: 'Dismiss options' })).toBeDisabled();
  });
});
