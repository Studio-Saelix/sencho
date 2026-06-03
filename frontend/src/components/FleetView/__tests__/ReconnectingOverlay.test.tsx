import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';

import { ReconnectingOverlay } from '../ReconnectingOverlay';

beforeEach(() => {
  vi.useFakeTimers();
  // Health poll resolves with a startedAt equal to the captured one so the
  // overlay never triggers a reload during these timing assertions.
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(
    new Response(JSON.stringify({ startedAt: 1000 }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
  )));
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('ReconnectingOverlay', () => {
  it('shows the in-progress state before the timeout', () => {
    render(<ReconnectingOverlay preUpdateStartedAt={1000} />);
    expect(screen.getByText('Updating Sencho...')).toBeInTheDocument();
    expect(screen.queryByText('Taking longer than expected')).not.toBeInTheDocument();
  });

  it('switches to a non-failure "taking longer" state at the 5 minute mark', async () => {
    render(<ReconnectingOverlay preUpdateStartedAt={1000} />);

    // Advance to the 5-minute reconnect budget.
    await act(async () => { await vi.advanceTimersByTimeAsync(5 * 60 * 1000); });

    expect(screen.getByText('Taking longer than expected')).toBeInTheDocument();
    // The copy must not assert failure; it offers a reload affordance.
    expect(screen.getByRole('button', { name: 'Reload to check' })).toBeInTheDocument();
    expect(screen.queryByText('Update timed out')).not.toBeInTheDocument();
  });
});
