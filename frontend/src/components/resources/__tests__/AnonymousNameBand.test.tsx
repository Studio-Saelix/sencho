import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const { copyMock, toastMock } = vi.hoisted(() => ({
  copyMock: vi.fn(),
  toastMock: { success: vi.fn(), error: vi.fn() },
}));
vi.mock('@/lib/clipboard', () => ({ copyToClipboard: copyMock }));
vi.mock('@/components/ui/toast-store', () => ({ toast: toastMock }));

import { AnonymousNameBand } from '../AnonymousNameBand';

const ANON = '079dfda49f2c483f80f1d4f6b1865be55af54a0298507a0e588aae551134ba62';

describe('AnonymousNameBand', () => {
  beforeEach(() => {
    copyMock.mockReset();
    toastMock.success.mockReset();
    toastMock.error.mockReset();
  });

  it('shows the full hash and an anonymous chip', () => {
    render(<AnonymousNameBand name={ANON} />);
    expect(screen.getByText(ANON)).toBeInTheDocument();
    expect(screen.getByText('anonymous')).toBeInTheDocument();
  });

  it('copies the full hash, not the truncated label, and toasts success', async () => {
    copyMock.mockResolvedValue(undefined);
    render(<AnonymousNameBand name={ANON} />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy full volume name' }));
    await waitFor(() => expect(copyMock).toHaveBeenCalledWith(ANON));
    await waitFor(() => expect(toastMock.success).toHaveBeenCalled());
    expect(toastMock.error).not.toHaveBeenCalled();
  });

  it('toasts an error when the copy fails', async () => {
    copyMock.mockRejectedValue(new Error('clipboard unavailable'));
    render(<AnonymousNameBand name={ANON} />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy full volume name' }));
    await waitFor(() => expect(toastMock.error).toHaveBeenCalled());
    expect(toastMock.success).not.toHaveBeenCalled();
  });
});
