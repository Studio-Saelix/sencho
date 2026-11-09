/**
 * Saves that overlap on one stack. The server answers each save with the stack's
 * rows as they stood when it applied that save, and a transport may deliver
 * requests in a different order from the one they were sent in. The test hands
 * the newest request that is on the wire to the server first, every time, so a
 * second save that is sent before the first has replied would be applied ahead of
 * it. The replies are then adopted in the order they arrive, with failed rereads,
 * and the rows must show every confirmed save.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiFetchMock = vi.fn();
vi.mock('@/lib/api', () => ({ apiFetch: (...args: unknown[]) => apiFetchMock(...args) }));
vi.mock('@/components/ui/toast-store', () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }));
import { toast } from '@/components/ui/toast-store';

import { saveExposureIntent, type IntentEntry } from '../useExposureIntent';
import { applySavedIntents } from '@/components/security/imagesTargeting';
import type { ExposureIntent } from '@/types/networking';
import type { ImageExposureContext, ScanSummary } from '@/types/security';

interface Request { node: number; stack: string; service: string; intent: ExposureIntent | null; arrive: () => void; refuse: () => void }

/** Replies the server has produced and the network has not yet delivered. */
const undelivered: Array<() => void> = [];

const onWire: Request[] = [];
const applied: string[] = [];
const serverRows = new Map<string, Map<string, ExposureIntent>>();

function reply(status: number, body: unknown): Response {
  return { ok: status < 400, status, headers: new Headers(), json: async () => body } as unknown as Response;
}

