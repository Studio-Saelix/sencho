import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { Button } from '@/components/ui/button';
import { FindingRowActions } from '../finding-row-actions';

describe('FindingRowActions', () => {
  it('renders primary, Dismiss, then overflow in DOM order', () => {
    const { container } = render(
      <FindingRowActions
        dismissPolicy="any"
        canDismiss
        subject="Example finding"
        onDismiss={vi.fn()}
        overflow={
          <Button variant="ghost" size="icon" aria-label="More actions: Example finding" />
        }
      >
        <Button variant="outline" size="sm">Set intent</Button>
      </FindingRowActions>,
    );

    const cluster = container.firstElementChild;
    expect(cluster).not.toBeNull();
    const buttons = within(cluster as HTMLElement).getAllByRole('button');
    expect(buttons.map(button => button.textContent?.trim() || button.getAttribute('aria-label'))).toEqual([
      'Set intent',
      'Dismiss',
      'More ways to dismiss',
      'More actions: Example finding',
    ]);
  });

  it('omits Dismiss when dismissPolicy is none', () => {
    render(
      <FindingRowActions dismissPolicy="none" canDismiss subject="x" onDismiss={vi.fn()}>
        <Button variant="outline" size="sm">Verb</Button>
      </FindingRowActions>,
    );
    expect(screen.queryByRole('button', { name: 'Dismiss: x' })).not.toBeInTheDocument();
  });

  it('omits overflow when the slot is empty', () => {
    render(
      <FindingRowActions dismissPolicy="any" canDismiss subject="x" onDismiss={vi.fn()}>
        <Button variant="outline" size="sm">Verb</Button>
      </FindingRowActions>,
    );
    expect(screen.queryByRole('button', { name: /More actions/ })).not.toBeInTheDocument();
  });
});
