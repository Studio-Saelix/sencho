import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// vi.mock factories are hoisted above all other module-scope code, so a plain
// array literal referenced from the factory would hit a temporal-dead-zone
// ReferenceError; vi.hoisted() hoists the declaration itself alongside it.
const mockEntries = vi.hoisted(() => [
  { id: 'entry-a', title: 'First feature', blurb: 'Does the first thing.' },
  { id: 'entry-b', title: 'Second feature', blurb: 'Does the second thing.', docUrl: 'https://docs.sencho.io/features/second', screenshot: 'second.png' },
]);
vi.mock('@/whats-new/entries', () => ({ whatsNewEntries: mockEntries }));

const mockSetEnabled = vi.fn();
const mockMarkSeen = vi.fn();
vi.mock('@/hooks/useWhatsNewPreference', () => ({
  useWhatsNewPreference: () => ({ enabled: true, hasUnseen: true, setEnabled: mockSetEnabled, markSeen: mockMarkSeen }),
}));

import { WhatsNewModal } from '../WhatsNewModal';

describe('WhatsNewModal', () => {
  beforeEach(() => {
    mockSetEnabled.mockClear();
    mockMarkSeen.mockClear();
  });

  it('renders every entry, newest first, with title and blurb', () => {
    render(<WhatsNewModal open onOpenChange={vi.fn()} onViewChangelog={vi.fn()} />);
    const titles = screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent);
    expect(titles).toEqual(['Second feature', 'First feature']);
    expect(screen.getByText('Does the second thing.')).toBeInTheDocument();
  });

  it('renders a doc link and screenshot only for entries that have them', () => {
    render(<WhatsNewModal open onOpenChange={vi.fn()} onViewChangelog={vi.fn()} />);
    expect(screen.getAllByRole('link', { name: /Learn more/ })).toHaveLength(1);
    expect(screen.getAllByRole('img')).toHaveLength(1);
    expect(screen.getByRole('img')).toHaveAttribute('src', '/whats-new/second.png');
  });

  it('marks the newest entry seen when opened', () => {
    render(<WhatsNewModal open onOpenChange={vi.fn()} onViewChangelog={vi.fn()} />);
    expect(mockMarkSeen).toHaveBeenCalledTimes(1);
  });

  it('does not mark seen when closed', () => {
    render(<WhatsNewModal open={false} onOpenChange={vi.fn()} onViewChangelog={vi.fn()} />);
    expect(mockMarkSeen).not.toHaveBeenCalled();
  });

  it('"Never show again" disables the preference', async () => {
    render(<WhatsNewModal open onOpenChange={vi.fn()} onViewChangelog={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Never show again' }));
    expect(mockSetEnabled).toHaveBeenCalledWith(false);
  });

  it('"View full changelog" calls the callback', async () => {
    const onViewChangelog = vi.fn();
    render(<WhatsNewModal open onOpenChange={vi.fn()} onViewChangelog={onViewChangelog} />);
    await userEvent.click(screen.getByRole('button', { name: 'View full changelog' }));
    expect(onViewChangelog).toHaveBeenCalledTimes(1);
  });
});
