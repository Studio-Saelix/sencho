/**
 * Wiring tests for the node-local readiness rollup: the bounds one pass
 * applies, the degradation paths, and how the reported reason is chosen. The
 * canonical verdicts themselves are covered by the update-guard tests; this
 * file covers only selection, bounding, and reporting.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, type MockInstance } from 'vitest';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';
import type { FileSystemService as FileSystemServiceClass } from '../services/FileSystemService';
import type { UpdateGuardService as UpdateGuardServiceClass } from '../services/UpdateGuardService';
import type { DatabaseService as DatabaseServiceClass } from '../services/DatabaseService';
import type {
  ReadinessSignal,
  RollbackReadinessItem,
  RollbackReadinessReport,
  UpdateReadinessReport,
  ReadinessVerdict,
} from '../services/updateGuard/types';
import { aggregateRollbackOverall } from '../services/updateGuard/readiness';

let tmpDir: string;
let buildStackReadinessSummary: typeof import('../services/readiness/stackReadinessSummary').buildStackReadinessSummary;
let CacheService: typeof import('../services/CacheService').CacheService;
let FileSystemService: typeof import('../services/FileSystemService').FileSystemService;
let UpdateGuardService: typeof import('../services/UpdateGuardService').UpdateGuardService;
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;
let invalidateNodeCaches: typeof import('../helpers/cacheInvalidation').invalidateNodeCaches;

/** The local node; every call under test is node-scoped and never crosses the proxy. */
const NODE = 0;

let listStacks: MockInstance<FileSystemServiceClass['getStacksStrict']>;
let updateDetail: MockInstance<DatabaseServiceClass['getStackUpdateDetail']>;
let computeUpdate: MockInstance<UpdateGuardServiceClass['computeUpdateReadiness']>;
let computeRollback: MockInstance<UpdateGuardServiceClass['computeRollbackReadiness']>;

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ buildStackReadinessSummary } = await import('../services/readiness/stackReadinessSummary'));
  ({ CacheService } = await import('../services/CacheService'));
  ({ FileSystemService } = await import('../services/FileSystemService'));
  ({ UpdateGuardService } = await import('../services/UpdateGuardService'));
  ({ DatabaseService } = await import('../services/DatabaseService'));
  ({ invalidateNodeCaches } = await import('../helpers/cacheInvalidation'));
});

afterAll(() => {
  cleanupTestDb(tmpDir);
});

beforeEach(() => {
  vi.restoreAllMocks();
  CacheService.getInstance().flush();
  // Every collaborator is stubbed by default so a test only states the input it
  // is about. `getStacksStrict` is spied on the prototype because
  // `FileSystemService.getInstance()` builds a new instance per call.
  listStacks = vi.spyOn(FileSystemService.prototype, 'getStacksStrict').mockResolvedValue([]);
  updateDetail = vi.spyOn(DatabaseService.getInstance(), 'getStackUpdateDetail').mockReturnValue({});
  computeUpdate = vi.spyOn(UpdateGuardService.getInstance(), 'computeUpdateReadiness')
    .mockResolvedValue(updateReport('app', 'ready', []));
  computeRollback = vi.spyOn(UpdateGuardService.getInstance(), 'computeRollbackReadiness')
    .mockResolvedValue(rollbackReport('app', gatingReady()));
});

function signal(
  id: ReadinessSignal['id'],
  status: ReadinessSignal['status'],
  detail: string,
  affectsVerdict = true,
): ReadinessSignal {
  return { id, status, title: id, detail, affectsVerdict };
}

function updateReport(stack: string, verdict: ReadinessVerdict, signals: ReadinessSignal[]): UpdateReadinessReport {
  return { stack, computedAt: 1, verdict, signals, serviceName: null, advisories: [] };
}

function item(id: RollbackReadinessItem['id'], state: RollbackReadinessItem['state'], detail = ''): RollbackReadinessItem {
  return { id, state, label: id, detail };
}

/**
 * The overall state is derived from the items through the canonical aggregator
 * rather than declared, so a fixture cannot pair a verdict with the items that
 * produced it in a way the real service never would.
 */
function rollbackReport(stack: string, items: RollbackReadinessItem[]): RollbackReadinessReport {
  return { stack, computedAt: 1, overall: aggregateRollbackOverall(items), items };
}

/** The five items that can move the overall state, all satisfied. */
function gatingReady(): RollbackReadinessItem[] {
  return [
    item('compose_source', 'ready'),
    item('env_keys', 'ready'),
    item('previous_images', 'ready'),
    item('policy_eligibility', 'ready'),
    item('sops_keys', 'ready'),
  ];
}

