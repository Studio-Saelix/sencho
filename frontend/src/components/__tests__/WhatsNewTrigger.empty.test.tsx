import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

// Separate file so entries can be mocked empty at module scope, matching the
// state that actually ships until the first entry is authored.
vi.mock('@/whats-new/entries', () => ({ whatsNewEntries: [] }));
vi.mock('@/hooks/useWhatsNewPreference', () => ({
  useWhatsNewPreference: () => ({ enabled: true, hasUnseen: false, setEnabled: vi.fn(), markSeen: vi.fn() }),
}));

import { WhatsNewTrigger } from '../WhatsNewTrigger';

describe('WhatsNewTrigger with no entries authored', () => {
  it('stays out of the top bar entirely, even with the preference enabled', () => {
    render(<WhatsNewTrigger onClick={vi.fn()} />);
    expect(screen.queryByRole('button', { name: "What's new" })).not.toBeInTheDocument();
  });
});
