/**
 * Coverage for fetchStackRecoveries: forwards nodeId, maps response
 * entries, and reports a failed read as an error rather than as an empty list
 * (a caller watching recoveries over time must not read a blip as "gone").
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fetchStackRecoveries, requestServiceRestore, requestServiceUpdate } from '../serviceUpdate';

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

/** Unwraps a successful read, failing the test if the read errored. */
async function readOk(params: { nodeId: number | null; stackName: string }) {
  const result = await fetchStackRecoveries(params);
  if (!result.ok) throw new Error(`expected a successful read, got: ${result.error}`);
  return result.recoveries;
}

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
    const recoveries = await readOk({ nodeId: null, stackName: 'web' });
    expect(recoveries).toHaveLength(2);
    expect(recoveries[0]).toMatchObject({ serviceName: 'api', recoveryId: 'rec-api', healthGateStatus: 'failed' });
    expect(recoveries[1]).toMatchObject({ serviceName: 'db', recoveryId: 'rec-db', healthGateStatus: 'unknown' });
  });

  it('returns an empty list, not an error, when the stack has no active recoveries', async () => {
    mockedApiFetch.mockResolvedValue(new Response('[]', { status: 200 }));
    const result = await fetchStackRecoveries({ nodeId: null, stackName: 'web' });
    expect(result).toEqual({ ok: true, recoveries: [] });
  });

  it('reports an error, not an empty list, on 400 (capability_unavailable from older nodes)', async () => {
    mockedApiFetch.mockResolvedValue(new Response(JSON.stringify({ error: 'capability_unavailable' }), { status: 400 }));
    const result = await fetchStackRecoveries({ nodeId: null, stackName: 'web' });
    expect(result).toEqual({ ok: false, error: 'capability_unavailable' });
  });

  it('reports an error, not an empty list, on 403', async () => {
    mockedApiFetch.mockResolvedValue(new Response('Forbidden', { status: 403 }));
    const result = await fetchStackRecoveries({ nodeId: null, stackName: 'web' });
    expect(result.ok).toBe(false);
  });

  it('reports an error, not an empty list, when the response body is not an array', async () => {
    mockedApiFetch.mockResolvedValue(new Response(JSON.stringify({ error: 'oops' }), { status: 200 }));
    const result = await fetchStackRecoveries({ nodeId: null, stackName: 'web' });
    expect(result).toEqual({ ok: false, error: 'Unexpected recovery response for "web"' });
  });

  it('skips malformed entries and keeps well-formed ones', async () => {
    mockedApiFetch.mockResolvedValue(new Response(JSON.stringify([
      sampleEntries[0],
      { serviceName: 12, recoveryId: 'bad' },
      sampleEntries[1],
    ]), { status: 200 }));
    const recoveries = await readOk({ nodeId: null, stackName: 'web' });
    expect(recoveries.map(r => r.recoveryId)).toEqual(['rec-api', 'rec-db']);
  });

  it('keeps only the first (newest) entry per service when the server sends duplicates', async () => {
    // The server orders newest-first; a duplicate older failed row for the same
    // service must be dropped so no Restore toast can target a stale snapshot.
    const olderFailed = {
      serviceName: 'api',
      recoveryId: 'rec-api-old',
      healthGateId: 'gate-old',
      healthGateStatus: 'failed' as const,
      healthGateReason: 'timeout',
      healthGateFailureSource: 'primary' as const,
      expiresAt: Date.now() + 60_000,
    };
    const newerPassed = { ...sampleEntries[0], recoveryId: 'rec-api-new', healthGateStatus: 'passed' as const, healthGateReason: null, healthGateFailureSource: null };
    mockedApiFetch.mockResolvedValue(new Response(JSON.stringify([newerPassed, olderFailed]), { status: 200 }));
    const recoveries = await readOk({ nodeId: null, stackName: 'web' });
    expect(recoveries).toHaveLength(1);
    expect(recoveries[0]).toMatchObject({ recoveryId: 'rec-api-new', healthGateStatus: 'passed' });
  });

  it('reports an error, not an empty list, on network failure', async () => {
    mockedApiFetch.mockRejectedValue(new Error('ECONNREFUSED'));
    const result = await fetchStackRecoveries({ nodeId: null, stackName: 'web' });
    expect(result).toEqual({ ok: false, error: 'ECONNREFUSED' });
  });
});

