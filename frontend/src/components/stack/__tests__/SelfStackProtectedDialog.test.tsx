import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SelfStackProtectedDialog } from '../SelfStackProtectedDialog';

function renderDialog(over: Partial<React.ComponentProps<typeof SelfStackProtectedDialog>> = {}) {
  const props = {
    open: true,
    onOpenChange: vi.fn(),
    onReapply: undefined as (() => Promise<void>) | undefined,
    canOpenFleetUpdates: false,
    onOpenFleetUpdates: vi.fn(),
    ...over,
  };
  render(<SelfStackProtectedDialog {...props} />);
  return props;
}

describe('SelfStackProtectedDialog', () => {
  it('is the Reapply confirm when the caller can reapply, without a trip to Fleet', () => {
    const onReapply = vi.fn().mockResolvedValue(undefined);
    const props = renderDialog({ onReapply, canOpenFleetUpdates: true });

    expect(screen.getByRole('heading', { name: 'Reapply Sencho' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Reapply & restart/ }));

    expect(onReapply).toHaveBeenCalledTimes(1);
    expect(props.onOpenFleetUpdates).not.toHaveBeenCalled();
  });

  it('says Reapply recreates Sencho alone and leaves its depends_on services running', () => {
    renderDialog({ onReapply: vi.fn().mockResolvedValue(undefined) });

    const copy = screen.getByText(/Reapply recreates Sencho/).textContent ?? '';
    expect(copy).toMatch(/without recreating the services it lists in\s+depends_on/);
    expect(copy).toMatch(/Docker socket proxy/);
  });

  it('stays open after confirming until the handler closes it, so a not-ready node can be retried', async () => {
    const onReapply = vi.fn().mockResolvedValue(undefined);
    const props = renderDialog({ onReapply });

    fireEvent.click(screen.getByRole('button', { name: /Reapply & restart/ }));
    fireEvent.click(screen.getByRole('button', { name: /Reapply & restart/ }));

    expect(onReapply).toHaveBeenCalledTimes(2);
    expect(props.onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByRole('heading', { name: 'Reapply Sencho' })).toBeInTheDocument();
  });

  it('does not reapply when the dialog is cancelled', () => {
    const onReapply = vi.fn();
    renderDialog({ onReapply });

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(onReapply).not.toHaveBeenCalled();
  });

  it('keeps the Fleet link for callers who cannot reapply', () => {
    const props = renderDialog({ canOpenFleetUpdates: true });

    fireEvent.click(screen.getByRole('button', { name: /Open Fleet node updates/ }));

    expect(props.onOpenFleetUpdates).toHaveBeenCalledTimes(1);
  });

  it('is informational for callers with neither', () => {
    const props = renderDialog({ canOpenFleetUpdates: false });

    fireEvent.click(screen.getByRole('button', { name: 'Got it' }));

    expect(props.onOpenFleetUpdates).not.toHaveBeenCalled();
  });

  it('names the node and the reason when Reapply is unavailable', () => {
    renderDialog({ unavailable: { nodeName: 'sencho-nas', reason: 'container_unidentified' } });

    const copy = screen.getByText(/sencho-nas could not identify its own container/).textContent ?? '';
    expect(copy).toMatch(/retrying/);
    expect(screen.queryByText(/Eligible admins can use Save & Reapply/)).toBeNull();
  });

  it('renders every bounded reason without leaking the code itself', () => {
    const reasons = [
      'not_in_container',
      'container_unidentified',
      'docker_unreachable',
      'not_compose_managed',
      'compose_cli_unavailable',
      'image_unknown',
      'detecting',
      'node_unreachable',
      'node_outdated',
    ] as const;
    for (const reason of reasons) {
      const { unmount } = render(
        <SelfStackProtectedDialog
          open
          onOpenChange={vi.fn()}
          canOpenFleetUpdates={false}
          unavailable={{ nodeName: 'node-7', reason }}
        />,
      );
      expect(screen.getByText(/node-7/)).toBeInTheDocument();
      expect(screen.queryByText(new RegExp(reason))).toBeNull();
      unmount();
    }
  });

  it('keeps the generic copy when no reason was recorded', () => {
    renderDialog();

    expect(screen.getByText(/Eligible admins can use Save & Reapply/)).toBeInTheDocument();
  });
});
