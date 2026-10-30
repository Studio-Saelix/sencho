/**
 * Unit coverage for the GitOps journey teardown in journeyCleanup.ts.
 *
 * Not a browser test: it drives the cleanup function against a recording API
 * stub, so the created-resource set, the per-step response checks, and the
 * "one failed request does not stop the rest" rule can be exercised without a
 * running app or Docker.
 */
import { test, expect } from '@playwright/test';
import { cleanupJourneyResources, type CleanupApi, type JourneyCleanupTargets } from './journeyCleanup';

interface RecordedCall {
  path: string;
  method: string;
  body?: unknown;
}

const TARGETS: JourneyCleanupTargets = {
  stackName: 'e2e-journey',
  attached: true,
  webhookId: 42,
  previousGateWindow: '90',
};

function recordingApi(options: { failPath?: string; throwPath?: string } = {}) {
  const calls: RecordedCall[] = [];
  const api: CleanupApi = async (path, init) => {
    calls.push({ path, method: init.method, body: init.body });
    if (path === options.throwPath) throw new Error('connection reset');
    if (path === options.failPath) return { status: 500 };
    return { status: 200 };
  };
  return { api, calls };
}

const ALL_PATHS = [
  '/api/webhooks/42',
  '/api/stacks/e2e-journey/git-source',
  '/api/stacks/e2e-journey',
  '/api/settings',
];

test.describe('GitOps journey teardown', () => {
  test('deletes the webhook, the Git source and the stack, then restores the gate window', async () => {
    const { api, calls } = recordingApi();
    await cleanupJourneyResources(api, TARGETS);
    expect(calls).toEqual([
      { path: '/api/webhooks/42', method: 'DELETE' },
      { path: '/api/stacks/e2e-journey/git-source', method: 'DELETE' },
      { path: '/api/stacks/e2e-journey', method: 'DELETE' },
      { path: '/api/settings', method: 'PATCH', body: { health_gate_window_seconds: 90 } },
    ]);
  });

  test('still runs every remaining step when the webhook delete fails', async () => {
    const { api, calls } = recordingApi({ failPath: '/api/webhooks/42' });
    await expect(cleanupJourneyResources(api, TARGETS)).rejects.toThrow(/webhook 42: HTTP 500/);
    expect(calls.map((call) => call.path)).toEqual(ALL_PATHS);
  });

  test('still runs every remaining step when the webhook delete throws', async () => {
    const { api, calls } = recordingApi({ throwPath: '/api/webhooks/42' });
    await expect(cleanupJourneyResources(api, TARGETS)).rejects.toThrow(/webhook 42: connection reset/);
    expect(calls.map((call) => call.path)).toEqual(ALL_PATHS);
  });

  test('skips resources the run never created but always restores the gate window', async () => {
    const { api, calls } = recordingApi();
    await cleanupJourneyResources(api, { ...TARGETS, attached: false, webhookId: null });
    expect(calls).toEqual([
      { path: '/api/settings', method: 'PATCH', body: { health_gate_window_seconds: 90 } },
    ]);
  });
});
