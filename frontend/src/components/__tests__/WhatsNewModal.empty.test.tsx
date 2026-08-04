import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('@/whats-new/entries', () => ({ whatsNewEntries: [] }));
vi.mock('@/hooks/useWhatsNewPreference', () => ({
  useWhatsNewPreference: () => ({ enabled: true, hasUnseen: false, setEnabled: vi.fn(), markSeen: vi.fn() }),
}));

import { WhatsNewModal } from '../WhatsNewModal';

describe('WhatsNewModal with no entries', () => {
  it('shows an empty state instead of an empty list', () => {
    render(<WhatsNewModal open onOpenChange={vi.fn()} onViewChangelog={vi.fn()} />);
    expect(screen.getByText('Nothing new to show yet.')).toBeInTheDocument();
  });
});
