import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// vi.mock factories are hoisted above all other module-scope code, so a plain
// array literal referenced from the factory would hit a temporal-dead-zone
// ReferenceError; vi.hoisted() hoists the declaration itself alongside it.
const mockEntries = vi.hoisted(() => [
  { id: 'entry-a', title: 'First feature', blurb: 'Does the first thing.', screenshot: 'first.png' },
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

  it('renders a doc link only for entries that have one, and a screenshot for each that does', () => {
    render(<WhatsNewModal open onOpenChange={vi.fn()} onViewChangelog={vi.fn()} />);
    expect(screen.getAllByRole('link', { name: /Learn more/ })).toHaveLength(1);
    expect(screen.getAllByRole('img').map((i) => i.getAttribute('src'))).toEqual([
      '/whats-new/second.png',
      '/whats-new/first.png',
    ]);
  });

  it('drops only the screenshot that fails to load, leaving the rest of the entry and other images intact', () => {
    render(<WhatsNewModal open onOpenChange={vi.fn()} onViewChangelog={vi.fn()} />);
    fireEvent.error(screen.getByAltText('Second feature'));
    expect(screen.queryByAltText('Second feature')).not.toBeInTheDocument();
    // A sibling entry's screenshot must survive, which is what makes the
    // failure set per-entry rather than a single global flag.
    expect(screen.getByAltText('First feature')).toBeInTheDocument();
    // The failed entry keeps everything except its image.
    expect(screen.getByText('Does the second thing.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Learn more/ })).toBeInTheDocument();
  });

  it('marks the newest entry seen when opened', () => {
    render(<WhatsNewModal open onOpenChange={vi.fn()} onViewChangelog={vi.fn()} />);
    expect(mockMarkSeen).toHaveBeenCalledTimes(1);
  });

  it('does not mark seen when closed', () => {
    render(<WhatsNewModal open={false} onOpenChange={vi.fn()} onViewChangelog={vi.fn()} />);
    expect(mockMarkSeen).not.toHaveBeenCalled();
  });

  it('"Never show again" disables the preference and closes the modal', async () => {
    const onOpenChange = vi.fn();
    render(<WhatsNewModal open onOpenChange={onOpenChange} onViewChangelog={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Never show again' }));
    expect(mockSetEnabled).toHaveBeenCalledWith(false);
    // The nav trigger disappears with the preference, so the modal must not
    // be left open behind it.
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('"Got it" closes the modal without touching the preference', async () => {
    const onOpenChange = vi.fn();
    render(<WhatsNewModal open onOpenChange={onOpenChange} onViewChangelog={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Got it' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(mockSetEnabled).not.toHaveBeenCalled();
  });

  it('"View full changelog" calls the callback', async () => {
    const onViewChangelog = vi.fn();
    render(<WhatsNewModal open onOpenChange={vi.fn()} onViewChangelog={onViewChangelog} />);
    await userEvent.click(screen.getByRole('button', { name: 'View full changelog' }));
    expect(onViewChangelog).toHaveBeenCalledTimes(1);
  });

  it('clicking a screenshot opens a zoomed overlay with the same image', async () => {
    render(<WhatsNewModal open onOpenChange={vi.fn()} onViewChangelog={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Zoom in on Second feature screenshot' }));
    const zoomed = screen.getByRole('dialog', { name: 'Zoomed screenshot' });
    expect(zoomed.querySelector('img')).toHaveAttribute('src', '/whats-new/second.png');
  });

  it('the close button dismisses only the zoom overlay, leaving the parent modal open', async () => {
    const onOpenChange = vi.fn();
    render(<WhatsNewModal open onOpenChange={onOpenChange} onViewChangelog={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Zoom in on Second feature screenshot' }));
    await userEvent.click(screen.getByRole('button', { name: 'Close zoomed screenshot' }));
    expect(screen.queryByRole('dialog', { name: 'Zoomed screenshot' })).not.toBeInTheDocument();
    // The regression this guards against: an earlier implementation portaled
    // the overlay to document.body, outside Radix's Dialog content subtree,
    // so Radix treated every zoom-dismiss click as an outside click and also
    // closed the parent. If that regressed, onOpenChange(false) fires here.
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: "What's New" })).toBeInTheDocument();
  });

  it('clicking the backdrop dismisses only the zoom overlay, leaving the parent modal open', async () => {
    const onOpenChange = vi.fn();
    render(<WhatsNewModal open onOpenChange={onOpenChange} onViewChangelog={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Zoom in on Second feature screenshot' }));
    await userEvent.click(screen.getByRole('dialog', { name: 'Zoomed screenshot' }));
    expect(screen.queryByRole('dialog', { name: 'Zoomed screenshot' })).not.toBeInTheDocument();
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: "What's New" })).toBeInTheDocument();
  });

  it('Escape dismisses only the zoom overlay, leaving the parent modal open', async () => {
    const onOpenChange = vi.fn();
    render(<WhatsNewModal open onOpenChange={onOpenChange} onViewChangelog={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Zoom in on Second feature screenshot' }));
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Zoomed screenshot' })).not.toBeInTheDocument();
    // Radix's own Escape handling for the parent Dialog is a document-level
    // capture listener; without stopPropagation this fires too and also
    // requests the parent close.
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: "What's New" })).toBeInTheDocument();
  });
});
