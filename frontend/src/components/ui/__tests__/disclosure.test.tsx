import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Disclosure } from '../disclosure';

describe('Disclosure', () => {
  it('is collapsed by default, wires aria-expanded and aria-controls, and toggles', async () => {
    const user = userEvent.setup();
    render(<Disclosure label="Details" contentTestId="body">evidence</Disclosure>);
    const trigger = screen.getByRole('button', { name: 'Details' });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByTestId('body')).not.toBeInTheDocument();
    await user.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    const body = screen.getByTestId('body');
    expect(trigger.getAttribute('aria-controls')).toBe(body.id);
    expect(body).toHaveTextContent('evidence');
    await user.click(trigger);
    expect(screen.queryByTestId('body')).not.toBeInTheDocument();
  });

  it('opens straight to its content with defaultOpen', () => {
    render(<Disclosure label="Node" defaultOpen contentTestId="body">items</Disclosure>);
    expect(screen.getByRole('button', { name: /Node/ })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByTestId('body')).toBeInTheDocument();
  });

  it('keeps the qualifier visible on the collapsed trigger', () => {
    render(<Disclosure variant="row" label="central" meta="1 failed">items</Disclosure>);
    expect(screen.getByRole('button', { name: /central/ })).toHaveTextContent('1 failed');
  });
});
