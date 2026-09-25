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
import type { FutureRolloutAuthorizationBinding } from '../services/gitops/types';

type App = {
  id: string;
  rollout_authorization_ref: string | null;
  latest_preflight_evidence_json: string | null;
};

type LiveApps = { withoutBinding?: string[]; withoutApproval?: string[] };

const STUB_BINDING: FutureRolloutAuthorizationBinding = {
  rolloutCandidateId: 'cand-1',
  acceptedGenerationId: 'gen-1',
  artifactSetId: 'art-1',
  intentRevisionId: 'intent-1',
  requiredNodeIds: [1],
  sourceAcceptanceRef: 'acc-1',
  placementApprovalRef: 'place-1',
  preflightFingerprint: 'fp-1',
};

function installStore(apps: App[], live: LiveApps = {}) {
  const byId = new Map(apps.map((a) => [a.id, a]));
  const withoutBinding = new Set(live.withoutBinding ?? []);
  const withoutApproval = new Set(live.withoutApproval ?? []);
  const store = {
    listAuthorizedBlueprintApplications: () => apps,
    getApplication: (id: string) => byId.get(id),
    currentAuthorizationBinding: (row: App) => (withoutBinding.has(row.id) ? null : STUB_BINDING),
    resolveApprovalRef: (ref: string) => (withoutApproval.has(ref) ? null : { id: ref }),
  };
  vi.spyOn(GitOpsStore, 'getInstance').mockReturnValue(store as unknown as GitOpsStore);
  return byId;
}

function app(id: string, overrides: Partial<App> = {}): App {
  return {
    id,
    rollout_authorization_ref: `ref-${id}`,
    latest_preflight_evidence_json: null,
    ...overrides,
  };
}

function markEvidence(byId: Map<string, App>, id: string): void {
  byId.get(id)!.latest_preflight_evidence_json = '{}';
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
      markEvidence(byId, id);
      inFlight -= 1;
      return { ok: false as const, reason: 'recorded evidence only' };
    });

    const filled = await backfillMissingPreflightEvaluations(authorize);

    expect(filled).toBe(10);
    expect(authorize).toHaveBeenCalledTimes(10);
    // Above 1 is the regression guard: a serial loop never overlaps two probes.
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(PREFLIGHT_BACKFILL_CONCURRENCY);
    // The cap stays modest: the probes are network-bound, the writes are not.
    expect(PREFLIGHT_BACKFILL_CONCURRENCY).toBeLessThanOrEqual(4);
  });

  it('skips apps that already have evidence, or whose authorization no longer resolves', async () => {
    installStore(
      [
        app('has-evidence', { latest_preflight_evidence_json: '{}' }),
        app('binding-gone'),
        app('approval-gone'),
        app('eligible'),
      ],
      { withoutBinding: ['binding-gone'], withoutApproval: ['ref-approval-gone'] },
    );
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
      markEvidence(byId, id);
      return { ok: false as const, reason: 'recorded evidence only' };
    });

    const filled = await backfillMissingPreflightEvaluations(authorize);

    expect(filled).toBe(2);
    expect(byId.get('boom')!.latest_preflight_evidence_json).toBeNull();
    // The thrown app is reported once, by the failure itself: the tally reads
    // stored evidence, so there is nothing further to say about it.
    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(console.warn).toHaveBeenCalledWith(
      '[GitOps] Preflight backfill failed for %s: %s',
      'boom',
      'registry exploded',
    );
  });

  it('tallies an app that recorded evidence before failing', async () => {
    const byId = installStore([app('late-writer')]);
    const authorize = vi.fn(async (id: string) => {
      markEvidence(byId, id);
      throw new Error('mint raced');
    });

    expect(await backfillMissingPreflightEvaluations(authorize)).toBe(1);
  });

  it('tallies by stored evidence, not by the authorization verdict', async () => {
    const byId = installStore([app('a')]);
    const authorize = vi.fn(async (id: string) => {
      markEvidence(byId, id);
      return { ok: false as const, reason: 'Rollout authorization failed: raced' };
    });

    expect(await backfillMissingPreflightEvaluations(authorize)).toBe(1);
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('warns when an app neither records evidence nor explains a refusal', async () => {
    const byId = installStore([app('silent')]);
    const authorize = vi.fn(async () => ({ ok: false as const, reason: 'unreachable verdict' }));

    expect(await backfillMissingPreflightEvaluations(authorize)).toBe(0);
    expect(console.warn).toHaveBeenCalledWith(
      '[GitOps] Preflight backfill could not authorize %s: %s',
      'silent',
      'unreachable verdict',
    );
    expect(byId.get('silent')!.latest_preflight_evidence_json).toBeNull();
  });
});
