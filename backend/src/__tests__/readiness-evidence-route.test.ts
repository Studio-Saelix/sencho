/**
 * Route tests for GET /api/readiness/evidence: auth, the two-domain payload,
 * per-domain degradation, and the freshness the Workloads cell derives from.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { setupTestDb, cleanupTestDb, loginAsTestAdmin } from './helpers/setupTestDb';
import * as selfStackGuard from '../helpers/selfStackGuard';
import * as permissions from '../middleware/permissions';
import * as securityOverview from '../services/securityOverview';
import type { SecurityOverviewResponse } from '../services/securityOverview';
import { CacheService } from '../services/CacheService';
import { DatabaseService } from '../services/DatabaseService';
import DockerController from '../services/DockerController';
import { FileSystemService } from '../services/FileSystemService';
import { NodeRegistry } from '../services/NodeRegistry';
import { STACK_STATUSES_CACHE_TTL_MS } from '../helpers/constants';

let tmpDir: string;
let app: import('express').Express;
let authCookie: string;
let viewerCookie: string;
let nodeId: number;

let stacksSpy: ReturnType<typeof vi.spyOn>;
let strictSpy: ReturnType<typeof vi.spyOn>;
let bulkSpy: ReturnType<typeof vi.spyOn>;
let identitySpy: ReturnType<typeof vi.spyOn>;

/**
 * Mock both stack listings together. The route reads the soft listing's output
 * from the status payload and confirms its count against the strict listing, so
 * a test that mocks one without the other is describing a node whose two reads
 * disagree, which is a state this suite tests on purpose in exactly one place.
 */
function mockStacks(names: string[]): void {
  stacksSpy.mockResolvedValue(names);
  strictSpy.mockResolvedValue(names);
}

/**
 * Seed the status entry the route reads with a pass older than its cache TTL.
 *
 * The three cases that use this share one setup and differ in what happens to
 * the refresh: bytes are already in the entry and their window has run out, so
 * the read is a served expired pass rather than a fresh compute.
 */
function seedExpiredStatusPass(): void {
  CacheService.getInstance().set(
    `stack-statuses:${nodeId}`,
    {
      generatedAt: Date.now() - STACK_STATUSES_CACHE_TTL_MS - 5_000,
      data: { web: { status: 'running', source: 'local' as const, isSelf: false } },
      degraded: false,
    },
    0,
  );
}

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ app } = await import('../index'));
  authCookie = await loginAsTestAdmin(app);
  nodeId = NodeRegistry.getInstance().getDefaultNodeId();

  const bcrypt = (await import('bcrypt')).default;
  const viewerHash = await bcrypt.hash('viewerpass', 1);
  DatabaseService.getInstance().addUser({ username: 'readiness-evidence-viewer', password_hash: viewerHash, role: 'viewer' });
  const loginRes = await request(app)
    .post('/api/auth/login')
    .send({ username: 'readiness-evidence-viewer', password: 'viewerpass' });
  const cookies = loginRes.headers['set-cookie'] as string | string[];
  viewerCookie = Array.isArray(cookies) ? cookies[0] : cookies;
});

afterAll(() => {
  cleanupTestDb(tmpDir);
});

beforeEach(() => {
  // Flushed per test so each one computes its own workload payload: the route
  // reads the shared `stack-statuses:<nodeId>` entry, and a payload cached by an
  // earlier test would answer for this one.
  CacheService.getInstance().flush();
  // A node with no stacks is the baseline; tests that need stacks override both
  // listings through `mockStacks`. Both are mocked rather than left to read the
  // empty COMPOSE_DIR so that no test reports a listing mismatch by accident.
  stacksSpy = vi.spyOn(FileSystemService.prototype, 'getStacks').mockResolvedValue([]);
  strictSpy = vi.spyOn(FileSystemService.prototype, 'getStacksStrict').mockResolvedValue([]);
  bulkSpy = vi.spyOn(DockerController.prototype, 'getBulkStackStatuses').mockResolvedValue({});
  // Identity resolution pinned per test instead of probing containers; the test
  // that needs a failed resolution overrides this with `degraded: true`.
  identitySpy = vi
    .spyOn(selfStackGuard, 'resolveSelfStackIdentity')
    .mockResolvedValue({ projectName: 'sencho', labels: null, degraded: false });
});

