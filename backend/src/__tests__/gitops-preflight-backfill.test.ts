/**
 * Startup preflight backfill: bounded parallel evaluation of legacy
 * live-authorized Blueprint apps that lack preflight evidence.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GitOpsStore } from '../services/gitops/store';
import {
  backfillMissingPreflightEvaluations,
  PREFLIGHT_BACKFILL_CONCURRENCY,
} from '../services/gitops/handoff';

type App = { id: string; rollout_authorization_ref: string | null; latest_preflight_evidence_json: string | null };

function installStore(apps: App[]) {
  const byId = new Map(apps.map((a) => [a.id, a]));
  const store = {
    listAuthorizedBlueprintApplications: () => apps,
    getApplication: (id: string) => byId.get(id),
    currentAuthorizationBinding: () => ({ binding: true }),
    resolveApprovalRef: () => ({ ok: true }),
  };
  vi.spyOn(GitOpsStore, 'getInstance').mockReturnValue(store as unknown as GitOpsStore);
  return byId;
}

function app(id: string, overrides: Partial<App> = {}): App {
  return { id, rollout_authorization_ref: `ref-${id}`, latest_preflight_evidence_json: null, ...overrides };
}

describe('backfillMissingPreflightEvaluations', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('evaluates apps in parallel but never exceeds the concurrency cap', async () => {
    const apps = Array.from({ length: 10 }, (_, i) => app(`app-${i}`));
    const byId = installStore(apps);
    let inFlight = 0;
    let peak = 0;
    const authorize = vi.fn(async (id: string) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      byId.get(id)!.latest_preflight_evidence_json = '{}';
      inFlight -= 1;
      return { ok: true as const, binding: {} as never };
    });

    const filled = await backfillMissingPreflightEvaluations(authorize);

    expect(filled).toBe(10);
    expect(authorize).toHaveBeenCalledTimes(10);
    expect(peak).toBe(PREFLIGHT_BACKFILL_CONCURRENCY);
    expect(PREFLIGHT_BACKFILL_CONCURRENCY).toBeGreaterThan(1);
    expect(PREFLIGHT_BACKFILL_CONCURRENCY).toBeLessThanOrEqual(4);
  });

  it('skips apps with evidence or without a live authorization', async () => {
    installStore([
      app('has-evidence', { latest_preflight_evidence_json: '{}' }),
      app('no-auth', { rollout_authorization_ref: null }),
      app('eligible'),
    ]);
    const authorize = vi.fn(async () => ({ ok: false as const, reason: 'blocked' }));

    const filled = await backfillMissingPreflightEvaluations(authorize);

    expect(filled).toBe(0);
    expect(authorize).toHaveBeenCalledTimes(1);
    expect(authorize).toHaveBeenCalledWith('eligible', null, 'preflight_backfill');
  });

  it('keeps going when one evaluation throws, leaving that app without evidence', async () => {
    const byId = installStore([app('a'), app('boom'), app('c')]);
    const authorize = vi.fn(async (id: string) => {
      if (id === 'boom') throw new Error('registry exploded');
      byId.get(id)!.latest_preflight_evidence_json = '{}';
      return { ok: true as const, binding: {} as never };
    });

    const filled = await backfillMissingPreflightEvaluations(authorize);

    expect(filled).toBe(2);
    expect(byId.get('boom')!.latest_preflight_evidence_json).toBeNull();
    expect(console.warn).toHaveBeenCalledWith(
      '[GitOps] Preflight backfill failed for %s: %s', 'boom', 'registry exploded',
    );
  });
});
