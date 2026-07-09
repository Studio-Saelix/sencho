import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { Setup } from '../Setup';

const apiFetchMock = vi.fn();
vi.mock('@/lib/api', () => ({ apiFetch: (...args: unknown[]) => apiFetchMock(...args) }));
vi.mock('@/components/ui/toast-store', () => ({ toast: { error: vi.fn() } }));

const ENV_REPORT = {
  checks: [
    { id: 'compose_dir', label: 'Compose dir', status: 'pass', detail: '/opt/compose' },
    { id: 'docker_socket', label: 'Docker', status: 'pass', detail: 'ok' },
  ],
  generatedAt: 1,
  discovery: {
    composeDir: '/opt/compose',
    stackCount: 1,
    adoptCandidateCount: 2,
    adoptCandidatesTruncated: false,
  },
};

function jsonRes(body: unknown, ok = true) {
  return { ok, json: async () => body } as Response;
}

describe('Setup preflight', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
    vi.stubGlobal('fetch', vi.fn());
    sessionStorage.clear();
  });

  it('runs exactly one diagnostics fetch on the environment step', async () => {
    vi.mocked(fetch).mockResolvedValue(jsonRes({ success: true }));

    apiFetchMock.mockImplementation((path: string) => {
      if (path === '/diagnostics/environment') {
        return Promise.resolve(jsonRes(ENV_REPORT));
      }
      return Promise.resolve(jsonRes({}));
    });

    render(<Setup onComplete={vi.fn()} />);

    fireEvent.change(screen.getByLabelText(/username/i), { target: { value: 'admin' } });
    fireEvent.change(screen.getByLabelText(/^password$/i), { target: { value: 'password123' } });
    fireEvent.change(screen.getByLabelText(/confirm password/i), { target: { value: 'password123' } });
    fireEvent.click(screen.getByRole('button', { name: /initialize console/i }));

    await waitFor(() => expect(screen.getByText('Preflight')).toBeTruthy());

    await waitFor(() => {
      const envCalls = apiFetchMock.mock.calls.filter((c) => c[0] === '/diagnostics/environment');
      expect(envCalls).toHaveLength(1);
    });

    expect(apiFetchMock).not.toHaveBeenCalledWith('/stacks/discovery', expect.anything());
    expect(screen.getByText(/found/i)).toBeTruthy();
    expect(screen.getByText('ok')).toBeTruthy();
  });

  it('sets post-setup adopt handoff when discovery has candidates', async () => {
    vi.mocked(fetch).mockResolvedValue(jsonRes({ success: true }));
    apiFetchMock.mockResolvedValue(jsonRes(ENV_REPORT));
    const onComplete = vi.fn();

    render(<Setup onComplete={onComplete} />);

    fireEvent.change(screen.getByLabelText(/username/i), { target: { value: 'admin' } });
    fireEvent.change(screen.getByLabelText(/^password$/i), { target: { value: 'password123' } });
    fireEvent.change(screen.getByLabelText(/confirm password/i), { target: { value: 'password123' } });
    fireEvent.click(screen.getByRole('button', { name: /initialize console/i }));

    await waitFor(() => expect(screen.getByText(/2 files to adopt/i)).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /enter sencho/i }));

    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem('sencho:post-setup')).toBe(JSON.stringify({ openAdopt: true }));
  });
});
