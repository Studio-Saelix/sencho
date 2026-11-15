import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }));
vi.mock('@/components/ui/toast-store', () => ({
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));
vi.mock('@/lib/clipboard', () => ({ copyToClipboard: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/context/NodeContext', () => ({ useNodes: () => ({ activeNode: { id: 'local' }, hasCapability: () => false }) }));
vi.mock('@/context/AuthContext', () => ({ useAuth: () => ({ can: () => false }) }));

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
  it('groups items under their status and shows a secret presence badge (never a value)', async () => {
    mockedFetch.mockResolvedValue({ ok: true, json: async () => INVENTORY });
    render(<EnvironmentPanel stackName="demo" />);
    await screen.findByText('DB_PASSWORD');
    expect(screen.getByText('MISSING_VAR')).toBeTruthy();
    expect(screen.getByText('missing · 1')).toBeTruthy();
    expect(screen.getByText('present · 1')).toBeTruthy();
    expect(screen.getByTestId('env-secret-badge')).toBeTruthy();
  });

  it('states each status once: no per-row status badge and no tally strip beside the group headers', async () => {
    mockedFetch.mockResolvedValue({ ok: true, json: async () => INVENTORY });
    render(<EnvironmentPanel stackName="demo" />);
    await screen.findByText('DB_PASSWORD');
    expect(screen.queryByTestId('env-status-badge')).toBeNull();
    expect(screen.queryByText('2 vars')).toBeNull();
    expect(screen.getAllByText(/\bmissing\b/i).filter(el => el.closest('[data-testid="env-item-row"]'))).toHaveLength(0);
  });

  it('leads with one Answer naming the loudest problem and offers the file verb', async () => {
    mockedFetch.mockResolvedValue({ ok: true, json: async () => INVENTORY });
    const onOpenFiles = vi.fn();
    render(<EnvironmentPanel stackName="demo" onOpenFiles={onOpenFiles} />);
    const answer = await screen.findByTestId('env-answer');
    expect(screen.getAllByTestId('status-answer')).toHaveLength(1);
    expect(answer.querySelector('[data-tone="destructive"]')).toBeTruthy();
    expect(answer).toHaveTextContent('1 missing');
    fireEvent.click(screen.getByRole('button', { name: 'Edit env files' }));
    expect(onOpenFiles).toHaveBeenCalledTimes(1);
  });

  it('offers no verb when the editor cannot open files', async () => {
    mockedFetch.mockResolvedValue({ ok: true, json: async () => INVENTORY });
    render(<EnvironmentPanel stackName="demo" />);
    await screen.findByTestId('env-answer');
    expect(screen.queryByRole('button', { name: 'Edit env files' })).toBeNull();
  });

  it('reads resolved, with no verb, when nothing is wrong', async () => {
    mockedFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ ...INVENTORY, items: [INVENTORY.items[0]], summary: { ...INVENTORY.summary, total: 1, missing: 0 } }),
    });
    render(<EnvironmentPanel stackName="demo" onOpenFiles={vi.fn()} />);
    const answer = await screen.findByTestId('env-answer');
    expect(answer).toHaveTextContent('resolved');
    expect(screen.queryByRole('button', { name: 'Edit env files' })).toBeNull();
  });

  it('a missing env file outranks duplicate and shell-only variables in the Answer', async () => {
    mockedFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        ...INVENTORY,
        items: [{ ...INVENTORY.items[0], status: 'duplicate' }],
        envFiles: [{ rawPaths: ['./gone.env'], existence: 'missing', required: true, isInterpolationSource: false, isInjectionSource: true, declaringServices: ['web'] }],
        summary: { total: 1, missing: 0, unused: 0, duplicate: 1, unpersisted: 0, likelySecret: 0 },
      }),
    });
    render(<EnvironmentPanel stackName="demo" />);
    expect(await screen.findByTestId('env-answer')).toHaveTextContent('env file missing');
  });

  it('shows a layout-matched skeleton only after the delay gate, never a bare text line', async () => {
    vi.useFakeTimers();
    try {
      mockedFetch.mockReturnValue(new Promise(() => {}));
      render(<EnvironmentPanel stackName="demo" />);
      expect(screen.queryByTestId('environment-skeleton')).toBeNull();
      await act(async () => { vi.advanceTimersByTime(400); });
      expect(screen.getByTestId('environment-skeleton')).toBeTruthy();
      expect(screen.queryByText(/loading environment/i)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
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
    mockedFetch.mockResolvedValue({ ok: true, json: async () => INVENTORY });
    fireEvent.click(screen.getByTestId('env-retry-btn'));
    await screen.findByText('DB_PASSWORD');
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
    expect(screen.getByText('shell-only · 1')).toBeTruthy();
    expect(screen.getByTestId('env-files-section')).toBeTruthy();
    expect(screen.getByText('./gone.env')).toBeTruthy();
    expect(screen.getByTestId('status-marker')).toHaveTextContent(/effective model unavailable/i);
    expect(screen.getAllByTestId('status-answer')).toHaveLength(1);
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
