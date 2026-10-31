import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
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

function notesResponse(version: string | null, releaseNotes: string | null, htmlUrl: string | null = 'https://github.com/o/r/releases/tag/v0.98.1') {
  return { ok: true, json: async () => ({ version, releaseNotes, htmlUrl }) };
}

const WITH_HIGHLIGHTS = '### Highlights\n\n<!-- highlights-hash: 0123456789abcdef -->\n\nCordon is here.\n\n### Added\n\n* a change';
const NO_HIGHLIGHTS = '### Added\n\n* a change';

const noop = () => {};

describe('WhatsNewModal', () => {
  beforeEach(() => {
    mockSetEnabled.mockClear();
    mockMarkSeen.mockClear();
    mockApiFetch.mockReset();
    givenVersion('0.98.1');
    mockApiFetch.mockResolvedValue(notesResponse('0.98.1', WITH_HIGHLIGHTS));
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('asks the local hub for the running version and shows its highlights only', async () => {
    render(<WhatsNewModal open onOpenChange={noop} onViewChangelog={noop} />);
    expect(await screen.findByText('Cordon is here.')).toBeInTheDocument();
    expect(mockApiFetch).toHaveBeenCalledWith(
      '/fleet/update-status/release-notes?version=0.98.1',
      { localOnly: true },
    );
    expect(screen.getByText(/Release v?0\.98\.1/)).toBeInTheDocument();
    // The change list below the block belongs to the Changelog tab, not here.
    expect(screen.queryByText('a change')).not.toBeInTheDocument();
    expect(screen.queryByText(/highlights-hash/)).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: /View on GitHub/ })).toHaveAttribute(
      'href',
      'https://github.com/o/r/releases/tag/v0.98.1',
    );
  });

  it('says so when the release has no highlights', async () => {
    mockApiFetch.mockResolvedValue(notesResponse('0.98.1', NO_HIGHLIGHTS));
    render(<WhatsNewModal open onOpenChange={noop} onViewChangelog={noop} />);
    expect(await screen.findByText(/no highlights/i)).toBeInTheDocument();
  });

  it('shows the error state, not "no highlights", when the hub cannot load the release (502)', async () => {
    mockApiFetch.mockResolvedValue({ ok: false, status: 502, json: async () => ({ error: 'Release notes unavailable' }) });
    render(<WhatsNewModal open onOpenChange={noop} onViewChangelog={noop} />);
    expect(await screen.findByText(/could not be loaded/i)).toBeInTheDocument();
    expect(screen.queryByText(/no highlights/i)).not.toBeInTheDocument();
  });

  it('treats an answer for another version, or for none, as a failed load', async () => {
    mockApiFetch.mockResolvedValue(notesResponse(null, null, null));
    const { unmount } = render(<WhatsNewModal open onOpenChange={noop} onViewChangelog={noop} />);
    expect(await screen.findByText(/could not be loaded/i)).toBeInTheDocument();
    unmount();

    mockApiFetch.mockResolvedValue(notesResponse('0.99.0', WITH_HIGHLIGHTS));
    render(<WhatsNewModal open onOpenChange={noop} onViewChangelog={noop} />);
    expect(await screen.findByText(/could not be loaded/i)).toBeInTheDocument();
    expect(screen.queryByText('Cordon is here.')).not.toBeInTheDocument();
  });

  it('retries a failed load on the next open and does not fetch in a loop meanwhile', async () => {
    mockApiFetch.mockResolvedValueOnce({ ok: false, status: 502, json: async () => ({}) });
    const { rerender } = render(<WhatsNewModal open onOpenChange={noop} onViewChangelog={noop} />);
    expect(await screen.findByText(/could not be loaded/i)).toBeInTheDocument();
    expect(mockApiFetch).toHaveBeenCalledTimes(1);

    rerender(<WhatsNewModal open={false} onOpenChange={noop} onViewChangelog={noop} />);
    rerender(<WhatsNewModal open onOpenChange={noop} onViewChangelog={noop} />);
    expect(await screen.findByText('Cordon is here.')).toBeInTheDocument();
    expect(mockApiFetch).toHaveBeenCalledTimes(2);
  });

  it('looks again on the next open when the release had no highlights yet', async () => {
    mockApiFetch.mockResolvedValueOnce(notesResponse('0.98.1', NO_HIGHLIGHTS));
    const { rerender } = render(<WhatsNewModal open onOpenChange={noop} onViewChangelog={noop} />);
    expect(await screen.findByText(/no highlights/i)).toBeInTheDocument();

    rerender(<WhatsNewModal open={false} onOpenChange={noop} onViewChangelog={noop} />);
    rerender(<WhatsNewModal open onOpenChange={noop} onViewChangelog={noop} />);
    expect(await screen.findByText('Cordon is here.')).toBeInTheDocument();
    expect(mockApiFetch).toHaveBeenCalledTimes(2);
  });

  it('does not refetch when reopened after highlights loaded', async () => {
    const { rerender } = render(<WhatsNewModal open onOpenChange={noop} onViewChangelog={noop} />);
    await screen.findByText('Cordon is here.');
    rerender(<WhatsNewModal open={false} onOpenChange={noop} onViewChangelog={noop} />);
    rerender(<WhatsNewModal open onOpenChange={noop} onViewChangelog={noop} />);
    await screen.findByText('Cordon is here.');
    expect(mockApiFetch).toHaveBeenCalledTimes(1);
  });

  it('ignores a response that arrives after the version changed', async () => {
    let resolveOld: (value: unknown) => void = noop;
    mockApiFetch
      .mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }))
      .mockResolvedValueOnce(notesResponse('0.99.0', '### Highlights\n\nNew release text.'));
    const { rerender } = render(<WhatsNewModal open onOpenChange={noop} onViewChangelog={noop} />);

    givenVersion('0.99.0');
    rerender(<WhatsNewModal open onOpenChange={noop} onViewChangelog={noop} />);
    expect(await screen.findByText('New release text.')).toBeInTheDocument();

    await act(async () => {
      resolveOld(notesResponse('0.98.1', WITH_HIGHLIGHTS));
    });
    expect(screen.getByText('New release text.')).toBeInTheDocument();
    expect(screen.queryByText('Cordon is here.')).not.toBeInTheDocument();
  });

  it('ignores a response that arrives after the modal was closed and reopened on a failure', async () => {
    let resolveFirst: (value: unknown) => void = noop;
    mockApiFetch
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }))
      .mockResolvedValueOnce({ ok: false, status: 502, json: async () => ({}) });
    const { rerender } = render(<WhatsNewModal open onOpenChange={noop} onViewChangelog={noop} />);
    rerender(<WhatsNewModal open={false} onOpenChange={noop} onViewChangelog={noop} />);
    rerender(<WhatsNewModal open onOpenChange={noop} onViewChangelog={noop} />);
    expect(await screen.findByText(/could not be loaded/i)).toBeInTheDocument();

    await act(async () => {
      resolveFirst(notesResponse('0.98.1', WITH_HIGHLIGHTS));
    });
    expect(screen.getByText(/could not be loaded/i)).toBeInTheDocument();
    expect(screen.queryByText('Cordon is here.')).not.toBeInTheDocument();
  });

  it('does not fetch while closed or without a stable version', () => {
    render(<WhatsNewModal open={false} onOpenChange={noop} onViewChangelog={noop} />);
    expect(mockApiFetch).not.toHaveBeenCalled();
    givenVersion(null);
    render(<WhatsNewModal open onOpenChange={noop} onViewChangelog={noop} />);
    expect(mockApiFetch).not.toHaveBeenCalled();
  });

  it('marks the release seen once its notes loaded, not before and not on a failed load', async () => {
    let resolveNotes: (value: unknown) => void = noop;
    mockApiFetch.mockImplementationOnce(() => new Promise((resolve) => { resolveNotes = resolve; }));
    render(<WhatsNewModal open onOpenChange={noop} onViewChangelog={noop} />);
    expect(mockMarkSeen).not.toHaveBeenCalled();
    await act(async () => {
      resolveNotes(notesResponse('0.98.1', WITH_HIGHLIGHTS));
    });
    await waitFor(() => expect(mockMarkSeen).toHaveBeenCalledTimes(1));

    mockMarkSeen.mockClear();
    mockApiFetch.mockResolvedValue({ ok: false, status: 502, json: async () => ({}) });
    givenVersion('0.99.0');
    render(<WhatsNewModal open onOpenChange={noop} onViewChangelog={noop} />);
    expect(await screen.findByText(/could not be loaded/i)).toBeInTheDocument();
    expect(mockMarkSeen).not.toHaveBeenCalled();
  });

  it('"Got it" closes the modal without disabling the feature', async () => {
    const onOpenChange = vi.fn();
    render(<WhatsNewModal open onOpenChange={onOpenChange} onViewChangelog={noop} />);
    await userEvent.click(screen.getByRole('button', { name: 'Got it' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(mockSetEnabled).not.toHaveBeenCalled();
  });

  it('"Never show again" disables the feature and closes the modal', async () => {
    const onOpenChange = vi.fn();
    render(<WhatsNewModal open onOpenChange={onOpenChange} onViewChangelog={noop} />);
    await userEvent.click(screen.getByRole('button', { name: 'Never show again' }));
    expect(mockSetEnabled).toHaveBeenCalledWith(false);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('"View full changelog" calls onViewChangelog', async () => {
    const onViewChangelog = vi.fn();
    render(<WhatsNewModal open onOpenChange={noop} onViewChangelog={onViewChangelog} />);
    await userEvent.click(screen.getByRole('button', { name: 'View full changelog' }));
    expect(onViewChangelog).toHaveBeenCalledTimes(1);
  });
});