/** The same five with the compose source unreadable, which lands the overall on `partial`. */
function gatingPartial(): RollbackReadinessItem[] {
  return [
    item('compose_source', 'unknown', 'Compose source could not be read'),
    item('env_keys', 'ready'),
    item('previous_images', 'ready'),
    item('policy_eligibility', 'ready'),
    item('sops_keys', 'ready'),
  ];
}

/** Run `body` with fake timers installed, restoring them even when it throws. */
async function withFakeTimers(body: () => Promise<void>): Promise<void> {
  vi.useFakeTimers();
  try {
    await body();
  } finally {
    vi.useRealTimers();
  }
}

describe('bounds and degradation', () => {
  it('reports both verdicts for an evaluated stack', async () => {
    listStacks.mockResolvedValue(['app']);
    computeUpdate.mockResolvedValue(updateReport('app', 'ready', [signal('preflight', 'ok', 'Compose Doctor passed')]));
    computeRollback.mockResolvedValue(rollbackReport('app', gatingReady()));

    const summary = await buildStackReadinessSummary(NODE);

    expect(summary.stacks).toEqual([
      { stack: 'app', update: { verdict: 'ready', topReason: null, computedAt: 1 }, rollback: { overall: 'ready', topReason: null, computedAt: 1 }, unavailableReason: null },
    ]);
    expect(summary.truncated).toBe(false);
  });

  it('keeps a partial row when one verdict fails', async () => {
    listStacks.mockResolvedValue(['app']);
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    computeUpdate.mockRejectedValue(new Error('docker socket closed'));
    computeRollback.mockResolvedValue(rollbackReport('app', gatingPartial()));

    const summary = await buildStackReadinessSummary(NODE);

    // The surviving rollback verdict is real evidence and must not be thrown
    // away because its sibling failed, so the row stays partial rather than
    // becoming unavailable.
    expect(summary.stacks[0].update).toBeNull();
    expect(summary.stacks[0].rollback).toMatchObject({ overall: 'partial' });
    expect(summary.stacks[0].unavailableReason).toBeNull();
    expect(logged).toHaveBeenCalledWith(
      'Readiness summary: update verdict failed for stack app:',
      'docker socket closed',
    );
  });

  it('degrades a stack to unavailable when both verdicts fail', async () => {
    listStacks.mockResolvedValue(['app']);
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    computeUpdate.mockRejectedValue(new Error('docker socket closed'));
    computeRollback.mockRejectedValue(new Error('docker socket closed'));

    const summary = await buildStackReadinessSummary(NODE);

    expect(summary.stacks).toEqual([
      { stack: 'app', update: null, rollback: null, unavailableReason: 'domain_error' },
    ]);
    // Both failures are logged, and each line names its own verdict: the row's
    // reason code is the only other trace and it does not say which side broke.
    expect(logged).toHaveBeenCalledTimes(2);
    expect(logged).toHaveBeenCalledWith(
      'Readiness summary: update verdict failed for stack app:',
      'docker socket closed',
    );
    expect(logged).toHaveBeenCalledWith(
      'Readiness summary: rollback verdict failed for stack app:',
      'docker socket closed',
    );
  });

  it('propagates a stack listing failure instead of reporting an empty node', async () => {
    listStacks.mockRejectedValue(new Error('EACCES: permission denied'));

    // An empty array here would be indistinguishable from a node with no
    // stacks, which is the misread the strict listing variant exists to avoid.
    await expect(buildStackReadinessSummary(NODE)).rejects.toThrow('EACCES: permission denied');
  });

  it('caps the pass and keeps the most interesting stacks', async () => {
    // The two `zz-` stacks sort after the fillers, so only their own rank can
    // move them ahead of it. `failed` already sorts first, so what proves its
    // rank is the absence of fillers from these three slots: without the
    // failed-check rank the alphabetical order would put two of them here.
    const filler = Array.from({ length: 27 }, (_, index) => `s${String(index).padStart(2, '0')}`);
    listStacks.mockResolvedValue(['failed', 'zz-updated', 'zz-drifted', ...filler]);
    updateDetail.mockReturnValue({
      'failed': { checkStatus: 'failed', hasUpdate: false, lastError: null, checkedAt: 1 },
      'zz-updated': { checkStatus: 'ok', hasUpdate: true, lastError: null, checkedAt: 1 },
    });
    // Seeded through the real writer so the drift rank is decided by the same
    // query the pass runs, not by a stub of it.
    DatabaseService.getInstance().insertDriftFinding({
      node_id: NODE,
      stack_name: 'zz-drifted',
      service: '',
      finding_type: 'image',
      severity: 'warning',
      message: 'Image tag differs from the running container',
      expected_json: null,
      actual_json: null,
      detected_at: 1,
    });

    const summary = await buildStackReadinessSummary(NODE);

    expect(summary.stacks).toHaveLength(25);
    expect(summary.truncated).toBe(true);
    expect(summary.stacks.map((row) => row.stack).slice(0, 3)).toEqual(['failed', 'zz-updated', 'zz-drifted']);
  });

  it('does not report truncation at exactly the cap', async () => {
    listStacks.mockResolvedValue(Array.from({ length: 25 }, (_, index) => `s${String(index).padStart(2, '0')}`));

    const summary = await buildStackReadinessSummary(NODE);

    expect(summary.stacks).toHaveLength(25);
    expect(summary.truncated).toBe(false);
  });

  it('bounds a never-settling verdict by the deadline', async () => {
    listStacks.mockResolvedValue(['slow']);
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => {});
    computeUpdate.mockReturnValue(new Promise(() => {}));
    computeRollback.mockReturnValue(new Promise(() => {}));

    await withFakeTimers(async () => {
      const pending = buildStackReadinessSummary(NODE);
      // Let the listing resolve so the per-stack work reaches its timer first.
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(6_001);

      const summary = await pending;

      expect(summary.stacks).toEqual([
        { stack: 'slow', update: null, rollback: null, unavailableReason: 'summary_truncated' },
      ]);
      expect(summary.truncated).toBe(true);
      expect(warned).toHaveBeenCalledWith(
        'Readiness summary: deadline reached for stack slow:',
        expect.stringContaining('Timeout: readiness summary for slow'),
      );
    });
  });

  it('re-runs the pass after a stack mutation invalidates the node caches', async () => {
    listStacks.mockResolvedValue(['app']);
    const first = await buildStackReadinessSummary(NODE);
    expect(first.stacks).toHaveLength(1);

    invalidateNodeCaches(NODE);
    listStacks.mockResolvedValue(['app', 'web']);

    // Verdicts are computed from on-disk state, so a deploy or edit that
    // invalidates the statuses has to invalidate these too: cached ones would
    // otherwise be served as fresh for the rest of the TTL.
    const second = await buildStackReadinessSummary(NODE);

    expect(second.stacks).toHaveLength(2);
    // The listing runs again, which a served cache entry would leave at one.
    // The pass timestamp cannot carry this assertion: consecutive passes land
    // in the same millisecond often enough to flake.
    expect(listStacks).toHaveBeenCalledTimes(2);
    expect(first.stacks).toHaveLength(1);
  });

  it('keys the pass by node', async () => {
    listStacks.mockResolvedValue(['app']);
    const first = await buildStackReadinessSummary(NODE);

    listStacks.mockResolvedValue(['web']);
    const other = await buildStackReadinessSummary(NODE + 1);

    // One listing per node: a node-blind cache key would serve the first node's
    // verdicts to the second and this count would stay at one.
    expect(listStacks).toHaveBeenCalledTimes(2);
    expect(first.stacks.map((row) => row.stack)).toEqual(['app']);
    expect(other.stacks.map((row) => row.stack)).toEqual(['web']);
  });

  it('marks every stack unavailable when the listing alone exhausts the budget', async () => {
    listStacks.mockImplementation(async () => {
      // The directory scan is one stat per entry and cannot be interrupted, so
      // it can consume the whole ceiling before any per-stack work starts.
      vi.setSystemTime(Date.now() + 6_001);
      return ['app', 'web'];
    });

    await withFakeTimers(async () => {
      const summary = await buildStackReadinessSummary(NODE);

      expect(summary.stacks.map((row) => row.unavailableReason)).toEqual([
        'summary_truncated',
        'summary_truncated',
      ]);
      expect(summary.truncated).toBe(true);
      expect(computeUpdate).not.toHaveBeenCalled();
    });
  });

  it('serves the previous pass and warns when the fresh one fails', async () => {
    listStacks.mockResolvedValue(['app']);
    const first = await buildStackReadinessSummary(NODE);
    expect(first.stale).toBe(false);

    await withFakeTimers(async () => {
      vi.setSystemTime(first.generatedAt + 120_001);
      listStacks.mockRejectedValue(new Error('compose dir unreadable'));
      const warned = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const second = await buildStackReadinessSummary(NODE);

      // The verdicts are the earlier pass's, unchanged and still worth serving;
      // `stale` is what stops them being read as a fresh read.
      expect(second.generatedAt).toBe(first.generatedAt);
      expect(second.stacks).toEqual(first.stacks);
      expect(second.stale).toBe(true);
      // The fetch error itself is discarded by the cache, so this line is the
      // only trace a failed pass leaves once an earlier entry exists.
      expect(warned).toHaveBeenCalledWith(
        `Readiness summary: serving an expired pass for node ${NODE}; the fresh pass failed`,
      );
    });
  });

  it('marks a reader that joined a failed fetch stale too, not only the one that ran it', async () => {
    listStacks.mockResolvedValue(['app']);
    const first = await buildStackReadinessSummary(NODE);

    await withFakeTimers(async () => {
      vi.setSystemTime(first.generatedAt + 120_001);
      const warned = vi.spyOn(console, 'warn').mockImplementation(() => {});
      let failFreshPass: (error: Error) => void = () => {};
      listStacks.mockImplementation(
        () => new Promise((_resolve, reject) => { failFreshPass = reject; }),
      );

      // Two readers, one fetch: the cache tells them apart as `stale` and
      // `inflight`, and only the first of those names the condition they are
      // both in. Deriving staleness from the age of the served pass instead
      // keeps the second reader from publishing expired verdicts as current,
      // which a fan-out across a fleet produces on every slow node.
      const owner = buildStackReadinessSummary(NODE);
      await vi.advanceTimersByTimeAsync(0);
      const joiner = buildStackReadinessSummary(NODE);
      await vi.advanceTimersByTimeAsync(0);
      failFreshPass(new Error('compose dir unreadable'));

      const [ownerResult, joinerResult] = await Promise.all([owner, joiner]);

      expect(ownerResult.stale).toBe(true);
      expect(joinerResult.stale).toBe(true);
      expect(joinerResult.generatedAt).toBe(first.generatedAt);
      expect(warned).toHaveBeenCalledTimes(2);
    });
  });
});