beforeEach(() => {
  onWire.length = 0;
  undelivered.length = 0;
  applied.length = 0;
  serverRows.clear();
  apiFetchMock.mockReset();
  vi.mocked(toast.error).mockClear();
  apiFetchMock.mockImplementation((url: string, init: { method: string; body: string; nodeId?: number }) => {
    const stack = decodeURIComponent(/^\/stacks\/([^/]+)\/exposure$/.exec(url)![1]!);
    const { service, intent } = JSON.parse(init.body) as { service: string; intent: ExposureIntent | null };
    const node = init.nodeId ?? 0;
    return new Promise<Response>((resolve) => {
      onWire.push({
        node, stack, service, intent,
        arrive: () => {
          const key = `${node}\0${stack}`;
          const rows = serverRows.get(key) ?? new Map<string, ExposureIntent>();
          if (intent === null) rows.delete(service); else rows.set(service, intent);
          serverRows.set(key, rows);
          applied.push(`${node}/${stack}/${service}=${intent}`);
          const response = reply(200, { intents: [...rows].map(([name, value]) => ({ service: name, intent: value })) });
          undelivered.push(() => resolve(response));
        },
        refuse: () => resolve(reply(500, { error: 'boom' })),
      });
    });
  });
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * Lets the server take the newest request on the wire first, and delivers the
 * reply of the save it applied last first, until nothing is left.
 */
async function deliverNewestFirst(): Promise<void> {
  await tick();
  while (onWire.length > 0 || undelivered.length > 0) {
    if (onWire.length > 0) onWire.pop()!.arrive();
    else undelivered.pop()!();
    await tick();
  }
}

describe('saveExposureIntent ordering', () => {
  it('never has a second save of one stack on the wire while the first is unanswered', async () => {
    const first = saveExposureIntent('web', 'api', 'lan', 1);
    const second = saveExposureIntent('web', 'worker', 'public', 1);
    const third = saveExposureIntent('web', 'api', 'internal', 1);
    await tick();
    expect(onWire.map((r) => r.service)).toEqual(['api']);

    await deliverNewestFirst();
    expect(applied).toEqual(['1/web/api=lan', '1/web/worker=public', '1/web/api=internal']);
    const [a, b, c] = await Promise.all([first, second, third]);
    // Each reply holds every save before it.
    expect(a).toEqual([{ service: 'api', intent: 'lan' }]);
    expect(b).toHaveLength(2);
    expect(c).toContainEqual({ service: 'api', intent: 'internal' });
    expect(c).toContainEqual({ service: 'worker', intent: 'public' });
  });

  it('settles competing writes to one service in the order they were asked for', async () => {
    const saves = [
      saveExposureIntent('web', 'api', 'public', 1),
      saveExposureIntent('web', 'api', 'lan', 1),
      saveExposureIntent('web', 'api', null, 1),
      saveExposureIntent('web', 'api', 'temporary', 1),
    ];
    await deliverNewestFirst();
    const replies = await Promise.all(saves);
    expect(replies.map((rows) => rows?.find((row) => row.service === 'api')?.intent)).toEqual(['public', 'lan', undefined, 'temporary']);
    expect(serverRows.get('1\0web')?.get('api')).toBe('temporary');
  });

  it('does not make one stack or node wait for another', async () => {
    const saves = [
      saveExposureIntent('web', 'api', 'lan', 1),
      saveExposureIntent('other', 'api', 'lan', 1),
      saveExposureIntent('web', 'api', 'lan', 2),
      saveExposureIntent('web', 'worker', 'lan', 1),
    ];
    await tick();
    expect(onWire.map((r) => `${r.node}/${r.stack}/${r.service}`)).toEqual(['1/web/api', '1/other/api', '2/web/api']);
    await deliverNewestFirst();
    await Promise.all(saves);
    expect(applied.filter((entry) => entry.startsWith('1/web/'))).toEqual(['1/web/api=lan', '1/web/worker=lan']);
  });

  it('sends the next save after one that was refused', async () => {
    const refused = saveExposureIntent('web', 'api', 'lan', 1);
    const next = saveExposureIntent('web', 'worker', 'lan', 1);
    await tick();
    onWire.pop()!.refuse();
    await tick();
    expect(onWire.map((r) => r.service)).toEqual(['worker']);
    await deliverNewestFirst();
    expect(await refused).toBeNull();
    expect(await next).toEqual([{ service: 'worker', intent: 'lan' }]);
  });

  it('sends the next save after one whose request threw', async () => {
    apiFetchMock.mockImplementationOnce(() => Promise.reject(new Error('network down')));
    const failed = saveExposureIntent('web', 'api', 'lan', 1);
    const next = saveExposureIntent('web', 'worker', 'lan', 1);
    await deliverNewestFirst();
    expect(await failed).toBeNull();
    expect(await next).toEqual([{ service: 'worker', intent: 'lan' }]);
  });

  it('sends the next save after one that got no reply, and reports the stalled one as timed out', async () => {
    vi.useFakeTimers();
    try {
      let signal: AbortSignal | undefined;
      apiFetchMock.mockImplementationOnce((_url: string, init: { signal: AbortSignal }) => {
        signal = init.signal;
        return new Promise<Response>((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        });
      });
      const stalled = saveExposureIntent('web', 'api', 'lan', 1);
      const next = saveExposureIntent('web', 'worker', 'lan', 1);
      await vi.advanceTimersByTimeAsync(29_000);
      expect(onWire).toHaveLength(0);
      expect(signal?.aborted).toBe(false);

      await vi.advanceTimersByTimeAsync(2_000);
      expect(await stalled).toBeNull();
      expect(toast.error).toHaveBeenCalledWith('Saving the exposure intent timed out. Refresh to confirm.');
      expect(onWire.map((r) => r.service)).toEqual(['worker']);
      onWire.pop()!.arrive();
      undelivered.pop()!();
      expect(await next).toEqual([{ service: 'worker', intent: 'lan' }]);
    } finally {
      vi.useRealTimers();
    }
  });
});

function summaryFor(imageRef: string, context: ImageExposureContext): ScanSummary {
  return {
    image_ref: imageRef, scan_id: 1, highest_severity: null, scanned_at: 1,
    total: 0, critical: 0, high: 0, medium: 0, low: 0, unknown: 0, fixable: 0, secret_count: 0, misconfig_count: 0,
    publicly_exposed: true,
    exposure_contexts: [context],
    exposure_context_count: 1,
    exposure_context_summary: { hasConflict: false, hasUnclassified: true, hasUnavailable: false, allKnownIntentional: false },
  };
}

const published = (serviceName: string): ImageExposureContext => (
  { stackName: 'web', serviceName, exposureReason: 'published-port', intentStatus: 'unset' }
);
const unverifiedTunnel: ImageExposureContext = {
  stackName: 'web',
  serviceName: 'edge',
  exposureReason: 'tunnel',
  tunnel: { connector: 'cf', provider: 'cloudflared', scope: 'public-edge', path: 'shared-network' },
  intentStatus: 'unset',
};

describe('rows after overlapping saves, with no reread to correct them', () => {
  const intents: Array<ExposureIntent | null> = ['public', 'lan', 'reverse-proxy', 'temporary', 'internal', 'same-node', 'unknown', null];

  it.each(intents)('shows %s on the saved service and keeps the others', async (intent) => {
    const targets: Array<[string, ImageExposureContext]> = [
      ['api:1', published('api')], ['edge:1', unverifiedTunnel], ['worker:1', published('worker')],
    ];
    let summaries: Record<string, ScanSummary> = Object.fromEntries(targets.map(([ref, context]) => [ref, summaryFor(ref, context)]));
    // The stack is classified `lan` first so a cleared service inherits it.
    const saves: Array<{ service: string; intent: ExposureIntent | null; target: [string, ImageExposureContext] }> = [
      { service: '', intent: 'lan', target: targets[0]! },
      { service: 'api', intent, target: targets[0]! },
      { service: 'edge', intent, target: targets[1]! },
      { service: 'worker', intent: 'temporary', target: targets[2]! },
    ];
    const adopted: Promise<void>[] = saves.map(async ({ service, intent: value, target }) => {
      const rows = await saveExposureIntent('web', service, value, 1) as IntentEntry[];
      summaries = applySavedIntents(summaries, 'web', rows, { imageRef: target[0], context: target[1] });
    });
    await deliverNewestFirst();
    await Promise.all(adopted);

    const effective = intent ?? 'lan';
    const evidence = (ref: string) => summaries[ref]?.exposure_contexts?.[0];
    expect(evidence('api:1')).toMatchObject(effective === 'unknown'
      ? { intentStatus: 'unset' }
      : { intentStatus: 'set', exposureIntent: effective });
    expect(evidence('api:1')?.intentConflict === true).toBe(effective === 'internal' || effective === 'same-node');
    expect(evidence('worker:1')).toMatchObject({ intentStatus: 'set', exposureIntent: 'temporary' });
    if (effective === 'internal' || effective === 'same-node') {
      // The server takes an unverified tunnel at the operator's word and stops counting it.
      expect(summaries['edge:1']).toMatchObject({ publicly_exposed: false, exposure_context_count: 0 });
    } else {
      expect(evidence('edge:1')).toMatchObject(effective === 'unknown'
        ? { intentStatus: 'unset' }
        : { intentStatus: 'set', exposureIntent: effective });
    }
  });
});
