import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const cordonNode = vi.fn();
const uncordonNode = vi.fn();
const toastMock = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('@/lib/nodesApi', () => ({ cordonNode: (...a: unknown[]) => cordonNode(...a), uncordonNode: (...a: unknown[]) => uncordonNode(...a) }));
vi.mock('@/components/ui/toast-store', () => ({ toast: toastMock }));

import { NodeCordonModal } from '../NodeCordonModal';

function renderModal(cordoned = false, overrides: Partial<React.ComponentProps<typeof NodeCordonModal>> = {}) {
  const props = {
    node: { id: 2, name: 'Edge', cordoned },
    open: true,
    onOpenChange: vi.fn(),
    onChanged: vi.fn(),
    ...overrides,
  };
  render(<NodeCordonModal {...props} />);
  return props;
}

afterEach(() => vi.clearAllMocks());

describe('NodeCordonModal', () => {
  it('cordons with the trimmed reason, then closes and refreshes', async () => {
    cordonNode.mockResolvedValue({});
    const props = renderModal();
    await userEvent.type(screen.getByLabelText(/Reason/), '  draining  ');
    await userEvent.click(screen.getByRole('button', { name: 'Cordon node' }));
    await vi.waitFor(() => expect(props.onChanged).toHaveBeenCalledTimes(1));
    expect(cordonNode).toHaveBeenCalledWith(2, 'draining');
    expect(toastMock.success).toHaveBeenCalledWith('Cordoned Edge');
    expect(props.onOpenChange).toHaveBeenCalledWith(false);
  });

  it('sends a null reason when none was typed', async () => {
    cordonNode.mockResolvedValue({});
    renderModal();
    await userEvent.click(screen.getByRole('button', { name: 'Cordon node' }));
    await vi.waitFor(() => expect(cordonNode).toHaveBeenCalledWith(2, null));
  });

  it('uncordons without asking for a reason', async () => {
    uncordonNode.mockResolvedValue({});
    const props = renderModal(true);
    expect(screen.queryByLabelText(/Reason/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Uncordon node' }));
    await vi.waitFor(() => expect(props.onChanged).toHaveBeenCalledTimes(1));
    expect(uncordonNode).toHaveBeenCalledWith(2);
    expect(toastMock.success).toHaveBeenCalledWith('Uncordoned Edge');
  });

  it('stays open, keeps the reason, logs and reports the failure', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    cordonNode.mockRejectedValue(new Error('Forbidden'));
    const props = renderModal();
    await userEvent.type(screen.getByLabelText(/Reason/), 'maintenance');
    await userEvent.click(screen.getByRole('button', { name: 'Cordon node' }));
    await vi.waitFor(() => expect(toastMock.error).toHaveBeenCalledWith('Forbidden'));
    expect(props.onOpenChange).not.toHaveBeenCalledWith(false);
    expect(props.onChanged).not.toHaveBeenCalled();
    expect(screen.getByLabelText(/Reason/)).toHaveValue('maintenance');
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('does not report a failure when the refresh callback throws after a successful cordon', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    cordonNode.mockResolvedValue({});
    const onChanged = vi.fn(() => { throw new Error('refresh failed'); });
    renderModal(false, { onChanged });
    await userEvent.click(screen.getByRole('button', { name: 'Cordon node' }));
    await vi.waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(toastMock.success).toHaveBeenCalledWith('Cordoned Edge');
    expect(toastMock.error).not.toHaveBeenCalled();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('opens empty again after a cancel, so a half-typed reason is not carried over', async () => {
    const onOpenChange = vi.fn();
    const { rerender } = render(<NodeCordonModal node={{ id: 2, name: 'Edge', cordoned: false }} open onOpenChange={onOpenChange} />);
    await userEvent.type(screen.getByLabelText(/Reason/), 'half typed');
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    rerender(<NodeCordonModal node={{ id: 2, name: 'Edge', cordoned: false }} open={false} onOpenChange={onOpenChange} />);
    rerender(<NodeCordonModal node={{ id: 2, name: 'Edge', cordoned: false }} open onOpenChange={onOpenChange} />);
    expect(screen.getByLabelText(/Reason/)).toHaveValue('');
  });

  it('cannot be dismissed while the request is in flight', async () => {
    let release: (v: unknown) => void = () => {};
    cordonNode.mockImplementation(() => new Promise((res) => { release = res; }));
    const props = renderModal();
    await userEvent.click(screen.getByRole('button', { name: 'Cordon node' }));
    await userEvent.keyboard('{Escape}');
    expect(props.onOpenChange).not.toHaveBeenCalled();
    release({});
    await vi.waitFor(() => expect(props.onChanged).toHaveBeenCalledTimes(1));
  });
});
