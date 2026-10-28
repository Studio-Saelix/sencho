import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NotificationMuteMenu } from './NotificationMuteMenu';
import { createMuteFromNotification } from '@/lib/muteRules';
import type { NotificationItem } from '@/components/dashboard/types';

vi.mock('@/lib/muteRules', () => ({ createMuteFromNotification: vi.fn() }));

function notif(overrides: Partial<NotificationItem> = {}): NotificationItem {
  return {
    id: 1,
    nodeId: 1,
    level: 'error',
    message: 'web crashed',
    timestamp: 1,
    is_read: 0,
    ...overrides,
  } as NotificationItem;
}

async function openMenu() {
  await userEvent.click(screen.getByRole('button', { name: 'Mute options' }));
}

describe('NotificationMuteMenu', () => {
  beforeEach(() => vi.mocked(createMuteFromNotification).mockReset());

  it('offers only the similar preset for a row with no category or stack', async () => {
    render(<NotificationMuteMenu notif={notif()} />);
    await openMenu();
    expect(screen.getAllByRole('menuitem')).toHaveLength(1);
    await userEvent.click(screen.getByRole('menuitem'));
    expect(createMuteFromNotification).toHaveBeenCalledWith(expect.anything(), 'similar');
  });

  it('adds the category and stack presets when the row carries them', async () => {
    const row = notif({ category: 'monitor_alert', stack_name: 'web' });
    render(<NotificationMuteMenu notif={row} />);
    await openMenu();
    expect(screen.getAllByRole('menuitem')).toHaveLength(3);
    await userEvent.click(screen.getByRole('menuitem', { name: /stack/i }));
    expect(createMuteFromNotification).toHaveBeenCalledWith(row, 'stack');
  });
});
