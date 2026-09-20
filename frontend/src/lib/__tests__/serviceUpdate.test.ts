/**
 * Coverage for fetchStackRecoveries: forwards nodeId, maps response
 * entries, and returns an empty array on non-ok responses or network failure.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fetchStackRecoveries } from '../serviceUpdate';

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, apiFetch: vi.fn() };
});
import { apiFetch } from '@/lib/api';

const mockedApiFetch = vi.mocked(apiFetch);

const sampleEntries = [
  {
    serviceName: 'api',
    recoveryId: 'rec-api',
    healthGateId: 'gate-1',
    healthGateStatus: 'failed' as const,
    healthGateReason: 'timeout',
    healthGateFailureSource: 'primary' as const,
    expiresAt: Date.now() + 60_000,
  },
  {
    serviceName: 'db',
    recoveryId: 'rec-db',
    healthGateId: null,
    healthGateStatus: 'unknown' as const,
    healthGateReason: 'no health gate linked',
    healthGateFailureSource: null,
    expiresAt: Date.now() + 60_000,
  },
];

beforeEach(() => {
  mockedApiFetch.mockReset();
});

describe('fetchStackRecoveries', () => {
  it('forwards nodeId to apiFetch', async () => {
    mockedApiFetch.mockResolvedValue(new Response(JSON.stringify(sampleEntries), { status: 200 }));
    await fetchStackRecoveries({ nodeId: 3, stackName: 'web' });
    const callArgs = mockedApiFetch.mock.calls;
    const getCall = callArgs.find(([url]) => String(url).includes('/recoveries'));
    expect(getCall).toBeDefined();
    const [, opts] = getCall!;
    expect(opts).toMatchObject({ method: 'GET', nodeId: 3 });
  });

  it('returns the mapped entries on 200', async () => {
    mockedApiFetch.mockResolvedValue(new Response(JSON.stringify(sampleEntries), { status: 200 }));
    const result = await fetchStackRecoveries({ nodeId: null, stackName: 'web' });
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ serviceName: 'api', recoveryId: 'rec-api', healthGateStatus: 'failed' });
    expect(result[1]).toMatchObject({ serviceName: 'db', recoveryId: 'rec-db', healthGateStatus: 'unknown' });
  });

  it('returns an empty array on 400 (capability_unavailable from older nodes)', async () => {
    mockedApiFetch.mockResolvedValue(new Response(JSON.stringify({ error: 'capability_unavailable' }), { status: 400 }));
    const result = await fetchStackRecoveries({ nodeId: null, stackName: 'web' });
    expect(result).toEqual([]);
  });

  it('returns an empty array on 403', async () => {
    mockedApiFetch.mockResolvedValue(new Response('Forbidden', { status: 403 }));
    const result = await fetchStackRecoveries({ nodeId: null, stackName: 'web' });
    expect(result).toEqual([]);
  });

  it('returns an empty array when the response body is not an array', async () => {
    mockedApiFetch.mockResolvedValue(new Response(JSON.stringify({ error: 'oops' }), { status: 200 }));
    const result = await fetchStackRecoveries({ nodeId: null, stackName: 'web' });
    expect(result).toEqual([]);
  });

  it('skips malformed entries and keeps well-formed ones', async () => {
    mockedApiFetch.mockResolvedValue(new Response(JSON.stringify([
      sampleEntries[0],
      { serviceName: 12, recoveryId: 'bad' },
      sampleEntries[1],
    ]), { status: 200 }));
    const result = await fetchStackRecoveries({ nodeId: null, stackName: 'web' });
    expect(result).toHaveLength(2);
    expect(result.map((r) => r.recoveryId)).toEqual(['rec-api', 'rec-db']);
  });

  it('returns an empty array on network failure', async () => {
    mockedApiFetch.mockRejectedValue(new Error('ECONNREFUSED'));
    const result = await fetchStackRecoveries({ nodeId: null, stackName: 'web' });
    expect(result).toEqual([]);
  });
});
