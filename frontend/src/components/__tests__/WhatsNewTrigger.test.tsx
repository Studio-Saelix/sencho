import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const mockPreference = vi.fn();
vi.mock('@/hooks/useWhatsNewPreference', () => ({
  useWhatsNewPreference: () => mockPreference(),
}));

import { WhatsNewTrigger } from '../WhatsNewTrigger';

describe('WhatsNewTrigger', () => {
  it('breathes when enabled and there are unseen entries', () => {
    mockPreference.mockReturnValue({ enabled: true, hasUnseen: true, setEnabled: vi.fn(), markSeen: vi.fn() });
    render(<WhatsNewTrigger onClick={vi.fn()} />);
    const icon = screen.getByRole('button', { name: "What's new" }).querySelector('svg');
    expect(icon).toHaveClass('animate-whats-new-breathe');
  });

  it('does not breathe when the preference is disabled', () => {
    mockPreference.mockReturnValue({ enabled: false, hasUnseen: true, setEnabled: vi.fn(), markSeen: vi.fn() });
    render(<WhatsNewTrigger onClick={vi.fn()} />);
    const icon = screen.getByRole('button', { name: "What's new" }).querySelector('svg');
    expect(icon).not.toHaveClass('animate-whats-new-breathe');
  });

  it('does not breathe when there is nothing unseen', () => {
    mockPreference.mockReturnValue({ enabled: true, hasUnseen: false, setEnabled: vi.fn(), markSeen: vi.fn() });
    render(<WhatsNewTrigger onClick={vi.fn()} />);
    const icon = screen.getByRole('button', { name: "What's new" }).querySelector('svg');
    expect(icon).not.toHaveClass('animate-whats-new-breathe');
  });

  it('is clickable even when disabled', async () => {
    mockPreference.mockReturnValue({ enabled: false, hasUnseen: false, setEnabled: vi.fn(), markSeen: vi.fn() });
    const onClick = vi.fn();
    render(<WhatsNewTrigger onClick={onClick} />);
    await userEvent.click(screen.getByRole('button', { name: "What's new" }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
