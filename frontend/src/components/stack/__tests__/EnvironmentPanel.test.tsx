import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }));
vi.mock('@/components/ui/toast-store', () => ({
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));
vi.mock('@/lib/clipboard', () => ({ copyToClipboard: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/context/NodeContext', () => ({ useNodes: () => ({ activeNode: { id: 'local' }, hasCapability: () => false }) }));
const auth = vi.hoisted(() => ({ canEdit: true }));
vi.mock('@/context/AuthContext', () => ({ useAuth: () => ({ can: () => auth.canEdit }) }));

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
  auth.canEdit = true;
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
    expect(answer).toHaveTextContent('missing variables');
    expect(answer).not.toHaveTextContent('1 missing');
    fireEvent.click(screen.getByRole('button', { name: 'Edit env files' }));
    expect(onOpenFiles).toHaveBeenCalledTimes(1);
  });

  it('offers no verb when the editor cannot open files', async () => {
    mockedFetch.mockResolvedValue({ ok: true, json: async () => INVENTORY });
    render(<EnvironmentPanel stackName="demo" />);
    await screen.findByTestId('env-answer');
    expect(screen.queryByRole('button', { name: 'Edit env files' })).toBeNull();
  });

  it('offers no file verb to a user who cannot edit, though the Answer is the same', async () => {
    auth.canEdit = false;
    mockedFetch.mockResolvedValue({ ok: true, json: async () => INVENTORY });
    render(<EnvironmentPanel stackName="demo" onOpenFiles={vi.fn()} />);
    expect(await screen.findByTestId('env-answer')).toHaveTextContent('missing variables');
    expect(screen.queryByRole('button', { name: 'Edit env files' })).toBeNull();
  });

  it('drops the previous stack\'s Answer and rows while the next stack loads', async () => {
    mockedFetch.mockResolvedValue({ ok: true, json: async () => INVENTORY });
    const { rerender } = render(<EnvironmentPanel stackName="demo" onOpenFiles={vi.fn()} />);
    await screen.findByText('MISSING_VAR');
    mockedFetch.mockReturnValue(new Promise(() => {}));
    rerender(<EnvironmentPanel stackName="other" onOpenFiles={vi.fn()} />);
    await waitFor(() => expect(screen.queryByText('MISSING_VAR')).toBeNull());
    expect(screen.queryByTestId('env-answer')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Edit env files' })).toBeNull();
    expect((screen.getByTestId('env-copy-checklist-btn') as HTMLButtonElement).disabled).toBe(true);
  });

  it('ignores a late response for the stack it switched away from', async () => {
    let resolveOld: (v: unknown) => void = () => {};
    mockedFetch.mockReturnValueOnce(new Promise(res => { resolveOld = res; }));
    const { rerender } = render(<EnvironmentPanel stackName="demo" />);
    mockedFetch.mockResolvedValue({ ok: true, json: async () => ({ ...INVENTORY, items: [INVENTORY.items[0]], summary: { ...INVENTORY.summary, total: 1, missing: 0 } }) });
    rerender(<EnvironmentPanel stackName="other" />);
    expect(await screen.findByTestId('env-answer')).toHaveTextContent('resolved');
    await act(async () => { resolveOld({ ok: true, json: async () => INVENTORY }); });
    expect(screen.getByTestId('env-answer')).toHaveTextContent('resolved');
    expect(screen.queryByText('MISSING_VAR')).toBeNull();
  });

  it('keeps an absent optional env file quiet under a resolved Answer, and a required one loud', async () => {
    mockedFetch.mockResolvedValue({ ok: true, json: async () => inv({ envFiles: [FILE('missing', false)] }) });
    const { unmount } = render(<EnvironmentPanel stackName="demo" />);
    const section = await screen.findByTestId('env-files-section');
    expect(section).toHaveTextContent('optional, not found');
    expect(section.querySelector('.text-destructive')).toBeNull();
    unmount();
    mockedFetch.mockResolvedValue({ ok: true, json: async () => inv({ envFiles: [FILE('missing')] }) });
    render(<EnvironmentPanel stackName="demo" />);
    const loud = await screen.findByTestId('env-files-section');
    expect(loud.querySelector('.text-destructive')).toBeTruthy();
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

  const FILE = (existence: string, required = true) => ({ rawPaths: ['./a.env'], existence, required, isInterpolationSource: false, isInjectionSource: true, declaringServices: ['web'] });
  const inv = (over: Record<string, unknown>, summary: Record<string, number> = {}) => ({
    ...INVENTORY, items: [INVENTORY.items[0]], envFiles: [],
    summary: { total: 1, missing: 0, unused: 0, duplicate: 0, unpersisted: 0, likelySecret: 0, ...summary }, ...over,
  });

  it.each([
    ['missing vars outrank a missing env file', inv({ envFiles: [FILE('missing')] }, { missing: 1 }), 'missing variables', 'destructive'],
    ['duplicate outranks shell-only', inv({}, { duplicate: 1, unpersisted: 1 }), 'duplicate variables', 'warning'],
    ['shell-only on its own', inv({}, { unpersisted: 1 }), 'shell-only variables', 'warning'],
    ['shell-only outranks an unverifiable file', inv({ envFiles: [FILE('unverifiable')] }, { unpersisted: 1 }), 'shell-only variables', 'warning'],
    ['unverifiable file on its own', inv({ envFiles: [FILE('unverifiable')] }), 'env file unverifiable', 'warning'],
    ['an optional missing file does not raise the Answer', inv({ envFiles: [FILE('missing', false)] }, { duplicate: 1 }), 'duplicate variables', 'warning'],
    ['two missing files', inv({ envFiles: [FILE('missing'), { ...FILE('missing'), rawPaths: ['./b.env'] }] }), 'env files missing', 'destructive'],
    ['unused variables stay resolved', inv({}, { unused: 2 }), 'resolved', 'success'],
    ['an unrendered model is a partial view', inv({ renderable: false }), 'partial view', 'warning'],
  ])('Answer: %s', async (_name, inventory, title, tone) => {
    mockedFetch.mockResolvedValue({ ok: true, json: async () => inventory });
    render(<EnvironmentPanel stackName="demo" onOpenFiles={vi.fn()} />);
    const answer = await screen.findByTestId('status-answer');
    expect(answer).toHaveTextContent(title as string);
    expect(answer).toHaveAttribute('data-tone', tone as string);
  });

  it('offers the file verb for a missing file but not for an unverifiable one', async () => {
    mockedFetch.mockResolvedValue({ ok: true, json: async () => inv({ envFiles: [FILE('missing')] }) });
    const { unmount } = render(<EnvironmentPanel stackName="demo" onOpenFiles={vi.fn()} />);
    await screen.findByRole('button', { name: 'Edit env files' });
    unmount();
    mockedFetch.mockResolvedValue({ ok: true, json: async () => inv({ envFiles: [FILE('unverifiable')] }) });
    render(<EnvironmentPanel stackName="demo" onOpenFiles={vi.fn()} />);
    await screen.findByTestId('status-answer');
    expect(screen.queryByRole('button', { name: 'Edit env files' })).toBeNull();
  });

  it('shows no Answer for an empty inventory, but still for an empty one with a missing file', async () => {
    mockedFetch.mockResolvedValue({ ok: true, json: async () => inv({ items: [] }, { total: 0 }) });
    const { unmount } = render(<EnvironmentPanel stackName="demo" />);
    await screen.findByText(/no environment variables are referenced/i);
    expect(screen.queryByTestId('status-answer')).toBeNull();
    unmount();
    mockedFetch.mockResolvedValue({ ok: true, json: async () => inv({ items: [], envFiles: [FILE('missing')] }, { total: 0 }) });
    render(<EnvironmentPanel stackName="demo" />);
    expect(await screen.findByTestId('status-answer')).toHaveTextContent('env file missing');
  });

  it('keeps the loaded inventory on screen while a retry refetches', async () => {
    mockedFetch.mockResolvedValue({ ok: true, json: async () => INVENTORY });
    render(<EnvironmentPanel stackName="demo" />);
    await screen.findByText('DB_PASSWORD');
    mockedFetch.mockReturnValue(new Promise(() => {}));
    fireEvent.click(screen.getByTestId('env-copy-checklist-btn'));
    expect(screen.getByText('DB_PASSWORD')).toBeTruthy();
  });

  it('shows a layout-matched skeleton only after the delay gate, never a bare text line', async () => {
    vi.useFakeTimers();
    try {
      mockedFetch.mockReturnValue(new Promise(() => {}));
      render(<EnvironmentPanel stackName="demo" />);
      expect(screen.queryByTestId('environment-skeleton')).toBeNull();
      await act(async () => { vi.advanceTimersByTime(400); });
      expect(screen.getByTestId('environment-skeleton')).toBeTruthy();
      expect(screen.queryByText(/loading environment…/i)).toBeNull();
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
    expect(screen.getByTestId('status-answer')).toHaveTextContent('env file missing');
    expect(screen.getByTestId('status-marker')).toHaveTextContent(/effective model unavailable/i);
    expect(screen.getAllByTestId('status-answer')).toHaveLength(1);
  });

  it('a partial view states itself once: no marker repeating its own line', async () => {
    mockedFetch.mockResolvedValue({ ok: true, json: async () => ({ ...INVENTORY, renderable: false, summary: { ...INVENTORY.summary, missing: 0, total: 1 }, items: [INVENTORY.items[0]] }) });
    render(<EnvironmentPanel stackName="demo" />);
    expect(await screen.findByTestId('status-answer')).toHaveTextContent('partial view');
    expect(screen.queryByTestId('status-marker')).toBeNull();
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
