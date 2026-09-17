import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentProps } from 'react';
import { ConfirmModal, ModalFooter } from '../modal';
import { DURATION_BASE_MS } from '@/hooks/useVisualBusy';

function renderConfirm(props: Partial<ComponentProps<typeof ConfirmModal>> = {}) {
  const onOpenChange = vi.fn();
  const onConfirm = vi.fn();
  render(
    <ConfirmModal
      open
      onOpenChange={onOpenChange}
      kicker="TEST"
      title="Confirm?"
      confirmLabel="Delete"
      busyConfirmLabel="Deleting..."
      onConfirm={onConfirm}
      {...props}
    />,
  );
  return { onOpenChange, onConfirm };
}

describe('ConfirmModal busy behaviour', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps the dialog open for async onConfirm', async () => {
    let resolveConfirm!: () => void;
    const pending = new Promise<void>((resolve) => {
      resolveConfirm = resolve;
    });
    const onConfirm = vi.fn(() => pending);
    const onOpenChange = vi.fn();

    render(
      <ConfirmModal
        open
        onOpenChange={onOpenChange}
        kicker="TEST"
        title="Confirm?"
        confirmLabel="Delete"
        onConfirm={onConfirm}
        confirming={false}
      />,
    );

    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    // Radix would otherwise close; preventDefault keeps it open so parent can set confirming.
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    resolveConfirm();
    await act(async () => {
      await pending;
    });
  });

  it('disables only Confirm when confirmDisabled is set without confirming', () => {
    renderConfirm({ confirmDisabled: true, confirming: false });
    expect(screen.getByRole('button', { name: 'Delete' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).not.toBeDisabled();
  });

  it('disables both Confirm and Cancel when confirming', () => {
    renderConfirm({ confirming: true });
    expect(screen.getByRole('button', { name: /Delete/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
  });

  it('does not call onOpenChange(false) on Escape while confirming', async () => {
    const { onOpenChange } = renderConfirm({ confirming: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await user.keyboard('{Escape}');
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it('shows progressive busy label after the delay when confirming', async () => {
    renderConfirm({ confirming: true });
    act(() => {
      vi.advanceTimersByTime(DURATION_BASE_MS);
    });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Deleting/i })).toBeInTheDocument();
    });
  });
});

describe('ModalFooter containment contract', () => {
  function renderFooter() {
    render(
      <ModalFooter
        hint="PARENT"
        hintAccent={'x'.repeat(100)}
        secondary={<button>Cancel</button>}
        primary={<button>Create</button>}
      />,
    );
  }

  it('renders secondary before primary in a non-shrinking action group', () => {
    renderFooter();
    const cancel = screen.getByRole('button', { name: 'Cancel' });
    const create = screen.getByRole('button', { name: 'Create' });
    expect(cancel.compareDocumentPosition(create) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(create.parentElement).toHaveClass('shrink-0');
  });

  it('lets the hint side shrink and wrap long unbroken values', () => {
    renderFooter();
    const hintWrapper = screen.getByText('x'.repeat(100)).parentElement;
    expect(hintWrapper).toHaveClass('min-w-0');
    expect(hintWrapper).toHaveClass('wrap-anywhere');
    // The footer may flow to a second row instead of pushing the actions out.
    expect(hintWrapper?.parentElement).toHaveClass('flex-wrap');
  });
});
