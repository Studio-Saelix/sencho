import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const mockSetEnabled = vi.fn();
const mockMarkSeen = vi.fn();
const mockPreference = vi.fn();
vi.mock('@/hooks/useWhatsNewPreference', () => ({
  useWhatsNewPreference: () => mockPreference(),
}));

const mockApiFetch = vi.fn();
vi.mock('@/lib/api', () => ({ apiFetch: (...args: unknown[]) => mockApiFetch(...args) }));

import { WhatsNewModal } from '../WhatsNewModal';

function givenVersion(version: string | null) {
  mockPreference.mockReturnValue({
    enabled: true,
    version,
    hasUnseen: true,
    setEnabled: mockSetEnabled,
    markSeen: mockMarkSeen,
  });
}

function givenNotes(releaseNotes: string | null, htmlUrl: string | null = 'https://github.com/o/r/releases/tag/v0.98.1') {
  mockApiFetch.mockResolvedValue({ ok: true, json: async () => ({ releaseNotes, htmlUrl }) });
}

const WITH_HIGHLIGHTS = '### Highlights\n\n<!-- highlights-hash: 0123456789abcdef -->\n\nCordon is here.\n\n### Added\n\n* a change';

describe('WhatsNewModal', () => {
  beforeEach(() => {
    mockSetEnabled.mockClear();
    mockMarkSeen.mockClear();
    mockApiFetch.mockReset();
    givenVersion('0.98.1');
    givenNotes(WITH_HIGHLIGHTS);
  });

  it('asks the local hub for the running version and shows its highlights only', async () => {
    render(<WhatsNewModal open onOpenChange={vi.fn()} onViewChangelog={vi.fn()} />);
    expect(await screen.findByText('Cordon is here.')).toBeInTheDocument();
    expect(mockApiFetch).toHaveBeenCalledWith(
      '/fleet/update-status/release-notes?version=0.98.1',
      { localOnly: true },
    );
    expect(screen.getByText(/Release v?0\.98\.1/)).toBeInTheDocument();
    // The change list below the block belongs to the Changelog tab, not here.
    expect(screen.queryByText('a change')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: /View on GitHub/ })).toHaveAttribute(
      'href',
      'https://github.com/o/r/releases/tag/v0.98.1',
    );
  });

  it('says so when the release has no highlights', async () => {
    givenNotes('### Added\n\n* a change');
    render(<WhatsNewModal open onOpenChange={vi.fn()} onViewChangelog={vi.fn()} />);
    expect(await screen.findByText(/no highlights/i)).toBeInTheDocument();
  });

  it('shows an error state when the lookup fails, and retries on the next open', async () => {
    mockApiFetch.mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { rerender } = render(<WhatsNewModal open onOpenChange={vi.fn()} onViewChangelog={vi.fn()} />);
    expect(await screen.findByText(/could not be loaded/i)).toBeInTheDocument();
    consoleError.mockRestore();

    rerender(<WhatsNewModal open={false} onOpenChange={vi.fn()} onViewChangelog={vi.fn()} />);
    rerender(<WhatsNewModal open onOpenChange={vi.fn()} onViewChangelog={vi.fn()} />);
    expect(await screen.findByText('Cordon is here.')).toBeInTheDocument();
    expect(mockApiFetch).toHaveBeenCalledTimes(2);
  });

  it('does not refetch when reopened after a successful load', async () => {
    const { rerender } = render(<WhatsNewModal open onOpenChange={vi.fn()} onViewChangelog={vi.fn()} />);
    await screen.findByText('Cordon is here.');
    rerender(<WhatsNewModal open={false} onOpenChange={vi.fn()} onViewChangelog={vi.fn()} />);
    rerender(<WhatsNewModal open onOpenChange={vi.fn()} onViewChangelog={vi.fn()} />);
    await screen.findByText('Cordon is here.');
    expect(mockApiFetch).toHaveBeenCalledTimes(1);
  });

  it('does not fetch while closed or without a stable version', () => {
    render(<WhatsNewModal open={false} onOpenChange={vi.fn()} onViewChangelog={vi.fn()} />);
    expect(mockApiFetch).not.toHaveBeenCalled();
    givenVersion(null);
    render(<WhatsNewModal open onOpenChange={vi.fn()} onViewChangelog={vi.fn()} />);
    expect(mockApiFetch).not.toHaveBeenCalled();
  });

  it('marks the release seen when opened', async () => {
    render(<WhatsNewModal open onOpenChange={vi.fn()} onViewChangelog={vi.fn()} />);
    await waitFor(() => expect(mockMarkSeen).toHaveBeenCalledTimes(1));
  });

  it('"Got it" closes the modal without disabling the feature', async () => {
    const onOpenChange = vi.fn();
    render(<WhatsNewModal open onOpenChange={onOpenChange} onViewChangelog={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Got it' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(mockSetEnabled).not.toHaveBeenCalled();
  });

  it('"Never show again" disables the feature and closes the modal', async () => {
    const onOpenChange = vi.fn();
    render(<WhatsNewModal open onOpenChange={onOpenChange} onViewChangelog={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Never show again' }));
    expect(mockSetEnabled).toHaveBeenCalledWith(false);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('"View full changelog" calls onViewChangelog', async () => {
    const onViewChangelog = vi.fn();
    render(<WhatsNewModal open onOpenChange={vi.fn()} onViewChangelog={onViewChangelog} />);
    await userEvent.click(screen.getByRole('button', { name: 'View full changelog' }));
    expect(onViewChangelog).toHaveBeenCalledTimes(1);
  });
});
