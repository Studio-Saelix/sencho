/**
 * Lock the Combobox component: flat-rendering regression guard, grouped-option
 * rendering, search filtering with groups, selection callback, and group-header
 * non-interactivity.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Combobox, type ComboboxOption } from '../combobox';

const FLAT_OPTIONS: ComboboxOption[] = [
  { value: 'a', label: 'Alpha' },
  { value: 'b', label: 'Beta' },
  { value: 'c', label: 'Gamma' },
];

const GROUPED_OPTIONS: ComboboxOption[] = [
  { value: 'r', label: 'Restart Stack', group: 'Lifecycle' },
  { value: 's', label: 'Stop Stack', group: 'Lifecycle' },
  { value: 'u', label: 'Auto-update Stack', group: 'Updates' },
  { value: 'p', label: 'Prune Node Resources', group: 'Maintenance' },
];

describe('Combobox', () => {
  it('renders flat options unchanged when no group field is present', async () => {
    const onChange = vi.fn();
    render(<Combobox options={FLAT_OPTIONS} value="" onValueChange={onChange} placeholder="Pick..." />);

    await userEvent.click(screen.getByRole('combobox'));

    expect(screen.getByRole('button', { name: 'Alpha' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Beta' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Gamma' })).toBeInTheDocument();
  });

  it('renders group headers in order of first appearance', async () => {
    const onChange = vi.fn();
    render(<Combobox options={GROUPED_OPTIONS} value="" onValueChange={onChange} placeholder="Pick..." />);

    await userEvent.click(screen.getByRole('combobox'));

    // Group headers rendered as non-interactive text.
    const headers = document.querySelectorAll('.text-xs.font-medium.text-muted-foreground');
    expect(headers).toHaveLength(3);
    expect(headers[0].textContent).toBe('Lifecycle');
    expect(headers[1].textContent).toBe('Updates');
    expect(headers[2].textContent).toBe('Maintenance');
  });

  it('search hides groups with no matching options', async () => {
    const onChange = vi.fn();
    render(<Combobox options={GROUPED_OPTIONS} value="" onValueChange={onChange} placeholder="Pick..." />);

    await userEvent.click(screen.getByRole('combobox'));

    // The inline search input appears when open; type "stop".
    const input = screen.getByRole('textbox');
    await userEvent.type(input, 'stop');

    // Only the Lifecycle header should remain visible.
    const headers = document.querySelectorAll('.text-xs.font-medium.text-muted-foreground');
    expect(headers).toHaveLength(1);
    expect(headers[0].textContent).toBe('Lifecycle');

    // Only Stop Stack should be visible.
    expect(screen.getByRole('button', { name: 'Stop Stack' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Restart Stack' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Auto-update Stack' })).not.toBeInTheDocument();
  });

  it('selecting a grouped option calls onValueChange', async () => {
    const onChange = vi.fn();
    render(<Combobox options={GROUPED_OPTIONS} value="" onValueChange={onChange} placeholder="Pick..." />);

    await userEvent.click(screen.getByRole('combobox'));
    await userEvent.click(screen.getByRole('button', { name: 'Prune Node Resources' }));

    expect(onChange).toHaveBeenCalledWith('p');
  });

  it('group headers are not interactive elements', async () => {
    const onChange = vi.fn();
    render(<Combobox options={GROUPED_OPTIONS} value="" onValueChange={onChange} placeholder="Pick..." />);

    await userEvent.click(screen.getByRole('combobox'));

    const headers = document.querySelectorAll('.text-xs.font-medium.text-muted-foreground');
    for (const h of headers) {
      expect(h.tagName).toBe('DIV');
      expect(h.getAttribute('role')).toBeNull();
    }
  });
});