afterEach(() => {
  stacksSpy.mockRestore();
  strictSpy.mockRestore();
  bulkSpy.mockRestore();
  identitySpy.mockRestore();
  vi.restoreAllMocks();
});

describe('GET /api/readiness/evidence', () => {
  it('requires authentication', async () => {
    const res = await request(app).get('/api/readiness/evidence');
    expect(res.status).toBe(401);
  });

  // Every shipped role holds `stack:read`, so this pins the integration rather
  // than a permission: there is no role to drive the denial branch with.
  it('answers a non-admin role holding stack:read', async () => {
    const res = await request(app).get('/api/readiness/evidence').set('Cookie', viewerCookie);
    expect(res.status).toBe(200);
  });

  // Every shipped role holds `stack:read`, so no persona can drive the denial
  // through the resolver: an assertion that logged in as someone and got a 403
  // could not be written, and deleting the guard would fail none of the tests
  // above. What is left to pin is the handler's half of the contract, which is
  // also the half a refactor breaks: which action it asks about, and that a
  // refusal ends the request before the node is read. The resolver's role
  // mapping is covered by the permission suites.
  it('refuses a caller the guard turns away, before reading the node', async () => {
    const guard = vi.spyOn(permissions, 'requirePermission').mockImplementation((_req, res): boolean => {
      res.status(403).json({ error: 'Permission denied.', code: 'PERMISSION_DENIED' });
      return false;
    });

    const res = await request(app).get('/api/readiness/evidence').set('Cookie', authCookie);

    expect(res.status).toBe(403);
    expect(guard).toHaveBeenCalledWith(expect.anything(), expect.anything(), 'stack:read');
    // Neither listing nor the Docker socket is touched for a refused request.
    expect(stacksSpy).not.toHaveBeenCalled();
    expect(strictSpy).not.toHaveBeenCalled();
    expect(bulkSpy).not.toHaveBeenCalled();
    guard.mockRestore();
  });

  it('carries both domains for a node with no stacks', async () => {
    const res = await request(app).get('/api/readiness/evidence').set('Cookie', authCookie);

    expect(res.status).toBe(200);
    // The top-level field set is pinned so a renamed or dropped domain is caught
    // here rather than by the hub reading undefined.
    expect(Object.keys(res.body).sort()).toEqual(['generatedAt', 'security', 'workloads']);
    expect(res.body.generatedAt).toBeLessThanOrEqual(Date.now());
    expect(res.body.workloads).toEqual({
      generatedAt: expect.any(Number),
      counts: {},
      degraded: false,
      stale: false,
      problems: [],
    });
    // Security passes the posture pass through; the fields here are the ones the
    // hub maps to reason codes, so their names are the contract.
    expect(Object.keys(res.body.security).sort()).toEqual([
      'failedScans',
      'generatedAt',
      'lastSuccessfulScanAt',
      'posture',
      'posturePartial',
      'scannerAvailable',
      'staleScans',
    ]);
    // The pass carries its own instant so the hub ages the Security cell by when
    // it ran rather than by when the payload finished. It cannot be later than
    // the payload's own stamp, which is taken after this pass returns.
    expect(res.body.security.generatedAt).toBeLessThanOrEqual(res.body.generatedAt);
    // Nothing has been scanned on a fresh node, so the canonical pass derives
    // `'Unknown'` however the scanner itself is set up: an unscanned node is not
    // a node with a clean bill of health. Asserted as a value rather than a type
    // because the hub keys its reason codes off this exact word.
    expect(res.body.security.posture).toBe('Unknown');
    expect(res.body.security.lastSuccessfulScanAt).toBeNull();
    expect(res.body.security.staleScans).toBe(0);
    expect(res.body.security.failedScans).toBe(0);
  });

  it('counts every status and names each stack that is not running', async () => {
    mockStacks(['web', 'db', 'api']);
    bulkSpy.mockResolvedValue({
      web: { status: 'running' },
      db: { status: 'exited' },
      api: { status: 'unknown' },
    });

    const res = await request(app).get('/api/readiness/evidence').set('Cookie', authCookie);

    // Counts cover the whole node; problems name every stack behind the
    // non-running ones so a finding can point at a stack rather than a total.
    expect(res.body.workloads.counts).toEqual({ running: 1, exited: 1, unknown: 1 });
    expect(res.body.workloads.problems).toEqual([
      { stack: 'db', status: 'exited' },
      { stack: 'api', status: 'unknown' },
    ]);
  });

  it('counts two stacks that share a status rather than the last one seen', async () => {
    // Every status above appears once, so a tally that overwrites instead of
    // accumulating answers it correctly. This is the first fixture with two
    // stacks sharing a status, and the hub reduces these counts into the node's
    // stack total, so an overwrite reports a node smaller than it is.
    mockStacks(['web', 'api', 'db']);
    bulkSpy.mockResolvedValue({
      web: { status: 'running' },
      api: { status: 'running' },
      db: { status: 'exited' },
    });

    const res = await request(app).get('/api/readiness/evidence').set('Cookie', authCookie);

    expect(res.body.workloads.counts).toEqual({ running: 2, exited: 1 });
    expect(res.body.workloads.problems).toEqual([{ stack: 'db', status: 'exited' }]);
  });

  it('reports a partial stack as a problem', async () => {
    mockStacks(['web']);
    bulkSpy.mockResolvedValue({ web: { status: 'partial', running: 1, total: 2 } });

    const res = await request(app).get('/api/readiness/evidence').set('Cookie', authCookie);

    // Half a stack up is not a running stack, and it is not an unknown one
    // either: the reason code has to be able to say which.
    expect(res.body.workloads.problems).toEqual([{ stack: 'web', status: 'partial' }]);
    expect(res.body.workloads.counts).toEqual({ partial: 1 });
  });

  it('carries a failed identity resolution as degraded, not as a clean read', async () => {
    mockStacks(['web']);
    bulkSpy.mockResolvedValue({ web: { status: 'running' } });
    identitySpy.mockResolvedValue({ projectName: null, labels: null, degraded: true });

    const res = await request(app).get('/api/readiness/evidence').set('Cookie', authCookie);

    // The counts are correct and the flag is still set: identity feeds `source`
    // and `isSelf` only, so the failure is not a caveat on the tally but a
    // finding of its own, and the hub has to be able to see it.
    expect(res.body.workloads.counts).toEqual({ running: 1 });
    expect(res.body.workloads.degraded).toBe(true);
    expect(res.body.workloads.stale).toBe(false);
  });

  it('degrades only the workload domain when the container read fails', async () => {
    mockStacks(['web']);
    bulkSpy.mockRejectedValue(new Error('connect ENOENT /var/run/docker.sock'));
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await request(app).get('/api/readiness/evidence').set('Cookie', authCookie);

    expect(res.status).toBe(200);
    expect(res.body.workloads).toBeNull();
    // The security evidence survives its sibling's failure; a 500 here would
    // erase a domain that answered.
    expect(res.body.security).not.toBeNull();
    // The failure is named in the log, not just counted: this is the only place
    // it shows up, since the response reports a null domain either way.
    expect(logged).toHaveBeenCalledWith(
      expect.stringContaining(`workload facts failed for node ${nodeId}`),
      expect.stringContaining('docker.sock'),
    );
  });

  it('degrades only the security domain when the posture pass fails', async () => {
    const postureSpy = vi
      .spyOn(securityOverview, 'buildSecurityOverview')
      .mockImplementation(() => {
        throw new Error('scan summaries unavailable');
      });
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await request(app).get('/api/readiness/evidence').set('Cookie', authCookie);

    expect(res.status).toBe(200);
    expect(res.body.security).toBeNull();
    expect(res.body.workloads).not.toBeNull();
    expect(res.body.workloads.counts).toEqual({});
    expect(logged).toHaveBeenCalledWith(
      expect.stringContaining(`security facts failed for node ${nodeId}`),
      expect.stringContaining('scan summaries unavailable'),
    );
    postureSpy.mockRestore();
  });

  it('degrades both domains to null rather than failing the request', async () => {
    mockStacks(['web']);
    // Both throws carry a credential, one per redaction rule: a registry URL
    // with an inline password, and a `token=` assignment. A failure message is
    // written to the log, and the message is the field a log pipeline indexes.
    bulkSpy.mockRejectedValue(
      new Error('failed to inspect https://ci:hunter2@registry.internal/app:1.0: connect ENOENT /var/run/docker.sock'),
    );
    const postureSpy = vi
      .spyOn(securityOverview, 'buildSecurityOverview')
      .mockImplementation(() => {
        throw new Error('scan summaries unavailable for token=abc123secret');
      });
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await request(app).get('/api/readiness/evidence').set('Cookie', authCookie);

    // The shape is the contract even when no domain answered: the hub reads
    // this as two `domain_error` cells, and a 500 or a bare `{}` would read as a
    // node that never spoke at all.
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      generatedAt: expect.any(Number),
      workloads: null,
      security: null,
    });
    // Asserted on the redacted form rather than on the message merely containing
    // the failure text, so a dropped redaction is a failure here. The message is
    // the whole payload of the log line, which is the property these two share:
    // a raw error is not logged beside it, because `console.error` prints an
    // `Error` by its stack and a stack's first line is the message these
    // assertions prove was redacted.
    expect(logged).toHaveBeenCalledWith(
      expect.stringContaining('workload facts failed'),
      expect.stringContaining('https://[redacted]@registry.internal/app:1.0'),
    );
    expect(logged).toHaveBeenCalledWith(
      expect.stringContaining('security facts failed'),
      expect.stringContaining('token=[redacted]'),
    );
    postureSpy.mockRestore();
  });

  it('passes the posture inputs through without reshuffling them', async () => {
    // Distinct, non-zero values on purpose: at the fresh-install baseline every
    // count here is zero and every flag false, so a transposed pair or a
    // hardcoded field would read as a pass. The hub keys its reason codes off
    // exactly these fields. The scanner flag stays false and is the one field
    // this fixture does not move: whether a scanner answers depends on the host
    // the suite runs on, so the other six carry the check.
    const original = securityOverview.buildSecurityOverview;
    const postureSpy = vi
      .spyOn(securityOverview, 'buildSecurityOverview')
      .mockImplementation((id: number): SecurityOverviewResponse => {
        const base = original(id);
        return {
          ...base,
          posture: 'Action needed',
          posturePartial: true,
          scanner: { ...base.scanner, available: false },
          staleScans: 3,
          failedScans: 7,
          lastSuccessfulScanAt: 1_700_000_000_000,
        };
      });

    const res = await request(app).get('/api/readiness/evidence').set('Cookie', authCookie);

    expect(res.body.security).toEqual({
      generatedAt: expect.any(Number),
      posture: 'Action needed',
      posturePartial: true,
      scannerAvailable: false,
      staleScans: 3,
      failedScans: 7,
      lastSuccessfulScanAt: 1_700_000_000_000,
    });
    postureSpy.mockRestore();
  });

  it('treats an empty status payload from a failed listing as a failure, not an empty node', async () => {
    // The status read swallows a listing failure into an empty payload, so an
    // empty result has to be confirmed before it can be reported as "no stacks".
    // The strict listing is what propagates, and here it does.
    mockStacks([]);
    strictSpy.mockRejectedValue(new Error('EACCES: permission denied'));
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await request(app).get('/api/readiness/evidence').set('Cookie', authCookie);

    expect(res.status).toBe(200);
    // The listing that could not be read is what nulls the domain, not the empty
    // payload: a tally the node's own listing did not confirm is not evidence
    // this domain publishes, whichever branch served the payload behind it. The
    // sibling case, where there were bytes behind the failure, is the same rule
    // with more to lose.
    expect(res.body.workloads).toBeNull();
    expect(logged).toHaveBeenCalledWith(
      expect.stringContaining(`workload facts failed for node ${nodeId}`),
      expect.stringContaining('EACCES'),
    );
  });

  it('flags a payload that disagrees with the node listing rather than reporting it clean', async () => {
    // The other half of the same guard, and the reason it runs on every request
    // rather than only for an empty payload: the status read drops an unreadable
    // stack directory silently, so a payload can come back short without being
    // empty. Here the payload says the node has no stacks while a listing that
    // propagates says it has two. Reported as a healthy empty node this would
    // hide both stacks behind a green cell; thrown away entirely it would
    // discard the counts that did come back clean, so it is kept and marked.
    mockStacks([]);
    strictSpy.mockResolvedValue(['web', 'db']);
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const res = await request(app).get('/api/readiness/evidence').set('Cookie', authCookie);

    expect(res.status).toBe(200);
    expect(res.body.workloads.degraded).toBe(true);
    expect(res.body.workloads.counts).toEqual({});
    expect(res.body.workloads.problems).toEqual([]);
    // Both counts are named, so the log distinguishes "short by two" from "read
    // nothing", which is what a reader needs to tell a partial drop apart from a
    // failed listing.
    expect(warned).toHaveBeenCalledWith(expect.stringContaining('reports 2 stacks against a payload of 0'));
  });

  it('reads the container statuses once for two sequential requests', async () => {
    mockStacks(['web']);
    bulkSpy.mockResolvedValue({ web: { status: 'running' } });

    const first = await request(app).get('/api/readiness/evidence').set('Cookie', authCookie);
    const second = await request(app).get('/api/readiness/evidence').set('Cookie', authCookie);

    expect(first.body.workloads.counts).toEqual({ running: 1 });
    expect(second.body.workloads.counts).toEqual({ running: 1 });
    // The second answer came from the entry the first request wrote. Without
    // that write, every hub poll would re-read the Docker socket on every node.
    expect(bulkSpy).toHaveBeenCalledTimes(1);
    // Neither answer is stale, and the field is read from the payload's age
    // rather than from the cache outcome: two readers of the same bytes get
    // different outcomes (the first computed the entry, the second got a hit),
    // so the outcome says which request this was and the stamp says how old the
    // evidence is.
    expect(first.body.workloads.stale).toBe(false);
    expect(second.body.workloads.stale).toBe(false);
    // The hit re-serves the stamp of the read it came from rather than taking a
    // fresh one, which is why the two answers agree about staleness at all.
    expect(second.body.workloads.generatedAt).toBe(first.body.workloads.generatedAt);
  });

  it('serves the stored pass when a refresh fails, and says it is stale', async () => {
    // An entry that has already expired plus a refresh that fails is the state
    // `CacheService` serves old bytes from: the caller gets a 200 either way and
    // the failure is in no field but this one.
    mockStacks(['web']);
    seedExpiredStatusPass();
    bulkSpy.mockRejectedValue(new Error('connect ENOENT /var/run/docker.sock'));
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const res = await request(app).get('/api/readiness/evidence').set('Cookie', authCookie);

    expect(res.body.workloads.stale).toBe(true);
    expect(res.body.workloads.counts).toEqual({ running: 1 });
    // The workload facts still arrive, flagged, rather than as a null domain:
    // old evidence labelled stale is more useful to the hub than no evidence,
    // and the flag is what keeps it out of a healthy cell.
    expect(res.body.workloads.degraded).toBe(false);
    expect(warned).toHaveBeenCalledWith(expect.stringContaining('expired stack status read'));
  });

  it('reports no workload evidence when a served payload cannot be confirmed', async () => {
    // The same expired entry as above, with the listing that confirms it also
    // failing. There are bytes to keep here, unlike a cold cache, and they are
    // still not published: the confirmation is what separates a small node from
    // one whose stacks were not read, and a tally that failed it is not evidence
    // this domain reports however recently it was computed.
    mockStacks(['web']);
    seedExpiredStatusPass();
    bulkSpy.mockRejectedValue(new Error('connect ENOENT /var/run/docker.sock'));
    strictSpy.mockRejectedValue(new Error('EACCES: permission denied'));
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await request(app).get('/api/readiness/evidence').set('Cookie', authCookie);

    expect(res.status).toBe(200);
    expect(res.body.workloads).toBeNull();
    // The security domain is untouched by either failure.
    expect(res.body.security).not.toBeNull();
    // The listing is the failure named in the log, not the refresh the cache
    // already swallowed silently.
    expect(logged).toHaveBeenCalledWith(
      expect.stringContaining(`workload facts failed for node ${nodeId}`),
      expect.stringContaining('EACCES'),
    );
    expect(warned).toHaveBeenCalledWith(expect.stringContaining('expired stack status read'));
  });

  it('marks a joiner stale on the same bytes the in-flight refresh is replacing', async () => {
    // The case the payload timestamp exists for. The caller that runs a failing
    // refresh is told `stale` by the cache; a caller that joins that same refresh
    // is told `inflight`, on identical old bytes. Only the payload's own age
    // names the condition for both, so `stale` is derived from it rather than
    // from the cache outcome.
    mockStacks(['web']);
    seedExpiredStatusPass();
    const lookups = vi.spyOn(CacheService.prototype, 'getOrFetchWithMeta');
    const pending: Array<(error: Error) => void> = [];
    bulkSpy.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          pending.push(reject);
        }),
    );
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Sent, not awaited: supertest dispatches on `then`, and the ordering below
    // is what makes the join happen rather than a race.
    const owner = request(app)
      .get('/api/readiness/evidence')
      .set('Cookie', authCookie)
      .then((r) => r);
    // Wait for the owner to be inside the cache, then for the joiner to be too:
    // a second lookup can only be the joiner, since the owner's fetch is still
    // pending and nothing else has touched this key. The inflight check is in
    // the synchronous prefix of the cache entry point, so a recorded second call
    // means the join has already happened.
    // The budget is raised because `vi.waitFor` defaults to a fixed 1s of its
    // own, which the configured test timeout does not scale: the waits below are
    // the only place in this suite where a loaded machine fails the test without
    // any behavior changing.
    await vi.waitFor(() => expect(lookups).toHaveBeenCalledTimes(1), { timeout: 10_000 });
    const joiner = request(app)
      .get('/api/readiness/evidence')
      .set('Cookie', authCookie)
      .then((r) => r);
    await vi.waitFor(() => expect(lookups).toHaveBeenCalledTimes(2), { timeout: 10_000 });
    for (const reject of pending) reject(new Error('connect ENOENT /var/run/docker.sock'));

    const [ownerRes, joinerRes] = await Promise.all([owner, joiner]);

    // The joiner inherited the owner's read rather than starting its own.
    expect(bulkSpy).toHaveBeenCalledTimes(1);
    expect(ownerRes.body.workloads.stale).toBe(true);
    expect(joinerRes.body.workloads.stale).toBe(true);
    expect(joinerRes.body.workloads.counts).toEqual({ running: 1 });
    // Both callers served the same expired pass, so both are told so.
    expect(warned).toHaveBeenCalledTimes(2);
  });

  it('stamps the workload payload when the read finishes, not when it starts', async () => {
    // `stale` above is this payload's timestamp compared against the cache TTL,
    // which is only the cache's own expiry condition if the stamp is taken where
    // `CacheService` starts the entry's clock: when the fetcher returns. A stamp
    // taken at the start of the read would report itself stale for the last
    // fetch-duration milliseconds of every entry's life, and would do it for a
    // read that had just succeeded. This read is made longer than the whole TTL,
    // so the two stamps land on opposite answers rather than a millisecond
    // apart, and the warning below is the observable half of the same claim.
    mockStacks(['web']);
    // Anchored to the real clock, not an arbitrary epoch: JWT expiry is checked
    // against `Date.now()`, so a frozen clock in the future invalidates the
    // session cookie and the request never reaches the route. The reads below
    // only move it forward by the TTL, which leaves the token valid.
    const start = Date.now();
    let clock = start;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => clock);
    bulkSpy.mockImplementation(async () => {
      clock += STACK_STATUSES_CACHE_TTL_MS + 1_000;
      return { web: { status: 'running' } };
    });
    // The confirmation listing runs after the workload facts are assembled, so
    // moving the clock here separates the stamp the payload carries from one
    // taken by reading the clock at assembly time. Without it the two land on
    // the same millisecond and the value assertion below cannot tell them apart.
    strictSpy.mockImplementation(async () => {
      clock += 1_000;
      return ['web'];
    });
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const res = await request(app).get('/api/readiness/evidence').set('Cookie', authCookie);

    expect(res.body.workloads.stale).toBe(false);
    // The published stamp is the read's own instant, exactly: not a fresh
    // reading of the clock at assembly time, and not a placeholder.
    expect(res.body.workloads.generatedAt).toBe(start + STACK_STATUSES_CACHE_TTL_MS + 1_000);
    expect(warned).not.toHaveBeenCalled();
    nowSpy.mockRestore();
  });
});
