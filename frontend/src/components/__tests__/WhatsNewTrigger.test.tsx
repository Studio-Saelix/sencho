import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const mockPreference = vi.fn();
vi.mock('@/hooks/useWhatsNewPreference', () => ({
  useWhatsNewPreference: () => mockPreference(),
}));

// The committed entries.json is empty, which the trigger treats as "nothing to
// announce". Every case below except the empty-file one needs an entry to exist.
vi.mock('@/whats-new/entries', () => ({
  whatsNewEntries: [{ id: 'entry-a', title: 'A feature', blurb: 'Does a thing.' }],
}));

import { WhatsNewTrigger } from '../WhatsNewTrigger';

function givenPreference(enabled: boolean, hasUnseen: boolean) {
  mockPreference.mockReturnValue({ enabled, hasUnseen, setEnabled: vi.fn(), markSeen: vi.fn() });
}

describe('WhatsNewTrigger', () => {
  it('breathes when enabled and there are unseen entries', () => {
    givenPreference(true, true);
    render(<WhatsNewTrigger onClick={vi.fn()} />);
    const icon = screen.getByRole('button', { name: "What's new" }).querySelector('svg');
    expect(icon).toHaveClass('animate-whats-new-breathe');
  });

  it('renders nothing at all when the preference is disabled', () => {
    givenPreference(false, true);
    render(<WhatsNewTrigger onClick={vi.fn()} />);
    expect(screen.queryByRole('button', { name: "What's new" })).not.toBeInTheDocument();
  });

  it('does not breathe when there is nothing unseen', () => {
    givenPreference(true, false);
    render(<WhatsNewTrigger onClick={vi.fn()} />);
    const icon = screen.getByRole('button', { name: "What's new" }).querySelector('svg');
    expect(icon).not.toHaveClass('animate-whats-new-breathe');
  });

  it('opens the modal when clicked', async () => {
    givenPreference(true, false);
    const onClick = vi.fn();
    render(<WhatsNewTrigger onClick={onClick} />);
    await userEvent.click(screen.getByRole('button', { name: "What's new" }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('exposes a visible keyboard focus state', () => {
    givenPreference(true, false);
    render(<WhatsNewTrigger onClick={vi.fn()} />);
    expect(screen.getByRole('button', { name: "What's new" })).toHaveClass('focus-visible:ring-2');
  });
});
