import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }));
vi.mock('@/components/ui/toast-store', () => ({
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));
vi.mock('@/lib/clipboard', () => ({ copyToClipboard: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/context/NodeContext', () => ({ useNodes: () => ({ activeNode: { id: 'local' } }) }));

import { apiFetch } from '@/lib/api';
import { copyToClipboard } from '@/lib/clipboard';
import EnvironmentPanel from '../EnvironmentPanel';
import type { EnvInventory } from '@/lib/envChecklist';

const mockedFetch = apiFetch as unknown as ReturnType<typeof vi.fn>;
const mockedCopy = copyToClipboard as unknown as ReturnType<typeof vi.fn>;

const INVENTORY: EnvInventory = {
  stackName: 'demo',
  renderable: true,
  items: [
    { key: 'DB_PASSWORD', sources: ['env-file'], usedForInterpolation: false, injectedIntoService: true, required: false, hasDefault: false, likelySecret: true, status: 'present' },
    { key: 'MISSING_VAR', sources: ['compose-ref'], usedForInterpolation: true, injectedIntoService: false, required: true, hasDefault: false, likelySecret: false, status: 'missing' },
  ],
  envFiles: [],
  summary: { total: 2, missing: 1, unused: 0, duplicate: 0, unpersisted: 0, likelySecret: 1 },
};

beforeEach(() => {
  mockedFetch.mockReset();
  mockedCopy.mockReset().mockResolvedValue(undefined);
});

describe('EnvironmentPanel', () => {
  it('renders items with status badges and a secret presence badge (never a value)', async () => {
    mockedFetch.mockResolvedValue({ ok: true, json: async () => INVENTORY });
    render(<EnvironmentPanel stackName="demo" />);
    expect(screen.getByText(/loading environment/i)).toBeTruthy();
    await screen.findByText('DB_PASSWORD');
    expect(screen.getByText('MISSING_VAR')).toBeTruthy();
    const badges = screen.getAllByTestId('env-status-badge');
    expect(badges.some(b => b.getAttribute('data-status') === 'missing')).toBe(true);
    expect(screen.getByTestId('env-secret-badge')).toBeTruthy();
  });

  it('copies a checklist that excludes values', async () => {
    mockedFetch.mockResolvedValue({ ok: true, json: async () => INVENTORY });
    render(<EnvironmentPanel stackName="demo" />);
    await screen.findByText('DB_PASSWORD');
    fireEvent.click(screen.getByTestId('env-copy-checklist-btn'));
    await waitFor(() => expect(mockedCopy).toHaveBeenCalled());
    const md = mockedCopy.mock.calls[0][0] as string;
    expect(md).toContain('DB_PASSWORD');
    expect(md).toContain('No values are included');
  });

  it('renders an error state when the fetch fails', async () => {
    mockedFetch.mockResolvedValue({ ok: false });
    render(<EnvironmentPanel stackName="demo" />);
    await screen.findByText(/could not load the environment inventory/i);
  });

  it('renders the env files section, the shell-only status, and the partial-render banner', async () => {
    const inv: EnvInventory = {
      stackName: 'demo',
      renderable: false,
      items: [
        { key: 'SHELL_VAR', sources: ['process-env'], usedForInterpolation: true, injectedIntoService: false, required: false, hasDefault: false, likelySecret: false, status: 'unpersisted' },
        { key: 'DUP_VAR', sources: ['dotenv', 'compose-inline'], usedForInterpolation: true, injectedIntoService: true, required: false, hasDefault: false, likelySecret: false, status: 'duplicate' },
      ],
      envFiles: [
        { rawPaths: ['./gone.env'], existence: 'missing', required: true, isInterpolationSource: false, isInjectionSource: true, declaringServices: ['web'] },
      ],
      summary: { total: 2, missing: 0, unused: 0, duplicate: 1, unpersisted: 1, likelySecret: 0 },
    };
    mockedFetch.mockResolvedValue({ ok: true, json: async () => inv });
    render(<EnvironmentPanel stackName="demo" />);
    await screen.findByText('SHELL_VAR');
    expect(screen.getAllByTestId('env-status-badge').some(b => b.getAttribute('data-status') === 'unpersisted')).toBe(true);
    expect(screen.getByTestId('env-files-section')).toBeTruthy();
    expect(screen.getByText('./gone.env')).toBeTruthy();
    expect(screen.getByText(/effective model unavailable/i)).toBeTruthy();
  });

  it('renders an empty state when no variables are present', async () => {
    mockedFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ ...INVENTORY, items: [], summary: { total: 0, missing: 0, unused: 0, duplicate: 0, unpersisted: 0, likelySecret: 0 } }),
    });
    render(<EnvironmentPanel stackName="demo" />);
    await screen.findByText(/no environment variables are referenced/i);
  });
});
