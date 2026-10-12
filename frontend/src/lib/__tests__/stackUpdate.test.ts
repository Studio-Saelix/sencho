import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/api', () => ({
  apiFetch: vi.fn(),
  withDeploySession: (id: string, options: object = {}) => ({ ...options, deploySession: id }),
}));

import { apiFetch } from '@/lib/api';
import { parsePolicyBlock, postStackUpdate } from '../stackUpdate';

const json = (status: number, body: unknown): Response => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
  text: async () => JSON.stringify(body),
}) as Response;

const text = (status: number, body: string): Response => ({
  ok: false,
  status,
  json: async (): Promise<unknown> => { throw new Error('not json'); },
  text: async () => body,
}) as Response;

const policyBody = { error: 'blocked', policy: { id: 1, name: 'No criticals', maxSeverity: 'CRITICAL' }, violations: [] };

describe('postStackUpdate', () => {
  beforeEach(() => vi.mocked(apiFetch).mockReset());

  it('posts to the node and encodes the stack name', async () => {
    vi.mocked(apiFetch).mockResolvedValue(json(200, {}));
    await postStackUpdate({ nodeId: 3, stackName: 'my stack', deploySessionId: 's1', ignorePolicy: true });
    expect(apiFetch).toHaveBeenCalledWith(
      '/stacks/my%20stack/update?ignorePolicy=true',
      { method: 'POST', nodeId: 3, deploySession: 's1' },
    );
  });

  it('reports success with the health gate and recheck warning', async () => {
    vi.mocked(apiFetch).mockResolvedValue(json(200, { healthGateId: 'g1', recheckWarning: 'still detected' }));
    expect(await postStackUpdate({ nodeId: 1, stackName: 'web' })).toEqual({
      kind: 'ok', healthGateId: 'g1', recheckWarning: 'still detected',
    });
  });

  it('still succeeds when the success body cannot be read', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.mocked(apiFetch).mockResolvedValue({ ok: true, status: 200, json: async (): Promise<unknown> => { throw new Error('x'); } } as Response);
    expect(await postStackUpdate({ nodeId: 1, stackName: 'web' })).toMatchObject({ kind: 'ok', healthGateId: null });
  });

  it('classifies the protected self stack', async () => {
    vi.mocked(apiFetch).mockResolvedValue(json(409, { code: 'self_stack_protected' }));
    expect(await postStackUpdate({ nodeId: 1, stackName: 'sencho' })).toEqual({ kind: 'self-stack' });
  });

  it('classifies a stack busy with another operation, naming who started it', async () => {
    vi.mocked(apiFetch).mockResolvedValue(json(409, {
      code: 'stack_op_in_progress',
      inProgress: { action: 'update', startedAt: 1, user: 'bob' },
    }));
    expect(await postStackUpdate({ nodeId: 1, stackName: 'web' })).toEqual({
      kind: 'busy', message: 'web is already updating (started by bob).',
    });
  });

  it('classifies a policy block, and not a policy-shaped body on another status', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(json(409, policyBody));
    expect(await postStackUpdate({ nodeId: 1, stackName: 'web' })).toMatchObject({ kind: 'policy-blocked', policyName: 'No criticals' });
    vi.mocked(apiFetch).mockResolvedValueOnce(json(500, policyBody));
    expect(await postStackUpdate({ nodeId: 1, stackName: 'web' })).toMatchObject({ kind: 'failed' });
  });

  it('takes the failure message, rollback and classification from the body', async () => {
    vi.mocked(apiFetch).mockResolvedValue(json(500, {
      error: 'compose up failed',
      rolledBack: true,
      failure: { reason: 'docker', label: 'Docker error', suggestion: 'Check the daemon.' },
    }));
    const outcome = await postStackUpdate({ nodeId: 1, stackName: 'web' });
    expect(outcome.kind).toBe('failed');
    if (outcome.kind === 'failed') {
      expect(outcome.error.message).toBe('compose up failed');
      expect(outcome.error.rolledBack).toBe(true);
      expect(outcome.error.failure).toEqual({ reason: 'docker', label: 'Docker error', suggestion: 'Check the daemon.' });
    }
  });

  it('labels a gateway failure as an unreachable node, but not an unrelated 503', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(text(502, 'Bad Gateway'));
    const gateway = await postStackUpdate({ nodeId: 1, stackName: 'web' });
    expect(gateway.kind === 'failed' && gateway.error.failure?.reason).toBe('node_unreachable');
    vi.mocked(apiFetch).mockResolvedValueOnce(json(503, { error: 'busy', code: 'something_else' }));
    const other = await postStackUpdate({ nodeId: 1, stackName: 'web' });
    expect(other.kind === 'failed' && other.error.failure).toBeUndefined();
  });

  it('falls back to "update failed" when the body says nothing', async () => {
    vi.mocked(apiFetch).mockResolvedValue(text(500, ''));
    const outcome = await postStackUpdate({ nodeId: 1, stackName: 'web' });
    expect(outcome.kind === 'failed' && outcome.error.message).toBe('update failed');
  });
});

describe('parsePolicyBlock', () => {
  it('returns null for text that is not JSON, or JSON without a policy', () => {
    expect(parsePolicyBlock('nope')).toBeNull();
    expect(parsePolicyBlock('null')).toBeNull();
    expect(parsePolicyBlock(JSON.stringify({ policy: null, violations: [] }))).toBeNull();
    expect(parsePolicyBlock(JSON.stringify({ policy: { name: 'x' } }))).toBeNull();
  });
});
