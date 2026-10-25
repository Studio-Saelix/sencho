import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SelfStackProtectedDialog } from '../SelfStackProtectedDialog';

function renderDialog(over: Partial<React.ComponentProps<typeof SelfStackProtectedDialog>> = {}) {
  const props = {
    open: true,
    onOpenChange: vi.fn(),
    canReapply: false,
    onReapply: vi.fn(),
    canOpenFleetUpdates: false,
    onOpenFleetUpdates: vi.fn(),
    ...over,
  };
  render(<SelfStackProtectedDialog {...props} />);
  return props;
}

describe('SelfStackProtectedDialog', () => {
  it('is the Reapply confirm when the caller can reapply, without a trip to Fleet', () => {
    const props = renderDialog({ canReapply: true, canOpenFleetUpdates: true });

    expect(screen.getByRole('heading', { name: 'Reapply Sencho' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Reapply & restart/ }));

    expect(props.onReapply).toHaveBeenCalledTimes(1);
    expect(props.onOpenFleetUpdates).not.toHaveBeenCalled();
    expect(props.onOpenChange).toHaveBeenCalledWith(false);
  });

  it('does not reapply when the dialog is cancelled', () => {
    const props = renderDialog({ canReapply: true });

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(props.onReapply).not.toHaveBeenCalled();
  });

  it('keeps the Fleet link for callers who cannot reapply', () => {
    const props = renderDialog({ canReapply: false, canOpenFleetUpdates: true });

    fireEvent.click(screen.getByRole('button', { name: /Open Fleet node updates/ }));

    expect(props.onOpenFleetUpdates).toHaveBeenCalledTimes(1);
    expect(props.onReapply).not.toHaveBeenCalled();
  });

  it('is informational for callers with neither', () => {
    const props = renderDialog({ canReapply: false, canOpenFleetUpdates: false });

    fireEvent.click(screen.getByRole('button', { name: 'Got it' }));

    expect(props.onReapply).not.toHaveBeenCalled();
    expect(props.onOpenFleetUpdates).not.toHaveBeenCalled();
  });
});
