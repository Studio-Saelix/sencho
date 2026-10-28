import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/api', () => ({ fetchForNode: vi.fn() }));

import { fetchForNode } from '@/lib/api';
import { backupStack, startService, startStack } from '../stackLifecycleApi';

const reply = (status: number, body: unknown): Response => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
}) as Response;

describe('stackLifecycleApi', () => {
  beforeEach(() => vi.mocked(fetchForNode).mockReset());

  it('addresses the request to the given node and encodes the stack', async () => {
    vi.mocked(fetchForNode).mockResolvedValue(reply(200, {}));
    expect(await startStack(4, 'my stack')).toEqual({ ok: true });
    expect(fetchForNode).toHaveBeenCalledWith('/stacks/my%20stack/start', 4, { method: 'POST' });
    await backupStack(4, 'web');
    expect(fetchForNode).toHaveBeenLastCalledWith('/stacks/web/backup', 4, { method: 'POST' });
  });

  it('tells a stack with no containers apart from a stack that does not exist', async () => {
    vi.mocked(fetchForNode).mockResolvedValueOnce(reply(404, { error: 'No containers found for this stack.' }));
    expect(await startStack(1, 'web')).toMatchObject({ ok: false, reason: 'no-containers' });
    vi.mocked(fetchForNode).mockResolvedValueOnce(reply(404, { error: 'Stack not found' }));
    expect(await startStack(1, 'web')).toMatchObject({ ok: false, reason: 'failed', message: 'Stack not found' });
  });

  it('starts one service on the given node and reads a missing service as nothing to start', async () => {
    vi.mocked(fetchForNode).mockResolvedValueOnce(reply(200, {}));
    expect(await startService(2, 'my stack', 'db/1')).toEqual({ ok: true });
    expect(fetchForNode).toHaveBeenCalledWith('/stacks/my%20stack/services/db%2F1/start', 2, { method: 'POST' });
    vi.mocked(fetchForNode).mockResolvedValueOnce(reply(404, { error: "Service 'db' not found in stack 'web'." }));
    expect(await startService(1, 'web', 'db')).toMatchObject({ ok: false, reason: 'no-containers' });
    vi.mocked(fetchForNode).mockResolvedValueOnce(reply(404, { error: 'Stack not found' }));
    expect(await startService(1, 'web', 'db')).toMatchObject({ ok: false, reason: 'failed' });
  });

  it('never reports no-containers for a backup', async () => {
    vi.mocked(fetchForNode).mockResolvedValue(reply(404, { error: 'No containers found for this stack.' }));
    expect(await backupStack(1, 'web')).toMatchObject({ ok: false, reason: 'failed' });
  });

  it('names the HTTP status when the body has no usable message', async () => {
    vi.mocked(fetchForNode).mockResolvedValueOnce(reply(500, null));
    expect(await startStack(1, 'web')).toEqual({ ok: false, reason: 'failed', message: 'start failed (HTTP 500)' });
    vi.mocked(fetchForNode).mockResolvedValueOnce(reply(500, { error: '' }));
    expect(await backupStack(1, 'web')).toEqual({ ok: false, reason: 'failed', message: 'backup failed (HTTP 500)' });
  });
});
