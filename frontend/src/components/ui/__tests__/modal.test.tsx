import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentProps, ReactNode } from 'react';
import { ConfirmModal, Modal, ModalDestructiveHeader, ModalFooter, ModalHeader } from '../modal';
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

describe('HeaderShell title wrapping contract', () => {
  const LONG_WORD_TITLE = 'Prune Sencho-managed containers';

  function expectWordWrap(el: HTMLElement) {
    expect(el).toHaveClass('break-words');
    expect(el).toHaveClass('text-balance');
    expect(el).not.toHaveClass('break-all');
  }

  function renderHeaderInModal(variant: 'default' | 'destructive', title: ReactNode) {
    render(
      <Modal open onOpenChange={() => {}}>
        {variant === 'destructive' ? (
          <ModalDestructiveHeader kicker="RESOURCES" title={title} description="d" />
        ) : (
          <ModalHeader kicker="RESOURCES" title={title} description="d" />
        )}
      </Modal>,
    );
  }

  function renderHeaderInConfirm(variant: 'default' | 'destructive', title: ReactNode) {
    render(
      <ConfirmModal open onOpenChange={() => {}} variant={variant} kicker="RESOURCES" title={title} description="d" confirmLabel="Confirm" onConfirm={() => {}} />,
    );
  }

  it('wraps ModalHeader titles on word boundaries', () => {
    renderHeaderInModal('default', LONG_WORD_TITLE);
    expectWordWrap(screen.getByRole('heading', { name: LONG_WORD_TITLE }));
  });

  it('wraps ModalDestructiveHeader titles on word boundaries', () => {
    renderHeaderInModal('destructive', LONG_WORD_TITLE);
    expectWordWrap(screen.getByRole('heading', { name: LONG_WORD_TITLE }));
  });

  it('wraps ConfirmHeader titles on word boundaries', () => {
    renderHeaderInConfirm('default', LONG_WORD_TITLE);
    expectWordWrap(screen.getByRole('heading', { name: LONG_WORD_TITLE }));
  });

  it('wraps ConfirmDestructiveHeader titles on word boundaries', () => {
    renderHeaderInConfirm('destructive', LONG_WORD_TITLE);
    expectWordWrap(screen.getByRole('heading', { name: LONG_WORD_TITLE }));
  });

  it('keeps overflow safety for long unbroken tokens', () => {
    renderHeaderInConfirm('destructive', 'x'.repeat(200));
    expect(screen.getByRole('heading', { name: 'x'.repeat(200) })).toHaveClass('break-words');
  });

  it('leaves a normal short title on the standard contract', () => {
    renderHeaderInConfirm('default', 'Confirm?');
    expectWordWrap(screen.getByRole('heading', { name: 'Confirm?' }));
  });
});
