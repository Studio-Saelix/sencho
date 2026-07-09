import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { ImportStackPanel } from '../ImportStackPanel';

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }));
vi.mock('@/components/ui/toast-store', () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() },
}));
vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({ can: () => true }),
}));

import { apiFetch } from '@/lib/api';

function jsonRes(body: unknown, ok = true) {
  return { ok, json: async () => body } as Response;
}

const CANDIDATE = {
  name: '',
  composeFile: 'nginx.yml',
  location: 'nginx.yml',
  status: 'loose-root' as const,
  services: [{ name: 'app', ports: [], volumes: [], envFiles: [] }],
  warnings: [],
};

describe('ImportStackPanel', () => {
  beforeEach(() => {
    vi.mocked(apiFetch).mockReset();
  });

  it('clears the move confirm UI when the move request fails', async () => {
    vi.mocked(apiFetch).mockImplementation(async (path, init) => {
      if (path === '/stacks/import/scan') {
        return jsonRes({ composeDir: '/opt/compose', candidates: [CANDIDATE] });
      }
      if (path === '/stacks/import/move' && init?.method === 'POST') {
        return jsonRes({ error: 'A stack named "nginx" already exists' }, false);
      }
      return jsonRes({});
    });

    render(<ImportStackPanel onClose={vi.fn()} onImported={vi.fn()} />);

    await waitFor(() => expect(screen.getByText('nginx.yml')).toBeTruthy());
    fireEvent.click(screen.getByText('nginx.yml'));

    const nameInput = await screen.findByLabelText(/destination stack name/i);
    fireEvent.change(nameInput, { target: { value: 'nginx' } });
    fireEvent.click(screen.getByRole('button', { name: /move into place/i }));

    expect(screen.getByText(/move it on disk\?/i)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /confirm move/i }));

    await waitFor(() => {
      expect(screen.queryByText(/move it on disk\?/i)).toBeNull();
    });
    expect(screen.getByRole('button', { name: /move into place/i })).toBeTruthy();
  });
});