describe('reason selection', () => {
  // Every case here evaluates a single stack; only the verdict fixtures vary.
  beforeEach(() => {
    listStacks.mockResolvedValue(['app']);
  });

  it('quotes an unknown signal over a milder warning on the update side', async () => {
    computeUpdate.mockResolvedValue(updateReport('app', 'unknown', [
      signal('disk', 'warning', 'Free space is close to the threshold'),
      signal('containers', 'unknown', 'Docker probe did not answer'),
    ]));

    const summary = await buildStackReadinessSummary(NODE);

    // `aggregateVerdict` ranks a verdict-affecting unknown above a warning, so
    // the reason has to follow the same order or it explains the verdict with
    // the input that did not decide it.
    expect(summary.stacks[0].update?.topReason).toBe('Docker probe did not answer');
  });

  it('quotes a blocked signal over an attention one on the update side', async () => {
    computeUpdate.mockResolvedValue(updateReport('app', 'blocked', [
      signal('healthchecks', 'attention', 'A container is unhealthy'),
      signal('preflight', 'blocked', 'Compose Doctor found an unresolvable reference'),
    ]));

    const summary = await buildStackReadinessSummary(NODE);

    expect(summary.stacks[0].update?.topReason).toBe('Compose Doctor found an unresolvable reference');
  });

  it('quotes the first of two equally ranked signals', async () => {
    computeUpdate.mockResolvedValue(updateReport('app', 'ready_with_warnings', [
      signal('disk', 'warning', 'Free space is close to the threshold'),
      signal('drift', 'warning', 'Image tag differs from the running container'),
    ]));

    const summary = await buildStackReadinessSummary(NODE);

    // Equally ranked signals tie, and the first in canonical order wins so the
    // answer does not depend on which one the comparison happened to visit last.
    expect(summary.stacks[0].update?.topReason).toBe('Free space is close to the threshold');
  });

  it('quotes only signals that moved the verdict', async () => {
    computeUpdate.mockResolvedValue(updateReport('app', 'ready_with_warnings', [
      signal('drift', 'blocked', 'Drift finding is unresolved', false),
      signal('disk', 'warning', 'Free space is close to the threshold'),
    ]));

    const summary = await buildStackReadinessSummary(NODE);

    expect(summary.stacks[0].update?.topReason).toBe('Free space is close to the threshold');
  });

  it('leaves both reasons null when nothing is wrong', async () => {
    computeUpdate.mockResolvedValue(updateReport('app', 'ready', [signal('preflight', 'ok', 'Compose Doctor passed')]));
    computeRollback.mockResolvedValue(rollbackReport('app', [
      ...gatingReady(),
      // Disclosures never gate the overall state, so an unsettled one must not
      // be quoted as the reason for a verdict it cannot have produced.
      item('volume_data', 'not_covered', 'Application data is not part of a recovery generation'),
      item('managed_inputs', 'unknown', 'Managed inputs could not be enumerated'),
    ]));

    const summary = await buildStackReadinessSummary(NODE);

    expect(summary.stacks[0].update?.topReason).toBeNull();
    expect(summary.stacks[0].rollback?.topReason).toBeNull();
  });

  it('names the blocking gating item as the rollback reason', async () => {
    computeRollback.mockResolvedValue(rollbackReport('app', [
      ...gatingReady(),
      item('policy_eligibility', 'blocked', 'No recovery generation covers this stack'),
      item('volume_data', 'not_covered', 'Application data is not part of a recovery generation'),
    ]));

    const summary = await buildStackReadinessSummary(NODE);

    expect(summary.stacks[0].rollback?.topReason).toBe('No recovery generation covers this stack');
  });

  it('ranks a gating unknown above a gating warning on the rollback side', async () => {
    computeRollback.mockResolvedValue(rollbackReport('app', [
      item('env_keys', 'warning', 'Two optional keys are missing'),
      item('compose_source', 'unknown', 'Compose source could not be read'),
    ]));

    const summary = await buildStackReadinessSummary(NODE);

    expect(summary.stacks[0].rollback?.topReason).toBe('Compose source could not be read');
  });

  it('ranks a missing gating item above a gating warning on the rollback side', async () => {
    computeRollback.mockResolvedValue(rollbackReport('app', [
      item('env_keys', 'warning', 'Two optional keys are missing'),
      item('previous_images', 'missing', 'No previous image tag is recorded for this stack'),
    ]));

    const summary = await buildStackReadinessSummary(NODE);

    // Losing the previous image is a harder fact than a caveat about optional
    // keys, and this fixture also pins that `previous_images` is one of the
    // items allowed to decide the reason at all.
    expect(summary.stacks[0].rollback?.topReason).toBe('No previous image tag is recorded for this stack');
  });

  it('lets a blocked sops_keys item decide the rollback reason', async () => {
    computeRollback.mockResolvedValue(rollbackReport('app', [
      item('env_keys', 'warning', 'Two optional keys are missing'),
      item('sops_keys', 'blocked', 'The age key could not decrypt the stack secret'),
    ]));

    const summary = await buildStackReadinessSummary(NODE);

    expect(summary.stacks[0].rollback?.topReason).toBe('The age key could not decrypt the stack secret');
  });

  it('names an unreadable sops_keys item even when the overall is ready', async () => {
    // `aggregateRollbackOverall` reacts to `sops_keys === 'blocked'` alone, so an
    // age-identity read error leaves the overall `ready` with that item still
    // unknown. The reason is reported anyway: this filter quotes the strongest
    // non-ready gating item and leaves the verdict to its only owner, rather than
    // deriving a second overall state here that could disagree with it.
    computeRollback.mockResolvedValue(rollbackReport('app', [
      item('compose_source', 'ready'),
      item('env_keys', 'ready'),
      item('previous_images', 'ready'),
      item('policy_eligibility', 'ready'),
      item('sops_keys', 'unknown', 'Age identity readiness could not be read'),
    ]));

    const summary = await buildStackReadinessSummary(NODE);

    expect(summary.stacks[0].rollback?.overall).toBe('ready');
    expect(summary.stacks[0].rollback?.topReason).toBe('Age identity readiness could not be read');
  });

  it('quotes the first of two equally ranked gating items', async () => {
    computeRollback.mockResolvedValue(rollbackReport('app', [
      item('env_keys', 'warning', 'Two optional keys are missing'),
      item('compose_source', 'warning', 'The compose file is not tracked by git'),
    ]));

    const summary = await buildStackReadinessSummary(NODE);

    expect(summary.stacks[0].rollback?.topReason).toBe('Two optional keys are missing');
  });

  it('reports no reason when the strongest gap carries no detail', async () => {
    computeRollback.mockResolvedValue(rollbackReport('app', [
      item('compose_source', 'blocked', ''),
    ]));

    const summary = await buildStackReadinessSummary(NODE);

    // An empty string would render as a blank explanation under a non-ready
    // verdict; null is the contract's way of saying no detail is available, so a
    // consumer falls back to the verdict's own copy.
    expect(summary.stacks[0].rollback?.topReason).toBeNull();
  });

  it('redacts credential-shaped text in a reason', async () => {
    computeUpdate.mockResolvedValue(updateReport('app', 'review_required', [
      signal('drift', 'attention', 'Override differs: api_key: supersecret'),
    ]));

    const summary = await buildStackReadinessSummary(NODE);

    expect(summary.stacks[0].update?.topReason).toBe('Override differs: api_key: [redacted]');
  });
});
