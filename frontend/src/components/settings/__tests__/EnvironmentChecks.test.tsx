import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { EnvironmentChecks } from '../EnvironmentChecks';

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }));
vi.mock('@/components/ui/toast-store', () => ({ toast: { error: vi.fn() } }));

import { apiFetch } from '@/lib/api';

const ENV_REPORT = {
  checks: [
    { id: 'docker_socket' as const, label: 'Docker', status: 'pass' as const, detail: 'ok' },
  ],
  generatedAt: 1,
};

describe('EnvironmentChecks', () => {
  beforeEach(() => {
    vi.mocked(apiFetch).mockReset();
    vi.mocked(apiFetch).mockResolvedValue({
      ok: true,
      json: async () => ENV_REPORT,
    } as Response);
  });

  it('self-fetches on mount when uncontrolled', async () => {
    render(<EnvironmentChecks />);
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1));
    expect(apiFetch).toHaveBeenCalledWith('/diagnostics/environment', { localOnly: true });
    expect(screen.getByText('ok')).toBeTruthy();
  });

  it('does not fetch on mount when controlled', async () => {
    const onRerun = vi.fn();
    render(
      <EnvironmentChecks
        report={ENV_REPORT}
        isLoading={false}
        onRerun={onRerun}
      />,
    );
    await waitFor(() => expect(screen.getByText('ok')).toBeTruthy());
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('calls onRerun when Re-run is clicked in controlled mode', async () => {
    const onRerun = vi.fn();
    render(
      <EnvironmentChecks
        report={ENV_REPORT}
        isLoading={false}
        onRerun={onRerun}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /re-run/i }));
    expect(onRerun).toHaveBeenCalledTimes(1);
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('shows error state when controlled with null report', () => {
    render(
      <EnvironmentChecks
        report={null}
        isLoading={false}
        onRerun={vi.fn()}
      />,
    );
    expect(screen.getByText('Checks could not be run. Try again.')).toBeTruthy();
  });
});