describe('service update and restore refusals', () => {
  const body = {
    error: 'Service "socket-proxy" carries the Docker connection Sencho is using.',
    code: 'docker_endpoint_protected',
    reason: 'provider',
    service: 'socket-proxy',
  };

  it('returns the Docker endpoint refusal for a service update', async () => {
    mockedApiFetch.mockResolvedValue(new Response(JSON.stringify(body), { status: 409 }));
    const result = await requestServiceUpdate({ nodeId: 1, stackName: 'web', serviceName: 'socket-proxy' });
    expect(result).toMatchObject({
      ok: false,
      endpointRefusal: {
        message: 'Service "socket-proxy" carries the Docker connection Sencho is using.',
        reason: 'provider',
        service: 'socket-proxy',
      },
    });
  });

  it('carries the update policy refusal, so the shared handler can offer the Compose file', async () => {
    mockedApiFetch.mockResolvedValue(new Response(JSON.stringify({
      error: 'Update blocked by io.sencho.update: "api" is set to disabled.',
      code: 'update_policy_blocked',
      serviceName: 'api',
      updatePolicy: { reason: '"api" is set to disabled.' },
    }), { status: 409 }));
    const result = await requestServiceUpdate({ nodeId: 1, stackName: 'web', serviceName: 'api' });
    expect(result).toMatchObject({
      ok: false,
      code: 'update_policy_blocked',
      policyRefusal: {
        message: 'Update blocked by io.sencho.update: "api" is set to disabled.',
        reason: '"api" is set to disabled.',
        serviceName: 'api',
      },
    });
  });

  it('leaves the refusal absent when the body is malformed, so callers keep their generic failure', async () => {
    mockedApiFetch.mockResolvedValue(new Response(JSON.stringify({ code: 'update_policy_blocked' }), { status: 409 }));
    const result = await requestServiceUpdate({ nodeId: 1, stackName: 'web', serviceName: 'api' });
    expect(result).toMatchObject({ ok: false });
    expect(result.ok ? undefined : result.policyRefusal).toBeUndefined();
  });

  it('returns the Docker endpoint refusal for a service restore', async () => {
    mockedApiFetch.mockResolvedValue(new Response(JSON.stringify(body), { status: 409 }));
    const result = await requestServiceRestore({ nodeId: 1, stackName: 'web', serviceName: 'socket-proxy', recoveryId: 'rec-1' });
    expect(result).toMatchObject({ ok: false, endpointRefusal: { reason: 'provider', service: 'socket-proxy' } });
  });
});

describe('service update scan-policy block', () => {
  const blockBody = {
    error: 'Policy "prod-gate" blocked update: 1 image(s) matched severity',
    code: 'policy_blocked',
    serviceName: 'web',
    mutationStage: 'policy',
    policy: { id: 1, name: 'prod-gate', maxSeverity: 'HIGH', blockOnSeverity: 1, blockOnKev: 0, blockOnFixable: 0 },
    violations: [
      { imageRef: 'app:latest', severity: 'CRITICAL', criticalCount: 1, highCount: 0, kevCount: 0, fixableCount: 0, reasons: ['severity'], scanId: 4 },
    ],
    evidence: { outcome: 'block', summary: 'Vulnerability scan: current, blocked by the Scan failed setting, set to block', records: [], applications: [] },
  };

  it('returns the payload the shared block dialog renders, so its bypass opens', async () => {
    mockedApiFetch.mockResolvedValue(new Response(JSON.stringify(blockBody), { status: 409 }));

    const result = await requestServiceUpdate({ nodeId: 1, stackName: 'web', serviceName: 'web' });

    expect(result.ok).toBe(false);
    expect(result.ok ? undefined : result.policyBlock).toMatchObject({
      policy: { name: 'prod-gate' },
      violations: [expect.objectContaining({ imageRef: 'app:latest' })],
      evidence: { summary: expect.stringContaining('Scan failed setting') },
    });
  });

  it('carries no block payload when the refusal is not a policy block', async () => {
    mockedApiFetch.mockResolvedValue(new Response(JSON.stringify({ error: 'Compose failed', code: 'service_update_compose_failed' }), { status: 500 }));
    const result = await requestServiceUpdate({ nodeId: 1, stackName: 'web', serviceName: 'web' });
    expect(result.ok ? undefined : result.policyBlock).toBeUndefined();
  });

  it('asks for the bypass on the service route when retrying past a block', async () => {
    mockedApiFetch.mockResolvedValue(new Response(JSON.stringify({
      serviceName: 'web', healthGateId: null, observing: false, recoveryId: null, recoveryAvailable: false,
    }), { status: 200 }));
    await requestServiceUpdate({ nodeId: 1, stackName: 'web', serviceName: 'web', ignorePolicy: true });
    const [path] = mockedApiFetch.mock.calls[0] as [string, Record<string, unknown>];
    expect(path).toBe('/stacks/web/services/web/update?ignorePolicy=true');
  });
});
