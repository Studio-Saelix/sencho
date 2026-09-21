/**
 * Fleet readiness: the hub-side fan-out behind GET /api/fleet/readiness.
 *
 * These cases own the hub's behavior: the bounded per-node budget, per-domain
 * degradation, the truthful reachability classification, finding ordering, the
 * admin-only Control domain, and route input validation. The node-local
 * producers the fan-out calls (the evidence route and the per-stack summary)
 * have their own suites, so the fixtures here are deliberately minimal payloads
 * rather than realistic ones.
 *
 * A remote that should hang stays pending until the request's AbortSignal fires
 * and only then rejects. A mock that rejected on its own would let a missing
 * signal look like a fast offline answer, which is the regression these cases
 * exist to catch.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import { setupTestDb, cleanupTestDb, TEST_USERNAME, TEST_JWT_SECRET } from './helpers/setupTestDb';
import { READINESS_DOMAINS } from '../services/readiness/types';
import { SYNC_ERROR_CODES } from '../services/fleetSyncConstants';
import type { ProxyTarget } from '../services/NodeRegistry';
import type {
  FindingSeverity,
  FleetReadinessNode,
  FleetReadinessResponse,
  ReadinessFinding,
  StackReadinessRow,
} from '../services/readiness/types';
import type { ReadinessVerdict, RollbackOverall } from '../services/updateGuard/types';

let tmpDir: string;
let app: import('express').Express;
let authHeader: string;
let viewerAuthHeader: string;
let NodeRegistry: typeof import('../services/NodeRegistry').NodeRegistry;
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;

const PROXY_BASE = 'http://remote.example.com';
const HEALTHY_BASE = 'http://good-host.example.com';
const PRIOR_CONTACT = 1_700_000_000;
/**
 * A node that never answers settles when its longest read gives up, and that is
 * the tier-two summary at its 8s budget. The floor catches a row that returned
 * early instead of waiting on it; the header and the hang helper state why the
 * mock is built to hang rather than to reject.
 */
const HUNG_ROW_FLOOR_MS = 1_500;
/** That 8s budget plus a second and a half of slack for the request round trip. */
const HUNG_ROW_CEILING_MS = 9_500;
const FAST_PATH_CEILING_MS = 2_000;
const LOCAL_READ_CEILING_MS = 4_000;
/**
 * A row that owes only the evidence read settles on that read's own budget
 * rather than the longer one the summary gets. The floor catches a row that
 * returned before the read gave up; the ceiling is what says a request for the
 * cheap domains did not pay for the expensive tier it never asked for.
 */
const TIER_ONE_FLOOR_MS = 2_500;
const TIER_ONE_CEILING_MS = 5_000;
const EVIDENCE_PATH = '/api/readiness/evidence';
const SUMMARY_PATH = '/api/stacks/readiness-summary';
const ALL_DOMAINS = READINESS_DOMAINS.join(',');
/**
 * The domains the two node-local reads feed, which is every domain except the
 * two the hub answers by itself: Connectivity from its own probe, Control from
 * its own sync rows. A node that answers nothing therefore leaves exactly these
 * four unread, so the cases about a failed read assert them as one list.
 */
const NODE_LOCAL_DOMAINS = ['workloads', 'updates', 'recovery', 'security'] as const;

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ app } = await import('../index'));
  ({ NodeRegistry } = await import('../services/NodeRegistry'));
  ({ DatabaseService } = await import('../services/DatabaseService'));

  const token = jwt.sign({ username: TEST_USERNAME }, TEST_JWT_SECRET, { expiresIn: '1m' });
  authHeader = `Bearer ${token}`;

  const db = DatabaseService.getInstance();
  const hash = await bcrypt.hash('password123', 1);
  db.addUser({ username: 'readiness-viewer', password_hash: hash, role: 'viewer' });
  const viewer = db.getUserByUsername('readiness-viewer')!;
  // The request helper takes a whole header value, so the scheme goes on here
  // rather than inside the helper, exactly as `authHeader` is built above.
  const viewerJwt = jwt.sign(
    { username: 'readiness-viewer', role: 'viewer', tv: viewer.token_version },
    TEST_JWT_SECRET,
    { expiresIn: '1m' },
  );
  viewerAuthHeader = `Bearer ${viewerJwt}`;

  // The Recovery cell reads the newest fleet snapshot's skip columns to learn
  // whether a node was captured at all, so this file starts from a snapshot that
  // captured everything and the cases that are not about coverage read Recovery
  // as healthy. The case that pins the no-snapshot answer removes it itself. The
  // baseline copy is per-file, so this does not reach other suites.
  clearSnapshots();
  seedCapturedSnapshot();
});

afterAll(() => {
  cleanupTestDb(tmpDir);
});

afterEach(() => {
  vi.restoreAllMocks();
  const db = DatabaseService.getInstance();
  for (const node of db.getNodes()) {
    if (node.type === 'remote') db.deleteNode(node.id);
  }
});

// --- fixtures ---------------------------------------------------------------

/** A direct-proxy target. Pilot targets are the other member of the union. */
function proxyTarget(apiUrl: string): ProxyTarget {
  return { apiUrl, apiToken: 'test-token', trustedLoopback: false };
}

function addProxyNode(name: string, apiUrl: string): number {
  const db = DatabaseService.getInstance();
  const id = db.addNode({
    name,
    type: 'remote',
    mode: 'proxy',
    compose_dir: '/tmp',
    is_default: false,
    api_url: apiUrl,
    api_token: 'test-token',
  });
  setContactSeconds(id, PRIOR_CONTACT);
  return id;
}

/**
 * Stamp a node's last successful contact, in the seconds that column holds.
 *
 * `nodes.last_successful_contact` is seconds while the sync stamps beside it in
 * `fleet_sync_status` are milliseconds, and one classifier reads both, so a raw
 * UPDATE at a call site is one unit mistake away from a stamp that reads as
 * contact from 1970. Defaults to the suite's prior-contact constant, which is
 * the value most cases here start from and then prove was left alone.
 */
function setContactSeconds(nodeId: number, seconds: number = PRIOR_CONTACT): void {
  DatabaseService.getInstance().getDb()
    .prepare('UPDATE nodes SET last_successful_contact = ? WHERE id = ?')
    .run(seconds, nodeId);
}

/**
 * A proxy node that is online and whose transport resolves, which is the
 * starting state most cases here describe and then break in one specific way.
 *
 * Cached status and a resolvable target are two separate fixtures a case has to
 * set before it can mean anything: a row can be online with no route, and the
 * negative cases need exactly those combinations. Writing all three lines at
 * each site is how one of them gets left out and a case silently stops testing
 * what its name says, so the combination every case starts from lives here.
 */
function addOnlineProxyNode(name: string): number {
  const id = addProxyNode(name, PROXY_BASE);
  setNodeStatus(id, 'online');
  mockTargets({ [id]: proxyTarget(PROXY_BASE) });
  return id;
}

function addPilotNode(name: string): number {
  const db = DatabaseService.getInstance();
  const id = db.addNode({
    name,
    type: 'remote',
    mode: 'pilot_agent',
    compose_dir: '/tmp',
    is_default: false,
    api_url: '',
    api_token: '',
  });
  db.updateNode(id, { pilot_last_seen: Date.now(), pilot_agent_version: '0.97.1' });
  return id;
}

function setNodeStatus(nodeId: number, status: string): void {
  DatabaseService.getInstance().getDb().prepare('UPDATE nodes SET status = ? WHERE id = ?').run(status, nodeId);
}

/** A sync row with a success and no failure: the in-sync Control state. */
function seedSyncSuccess(nodeId: number): void {
  // Milliseconds, unlike `nodes.last_successful_contact`, which holds seconds. A
  // seconds stamp in this column reads as a success from 1970, so the Control
  // cell would publish an evidence age of decades rather than of the fresh row
  // this means to create.
  DatabaseService.getInstance().getDb()
    .prepare('INSERT INTO fleet_sync_status (node_id, resource, last_success_at) VALUES (?, ?, ?)')
    .run(nodeId, 'nodes', Date.now());
}

function clearSnapshots(): void {
  DatabaseService.getInstance().getDb().prepare('DELETE FROM fleet_snapshots').run();
}

/**
 * A snapshot whose skip columns hold exactly these strings. The Recovery cell
 * reads them to learn whether a node was captured, so the interesting fixtures
 * are the three ways they can read: empty, naming this node, or unparseable.
 *
 * `createdAtMs` is for the case about the age the cell publishes rather than
 * about what it read: a snapshot stamped now is one whose age a reader cannot
 * tell apart from the fresh verdicts that arrived beside it.
 */
function seedSnapshot(skippedNodes: string, skippedStacks: string = '[]', createdAtMs: number = Date.now()): void {
  DatabaseService.getInstance().getDb()
    .prepare(
      `INSERT INTO fleet_snapshots
         (description, created_by, node_count, stack_count, skipped_nodes, skipped_stacks, created_at)
       VALUES ('', 'readiness-suite', 0, 0, ?, ?, ?)`,
    )
    .run(skippedNodes, skippedStacks, createdAtMs);
}

/**
 * A snapshot that skipped nothing, which is what a complete capture looks like
 * from the skip columns the Recovery cell reads. Any node id therefore counts
 * zero misses against it, including one added after the insert.
 */
function seedCapturedSnapshot(): void {
  seedSnapshot('[]');
}

/**
 * A sync row whose last failure is newer than its last success: the degraded
 * Control state.
 *
 * The stamps are written directly rather than through `recordFleetSyncSuccess`
 * and `recordFleetSyncFailure`, because those two calls can land in the same
 * millisecond and the classifier compares them with a strict `>`.
 */
function seedSyncFailureAfterSuccess(nodeId: number, error: string): void {
  const now = Date.now();
  DatabaseService.getInstance().getDb()
    .prepare(
      `INSERT INTO fleet_sync_status (node_id, resource, last_success_at, last_failure_at, last_error)
       VALUES (?, 'stacks', ?, ?, ?)`,
    )
    .run(nodeId, now - 60_000, now, error);
}

function contactSecondsOf(nodeId: number): number | null {
  const row = DatabaseService.getInstance().getDb()
    .prepare('SELECT last_successful_contact AS contact FROM nodes WHERE id = ?')
    .get(nodeId) as { contact: number | null } | undefined;
  return row?.contact ?? null;
}

/** One stack's tier-two row. Both verdict slots default to `ready`. */
function row(
  stack: string,
  over: { update?: ReadinessVerdict | null; rollback?: RollbackOverall | null; topReason?: string | null } = {},
): StackReadinessRow {
  const computedAt = Date.now();
  const topReason = over.topReason ?? null;
  const updateWord = over.update === undefined ? 'ready' : over.update;
  const rollbackWord = over.rollback === undefined ? 'ready' : over.rollback;
  return {
    stack,
    update: updateWord === null ? null : { verdict: updateWord, topReason, computedAt },
    rollback: rollbackWord === null ? null : { overall: rollbackWord, topReason, computedAt },
    unavailableReason: null,
  };
}

/** A healthy node-local evidence payload; pass `null` for a domain whose compute threw. */
function evidenceBody(over: { workloads?: unknown; security?: unknown } = {}): Record<string, unknown> {
  const generatedAt = Date.now();
  return {
    generatedAt,
    workloads: over.workloads === undefined
      ? { generatedAt, counts: { running: 2 }, degraded: false, stale: false, problems: [] }
      : over.workloads,
    security: over.security === undefined
      ? {
        generatedAt,
        posture: 'Secure',
        posturePartial: false,
        scannerAvailable: true,
        staleScans: 0,
        failedScans: 0,
        lastSuccessfulScanAt: generatedAt,
      }
      : over.security,
  };
}

function summaryBody(
  stacks: StackReadinessRow[],
  over: { truncated?: boolean; stale?: boolean } = {},
): Record<string, unknown> {
  return {
    generatedAt: Date.now(),
    truncated: over.truncated ?? false,
    stale: over.stale ?? false,
    stacks,
  };
}

// --- harness ----------------------------------------------------------------

function mockTargets(targets: Record<number, ProxyTarget | null>): void {
  vi.spyOn(NodeRegistry.getInstance(), 'getProxyTarget').mockImplementation((id: number) => {
    if (Object.prototype.hasOwnProperty.call(targets, id)) return targets[id];
    return null;
  });
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * A 200 whose body starts arriving and then dies, which is what a proxy that
 * drops the connection mid-response looks like to the reader.
 *
 * The failure is not decorative: a body that ends early rejects the read with a
 * transport error rather than with a syntax error, because the stream fails
 * before the parser sees an end of input. That difference is the whole point of
 * the case that uses this, so the error here is raised the way undici raises it.
 */
function truncatedBodyResponse(): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"generatedAt":1,"workloads":'));
      controller.error(new TypeError('terminated'));
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'application/json' } });
}

function hungUntilAbort(init?: RequestInit): Promise<Response> {
  return new Promise((_resolve, reject) => {
    const signal = init?.signal;
    if (!signal) {
      // Stay pending. Rejecting here would let a missing AbortSignal look like
      // a fast offline, which is the regression this mock exists to catch.
      return;
    }
    const abort = (): void => {
      reject(signal.reason instanceof Error
        ? signal.reason
        : new DOMException('The operation was aborted.', 'AbortError'));
    };
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener('abort', abort, { once: true });
  });
}

type FetchSpy = ReturnType<typeof vi.spyOn>;

function mockFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): FetchSpy {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    // A Request carries its own url; a string is one already, and a URL needs
    // only to be spelled out. The cases here assert against that string, so the
    // three spellings of the same address have to arrive as one.
    const url = input instanceof Request ? input.url : input.toString();
    return handler(url, init);
  });
}

/**
 * Capture the hub's own log lines for one test, one string per line.
 *
 * A case about a failure the aggregator survived has to read the line it
 * reported it with: the guards on those paths return a value whether or not
 * anything was logged, so a test that only looks at the response cannot tell a
 * logged recovery from a silent one, or from a guard that was deleted.
 */
function captureConsole(): { errors: string[]; warns: string[] } {
  const errors: string[] = [];
  const warns: string[] = [];
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    errors.push(String(args[0]));
  });
  vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
    warns.push(String(args[0]));
  });
  return { errors, warns };
}

/** Answer the two node-local reads from `body` and `summary`, 404 anything else. */
function nodeReadHandler(
  body: unknown,
  summary: unknown,
): (url: string) => Response {
  return (url) => {
    if (url.endsWith(EVIDENCE_PATH)) return jsonResponse(body);
    if (url.endsWith(SUMMARY_PATH)) return jsonResponse(summary);
    return new Response('not found', { status: 404 });
  };
}

async function getReadiness(
  query: Record<string, string>,
  token: string = authHeader,
): Promise<{ status: number; body: FleetReadinessResponse; elapsedMs: number }> {
  const started = Date.now();
  const res = await request(app).get('/api/fleet/readiness').query(query).set('Authorization', token);
  // supertest types the parsed body as `any`; this is the single point where the
  // aggregate payload enters the typed world.
  return { status: res.status, body: res.body as FleetReadinessResponse, elapsedMs: Date.now() - started };
}

// --- assertions -------------------------------------------------------------

function rowOf(body: FleetReadinessResponse, nodeId: number): FleetReadinessNode {
  const found = body.nodes.find((candidate) => candidate.id === nodeId);
  expect(found).toBeDefined();
  return found!;
}

function findingIds(findings: ReadinessFinding[]): string[] {
  return findings.map((finding) => finding.id);
}

/**
 * The severity vocabulary worst-first, written out rather than read from the
 * module under test. An expectation derived from `FINDING_SEVERITIES` moves
 * with that constant, so a reorder there would reorder the production sort and
 * this expectation together and leave every case below passing. The literal is
 * what lets these assertions fail, which is the whole point of them.
 */
const WORST_FIRST_SEVERITY: FindingSeverity[] = ['attention', 'degraded', 'unavailable', 'unknown'];

/** Findings are ordered by severity rank, then by id, so the list is stable. */
function expectWorstFirst(findings: ReadinessFinding[]): void {
  for (let index = 1; index < findings.length; index += 1) {
    const previous = findings[index - 1];
    const current = findings[index];
    const rankDelta = WORST_FIRST_SEVERITY.indexOf(previous.severity) - WORST_FIRST_SEVERITY.indexOf(current.severity);
    const ordered = rankDelta < 0 || (rankDelta === 0 && previous.id.localeCompare(current.id) <= 0);
    expect(ordered, `${previous.id} should not sort before ${current.id}`).toBe(true);
  }
}

/**
 * Every row publishes exactly the domains the response says it carries. A
 * caller that filters the request must not receive a cell for a domain it
 * filtered out, and a caller that cannot see a domain must not receive one
 * either, so this checks key presence rather than a per-domain spot check.
 */
function expectCellsMatchDomains(body: FleetReadinessResponse): void {
  const expected = [...body.domains].sort();
  for (const node of body.nodes) {
    expect(Object.keys(node.cells).sort()).toEqual(expected);
  }
}

function sumFindingSeverities(body: FleetReadinessResponse): number {
  return Object.values(body.summary.findings).reduce((total, count) => total + count, 0);
}

function sumNodeStates(body: FleetReadinessResponse): number {
  return Object.values(body.summary.nodes).reduce((total, count) => total + count, 0);
}

// --- aggregation ------------------------------------------------------------

describe('GET /api/fleet/readiness aggregation', () => {
  it('reports a healthy proxy node from exactly its evidence and summary reads', async () => {
    const nodeId = addOnlineProxyNode('healthy-proxy');
    // Control is classified from the hub's own sync rows, so a node with none is
    // unknown rather than healthy; a fleet that is healthy end to end has the row.
    seedSyncSuccess(nodeId);
    const urls: string[] = [];
    mockFetch((url) => {
      urls.push(url);
      return nodeReadHandler(evidenceBody(), summaryBody([row('web')]))(url);
    });

    const { status, body } = await getReadiness({ domains: ALL_DOMAINS, nodeIds: String(nodeId) });
    expect(status).toBe(200);

    // The node-local surface is two reads, not a per-stack waterfall.
    expect(urls.sort()).toEqual([
      `${PROXY_BASE}${SUMMARY_PATH}`,
      `${PROXY_BASE}${EVIDENCE_PATH}`,
    ].sort());

    const node = rowOf(body, nodeId);
    expect(node.transport).toBe('proxy');
    expect(node.reachability.probedLive).toBe(true);
    expect(node.reachability.latencyMs).toBeGreaterThanOrEqual(0);
    for (const domain of READINESS_DOMAINS) {
      expect(node.cells[domain], domain).toMatchObject({ state: 'healthy', reasonCode: null });
    }
    expect(node.cells.updates!.source).toBe('live');
    expect(node.cells.updates!.evidenceAgeMs).toBeGreaterThanOrEqual(0);
    // Control's age comes from the sync row's millisecond stamp. A seconds stamp
    // in that column would make this an age of decades.
    expect(node.cells.control!.evidenceAgeMs).toBeGreaterThanOrEqual(0);
    expect(node.cells.control!.evidenceAgeMs).toBeLessThan(60_000);
    // Workload counts are the node's own stack tally; the summary read does not
    // feed it.
    expect(node.stackCount).toBe(2);
    expect(body.findings).toEqual([]);
    expect(body.domains).toEqual([...READINESS_DOMAINS]);
    expect(body.domainsOmitted).toEqual([]);
    expect(body.summary.nodes).toMatchObject({ attention: 0, degraded: 0, unavailable: 0, unknown: 0, healthy: 1 });
    expect(sumNodeStates(body)).toBe(body.nodes.length);
    expectCellsMatchDomains(body);
  });

  it('bounds a hung remote and keeps its siblings intact', async () => {
    const good = addProxyNode('good-proxy', PROXY_BASE);
    const hung = addProxyNode('hung-proxy', 'http://hung.example.com');
    const unknownStatus = addProxyNode('unknown-status', 'http://unknown.example.com');
    setNodeStatus(good, 'online');
    // A cached row that claims health, and a heartbeat that looks current: the
    // probe's own failure is the newer fact, and it must win.
    setNodeStatus(hung, 'online');
    setContactSeconds(hung, Math.floor(Date.now() / 1000));
    const hungContactBefore = contactSecondsOf(hung);
    mockTargets({
      [good]: proxyTarget(PROXY_BASE),
      [hung]: proxyTarget('http://hung.example.com'),
      [unknownStatus]: proxyTarget('http://unknown.example.com'),
    });
    mockFetch((url, init) => (url.startsWith(PROXY_BASE)
      ? nodeReadHandler(evidenceBody(), summaryBody([row('web')]))(url)
      : hungUntilAbort(init)));

    const startedAt = Date.now();
    const { status, body, elapsedMs } = await getReadiness({
      domains: ALL_DOMAINS,
      nodeIds: `${good},${hung},${unknownStatus}`,
    });
    expect(status).toBe(200);
    expect(elapsedMs).toBeGreaterThanOrEqual(HUNG_ROW_FLOOR_MS);
    expect(elapsedMs).toBeLessThanOrEqual(HUNG_ROW_CEILING_MS);

    // The responsive node is untouched by its hung siblings.
    const goodRow = rowOf(body, good);
    expect(goodRow.transport).toBe('proxy');
    expect(goodRow.cells.connectivity).toMatchObject({ state: 'healthy', reasonCode: null });
    expect(goodRow.cells.updates).toMatchObject({ state: 'healthy', reasonCode: null });
    // The stamp is written while this request's own reads are in flight, and the
    // hung sibling keeps the response in flight well past that instant, so the
    // window is anchored to the request rather than to the assertion.
    const goodContact = contactSecondsOf(good)!;
    expect(goodContact).toBeGreaterThanOrEqual(Math.floor(startedAt / 1000) - 1);
    expect(goodContact).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + 1);

    // A live probe that failed outranks a cached success, and the staleness of
    // the cached view is still reported alongside it.
    const hungRow = rowOf(body, hung);
    expect(hungRow.reachability.probedLive).toBe(false);
    expect(hungRow.reachability.note).toBe('Proxy contact fresh (cached)');
    expect(hungRow.cells.connectivity).toMatchObject({ state: 'attention', reasonCode: 'probe_timeout', source: 'live' });
    for (const domain of NODE_LOCAL_DOMAINS) {
      expect(hungRow.cells[domain], domain).toMatchObject({ state: 'unavailable', reasonCode: 'probe_timeout' });
    }
    expect(hungRow.stackCount).toBeNull();
    // A read that produced no answer leaves the contact record alone rather than
    // writing the attempt back as a success.
    expect(contactSecondsOf(hung)).toBe(hungContactBefore);

    // A cached offline status decides on its own, with no probe to outrank it.
    const cachedRow = rowOf(body, unknownStatus);
    expect(cachedRow.reachability.probedLive).toBe(false);
    expect(cachedRow.reachability.note).toBe('Remote node cached as offline or unknown');
    expect(cachedRow.cells.connectivity).toMatchObject({ state: 'attention', reasonCode: 'node_unreachable', source: 'stored' });
    expect(contactSecondsOf(unknownStatus)).toBe(PRIOR_CONTACT);

    const ids = findingIds(body.findings);
    expect(ids).toContain(`connectivity:${hung}:probe_timeout`);
    expect(ids).toContain(`connectivity:${unknownStatus}:node_unreachable`);
    // Every finding is counted once, by severity, and the two lists agree.
    expect(sumFindingSeverities(body)).toBe(body.findings.length);
    expect(sumNodeStates(body)).toBe(body.nodes.length);
    expectWorstFirst(body.findings);
    expectCellsMatchDomains(body);
  }, 20_000);

  it('tells a refused transport apart from a read that ran out of budget', async () => {
    // Both of these nodes end the request with no answer, and the operator's next
    // move differs: one of them never heard the question, the other is still
    // being waited on. The row says which, and neither is reported as a broken
    // domain when the truth is that the domain was never read.
    const refused = addProxyNode('refused-proxy', PROXY_BASE);
    const hung = addProxyNode('budget-proxy', 'http://hung.example.com');
    for (const nodeId of [refused, hung]) {
      setNodeStatus(nodeId, 'online');
      // A current contact, so the hub's stored view is not what answers for the
      // failed probe: this request's own failure is the newer fact.
      setContactSeconds(nodeId, Math.floor(Date.now() / 1000));
    }
    const refusedContactBefore = contactSecondsOf(refused);
    mockTargets({ [refused]: proxyTarget(PROXY_BASE), [hung]: proxyTarget('http://hung.example.com') });
    mockFetch((url, init) => (url.startsWith(PROXY_BASE)
      ? Promise.reject(new Error('connect ECONNREFUSED'))
      : hungUntilAbort(init)));

    const { status, body } = await getReadiness({ domains: ALL_DOMAINS, nodeIds: `${refused},${hung}` });
    expect(status).toBe(200);

    const outcomes = [[refused, 'node_unreachable'], [hung, 'probe_timeout']] as const;
    for (const [nodeId, code] of outcomes) {
      const node = rowOf(body, nodeId);
      expect(node.transport).toBe('proxy');
      expect(node.reachability.probedLive).toBe(false);
      expect(node.cells.connectivity).toMatchObject({ state: 'attention', reasonCode: code, source: 'live' });
      // Every column behind the unread payload is unread rather than broken, and
      // it carries Connectivity's code, so the row reads as one condition instead
      // of five columns that each broke in their own way.
      for (const domain of NODE_LOCAL_DOMAINS) {
        expect(node.cells[domain], `${code} ${domain}`).toMatchObject({ state: 'unavailable', reasonCode: code });
      }
      expect(node.stackCount).toBeNull();
      expect(findingIds(body.findings)).toContain(`connectivity:${nodeId}:${code}`);
    }
    // The distinction this case exists for: a transport that produced nothing at
    // all is not a node that answered badly, and only the second is a domain
    // error. Reporting the first that way sends someone to read logs on a node
    // that never received the request.
    expect(body.findings.some((finding) => finding.code === 'domain_error')).toBe(false);
    // A refused transport is not contact either: the attempt is not written back
    // as a success for the next reader to find.
    expect(contactSecondsOf(refused)).toBe(refusedContactBefore);
    expectWorstFirst(body.findings);
    expectCellsMatchDomains(body);
  }, 20_000);

  it('reports a 200 whose body is not JSON as an answered node, not as a lost transport', async () => {
    // A reverse proxy or an identity page in front of a node answers 200 with
    // HTML. The bytes arrived and something on the far side answered, so filing
    // this as `node_unreachable` sends the operator to tunnels and firewall
    // rules for a node that is up and talking. It is a read this hub could not
    // use, which is what `domain_error` says.
    const nodeId = addOnlineProxyNode('interstitial-proxy');
    // A current contact, so the hub's stored view is not what answers for the
    // failed read: this request's own failure is the newer fact, and Connectivity
    // has to name it rather than fall back to a stale-contact story.
    setContactSeconds(nodeId, Math.floor(Date.now() / 1000));
    const contactBefore = contactSecondsOf(nodeId);
    mockFetch((url) => (url.endsWith(EVIDENCE_PATH)
      ? new Response('<html><body>Sign in to continue</body></html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      })
      : jsonResponse(summaryBody([row('web')]))));

    const { status, body } = await getReadiness({ domains: 'connectivity,workloads', nodeIds: String(nodeId) });
    expect(status).toBe(200);

    const node = rowOf(body, nodeId);
    expect(node.transport).toBe('proxy');
    expect(node.reachability.probedLive).toBe(false);
    expect(node.cells.connectivity).toMatchObject({ state: 'attention', reasonCode: 'domain_error', source: 'live' });
    expect(node.cells.workloads).toMatchObject({ state: 'unavailable', reasonCode: 'domain_error' });
    expect(node.stackCount).toBeNull();
    expect(findingIds(body.findings)).toContain(`connectivity:${nodeId}:domain_error`);
    expect(body.findings.some((finding) => finding.code === 'node_unreachable')).toBe(false);
    // The stamp tracks contact with Sencho rather than with whatever answered
    // the socket, so an interstitial is not written back as a successful read
    // for the next caller to find.
    expect(contactSecondsOf(nodeId)).toBe(contactBefore);
    expectCellsMatchDomains(body);
  }, 20_000);

  it('reads a body that dies mid-stream as an answered node, not as a lost transport', async () => {
    // The other half of the case above, and the one an error's class would get
    // wrong: a body that stops mid-flight rejects as a transport error rather
    // than as a parse failure, so a read that dispatched on the class would hand
    // it to the transport's column. The node completed a handshake and sent a
    // status line before the bytes stopped, which is an answered read, and the
    // operator's next move is on the node rather than on the tunnel.
    const nodeId = addOnlineProxyNode('truncated-proxy');
    // A current contact, so Connectivity has this request's own failure to report
    // rather than a stale-contact story answering for it.
    setContactSeconds(nodeId, Math.floor(Date.now() / 1000));
    const contactBefore = contactSecondsOf(nodeId);
    const logs = captureConsole();
    mockFetch((url) => (url.endsWith(EVIDENCE_PATH)
      ? truncatedBodyResponse()
      : jsonResponse(summaryBody([row('web')]))));

    const { status, body } = await getReadiness({ domains: 'connectivity,workloads', nodeIds: String(nodeId) });
    expect(status).toBe(200);

    const node = rowOf(body, nodeId);
    expect(node.transport).toBe('proxy');
    expect(node.reachability.probedLive).toBe(false);
    expect(node.cells.connectivity).toMatchObject({ state: 'attention', reasonCode: 'domain_error', source: 'live' });
    expect(node.cells.workloads).toMatchObject({ state: 'unavailable', reasonCode: 'domain_error' });
    expect(node.stackCount).toBeNull();
    expect(body.findings.some((finding) => finding.code === 'node_unreachable')).toBe(false);
    // The line is where the operator learns the body was unreadable rather than
    // the node gone, so the read is asserted to have reported it.
    expect(logs.warns.some((line) => line.includes('with a body this hub cannot read'))).toBe(true);
    expect(contactSecondsOf(nodeId)).toBe(contactBefore);
    expectCellsMatchDomains(body);
  }, 20_000);

  it('never issues a fetch for a Pilot with no transport', async () => {
    const nodeId = addPilotNode('disconnected-pilot');
    setNodeStatus(nodeId, 'offline');
    mockTargets({ [nodeId]: null });
    const fetchSpy = mockFetch(() => {
      throw new Error('no read may reach a disconnected Pilot');
    });

    const { status, body, elapsedMs } = await getReadiness({ domains: ALL_DOMAINS, nodeIds: String(nodeId) });
    expect(status).toBe(200);
    // The tunnel is down before any HTTP is attempted, so this path must not
    // wait on a transport that cannot answer.
    expect(elapsedMs).toBeLessThan(FAST_PATH_CEILING_MS);
    expect(fetchSpy).not.toHaveBeenCalled();

    const node = rowOf(body, nodeId);
    expect(node.transport).toBe('unreachable');
    expect(node.reachability.probedLive).toBe(false);
    expect(node.reachability.note).toBe('Pilot heartbeat fresh but cached status is offline');
    expect(node.cells.connectivity).toMatchObject({ state: 'attention', reasonCode: 'pilot_disconnected', source: 'stored' });
    for (const domain of NODE_LOCAL_DOMAINS) {
      expect(node.cells[domain], domain).toMatchObject({ state: 'unavailable', reasonCode: 'pilot_disconnected' });
    }
    expect(node.stackCount).toBeNull();
    expect(body.summary.findings).toMatchObject({ attention: 1, unavailable: 4 });
    expectWorstFirst(body.findings);
    expectCellsMatchDomains(body);
  });

  it('reports a proxy node with no route as unreachable without reading anything', async () => {
    // The same fast path the Pilot case covers, reached by the other transport:
    // this node is not a Pilot and its proxy target does not resolve, so the four
    // domains that need a read are unread for a reason about the route (the node
    // is not answering) rather than about its own build (which would be a 404).
    const nodeId = addProxyNode('route-less', PROXY_BASE);
    setNodeStatus(nodeId, 'online');
    mockTargets({ [nodeId]: null });
    const fetchSpy = mockFetch(() => {
      throw new Error('a node with no route must not be read');
    });

    const { body, elapsedMs } = await getReadiness({ domains: ALL_DOMAINS, nodeIds: String(nodeId) });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(elapsedMs).toBeLessThan(FAST_PATH_CEILING_MS);

    const node = rowOf(body, nodeId);
    expect(node.transport).toBe('unreachable');
    expect(node.cells.connectivity).toMatchObject({ state: 'attention', reasonCode: 'node_unreachable' });
    for (const domain of NODE_LOCAL_DOMAINS) {
      expect(node.cells[domain], domain).toMatchObject({ state: 'unavailable', reasonCode: 'node_unreachable' });
    }
    expect(node.stackCount).toBeNull();
    // Nothing was read, so nothing may have written a contact stamp either.
    expect(contactSecondsOf(nodeId)).toBe(PRIOR_CONTACT);
    expectCellsMatchDomains(body);
  });

  it('keeps the domains that answered when one domain throws on the node', async () => {
    const nodeId = addOnlineProxyNode('partial-proxy');
    // The workload compute threw on this node; the security pass answered, and
    // both ride in the same evidence read.
    mockFetch(nodeReadHandler(
      evidenceBody({ workloads: null }),
      summaryBody([row('web', { update: 'blocked', topReason: 'a required image is not resolvable' })]),
    ));

    const { body } = await getReadiness({ domains: ALL_DOMAINS, nodeIds: String(nodeId) });
    const node = rowOf(body, nodeId);
    expect(node.cells.workloads).toMatchObject({ state: 'unavailable', reasonCode: 'domain_error' });
    expect(node.cells.security).toMatchObject({ state: 'healthy', reasonCode: null });
    expect(node.cells.updates).toMatchObject({ state: 'attention', reasonCode: 'update_blocked' });
    expect(node.cells.connectivity).toMatchObject({ state: 'healthy', reasonCode: null });
    expect(node.stackCount).toBeNull();

    const ids = findingIds(body.findings);
    expect(ids).toContain(`workloads:${nodeId}:domain_error`);
    expect(ids).toContain(`updates:${nodeId}:web:update_blocked`);
    const blocked = body.findings.find((finding) => finding.id === `updates:${nodeId}:web:update_blocked`)!;
    expect(blocked).toMatchObject({
      domain: 'updates',
      stack: 'web',
      severity: 'attention',
      target: { surface: 'stack', nodeId, stackName: 'web' },
      verdict: { kind: 'update', value: 'blocked' },
    });
    expect(blocked.detail).toBe('a required image is not resolvable');
    expectWorstFirst(body.findings);
  });

  it('keeps the workload evidence when the node could not compute its security facts', async () => {
    // The mirror of the case above, and the one that says the two halves of one
    // payload are read independently: the security assembly threw on the node,
    // which arrives here as a null in a payload this hub read without complaint.
    const nodeId = addOnlineProxyNode('security-threw');
    mockFetch(nodeReadHandler(evidenceBody({ security: null }), summaryBody([])));

    const { body } = await getReadiness({ domains: 'workloads,security', nodeIds: String(nodeId) });
    const node = rowOf(body, nodeId);
    expect(node.cells.security).toMatchObject({ state: 'unavailable', reasonCode: 'domain_error' });
    expect(node.cells.workloads).toMatchObject({ state: 'healthy', reasonCode: null });
    // The total is built from the workloads half alone, so a sibling's failure is
    // no reason to withhold it.
    expect(node.stackCount).toBe(2);
  });

  it('answers with an unreadable row when a node own build throws, instead of failing the request', async () => {
    // The reads inside a node's row are built to degrade rather than throw, so
    // they return a kind instead of raising. The hub-side statements beside them
    // are not, and the newest-snapshot lookup is one of those, so it is stubbed
    // to throw. The catch around the build is what turns that into one node's
    // unreadable row rather than a 500 for the whole page. Every node loses its
    // row when the hub's own database is what failed, so the case asserts the
    // answer rather than a surviving sibling.
    const nodeId = addOnlineProxyNode('throwing-row');
    mockFetch(nodeReadHandler(evidenceBody(), summaryBody([])));
    vi.spyOn(DatabaseService.getInstance(), 'getSnapshots').mockImplementation(() => {
      throw new Error('database is locked');
    });

    const { status, body } = await getReadiness({ domains: ALL_DOMAINS, nodeIds: String(nodeId) });
    expect(status).toBe(200);

    const row = rowOf(body, nodeId);
    for (const domain of READINESS_DOMAINS) {
      // Control is merged after the fan-out out of the hub's own rows, so it is
      // not one of the cells this catch produced.
      if (domain === 'control') continue;
      expect(row.cells[domain], domain).toMatchObject({ state: 'unavailable', reasonCode: 'domain_error' });
    }
    expect(row.transport).toBe('proxy');
    expect(row.stackCount).toBeNull();
    // Reachability comes from the canonical classifier rather than from a second
    // copy written for this row, so the contact it reports is the one the rest of
    // the hub reads, note included.
    expect(row.reachability.contactAt).toBe(PRIOR_CONTACT * 1000);
    expect(row.reachability.note).toBe('Proxy contact missing or stale (cached status)');
    expect(findingIds(body.findings)).toContain(`connectivity:${nodeId}:domain_error`);
    expectCellsMatchDomains(body);
  });

  it('reports an unreadable row when the transport resolve itself throws', async () => {
    // The recovery path is only entered because something already threw, so
    // everything it calls has to hold that property. Resolving the transport is
    // a database read like the one above, and a second throw here would leave
    // the worker and take the fleet's request with it, which is the property the
    // per-node catch exists to hold. The node's own resolve throws first, so the
    // row is built by the recovery, and the recovery's resolve throws too.
    const nodeId = addProxyNode('throwing-target', PROXY_BASE);
    setNodeStatus(nodeId, 'online');
    const logs = captureConsole();
    vi.spyOn(NodeRegistry.getInstance(), 'getProxyTarget').mockImplementation(() => {
      throw new Error('database is locked');
    });

    const { status, body } = await getReadiness({ domains: ALL_DOMAINS, nodeIds: String(nodeId) });
    expect(status).toBe(200);

    const row = rowOf(body, nodeId);
    for (const domain of READINESS_DOMAINS) {
      if (domain === 'control') continue;
      expect(row.cells[domain], domain).toMatchObject({ state: 'unavailable', reasonCode: 'domain_error' });
    }
    // No route could be resolved, so the transport says so rather than naming
    // one the guard was unable to verify.
    expect(row.transport).toBe('unreachable');
    expect(row.stackCount).toBeNull();
    expect(logs.errors.some((line) => line.includes('could not resolve the transport'))).toBe(true);
    expectCellsMatchDomains(body);
  }, 20_000);

  it('reports an undecided or stale update pass as unknown, never healthy', async () => {
    const nodeId = addOnlineProxyNode('undecided-proxy');
    mockFetch(nodeReadHandler(
      evidenceBody(),
      summaryBody([row('web', { update: 'unknown', topReason: 'no confirmed update check has run' })], {
        stale: true,
        truncated: true,
      }),
    ));

    const { body } = await getReadiness({ domains: 'updates,recovery', nodeIds: String(nodeId) });
    const node = rowOf(body, nodeId);
    expect(node.cells.updates!.state).toBe('unknown');
    expect(node.cells.recovery!.state).toBe('unknown');

    const ids = findingIds(body.findings);
    expect(ids).toContain(`updates:${nodeId}:web:stacks_unknown`);
    expect(ids).toContain(`updates:${nodeId}:summary_truncated`);
    expect(ids).toContain(`recovery:${nodeId}:summary_truncated`);
    // `unknown` is one of this build's own verdict words, so the finding keeps
    // the tag that tells the frontend how to present it. Only a word the hub
    // cannot classify at all leaves the verdict null.
    const undecided = body.findings.find((finding) => finding.id === `updates:${nodeId}:web:stacks_unknown`)!;
    expect(undecided).toMatchObject({
      severity: 'unknown',
      verdict: { kind: 'update', value: 'unknown' },
      stack: 'web',
    });
    expect(undecided.detail).toBe('no confirmed update check has run');
    // The node reports truncation as a flag with no tally of what it skipped, so
    // the finding is the whole of what the hub can truthfully publish about it:
    // fleet-scoped, with no stack to attribute it to.
    const truncated = body.findings.find((finding) => finding.id === `updates:${nodeId}:summary_truncated`)!;
    expect(truncated).toMatchObject({ severity: 'unknown', stack: null, verdict: null });
    expect(body.summary.findings).toMatchObject({ attention: 0, degraded: 0, unavailable: 0 });
    expectWorstFirst(body.findings);
  });

  it('reports a verdict set that is ready but no longer current as unknown', async () => {
    const nodeId = addOnlineProxyNode('stale-summary');
    // Every row this pass carries is ready, and the pass itself is older than the
    // window it was taken under. A verdict set is evidence about the moment it
    // was computed, so a cell built on it is answering about the past, which is
    // not the same answer as "these stacks are ready now".
    mockFetch(nodeReadHandler(evidenceBody(), summaryBody([row('web'), row('api')], { stale: true })));

    const { body } = await getReadiness({ domains: 'updates', nodeIds: String(nodeId) });
    const cell = rowOf(body, nodeId).cells.updates!;
    expect(cell).toMatchObject({ state: 'unknown', reasonCode: 'summary_stale', source: 'live' });
    // Both ready rows contribute nothing of their own, so what is left is the
    // node's own finding, attributed to no stack: staleness is a fact about the
    // pass rather than about either stack in it.
    expect(findingIds(body.findings)).toEqual([`updates:${nodeId}:summary_stale`]);
    expect(body.findings[0]).toMatchObject({
      severity: 'unknown',
      stack: null,
      verdict: null,
      target: { surface: 'auto-updates' },
    });
  });

  it('reports a verdict word from a wider vocabulary as unknown, not as healthy', async () => {
    const nodeId = addOnlineProxyNode('future-proxy');
    // A peer running ahead of this hub answers in a vocabulary this build did
    // not compile against. The row is well formed and the word means nothing
    // here, which is the case that must not read as a ready stack.
    mockFetch(nodeReadHandler(evidenceBody(), {
      ...summaryBody([]),
      stacks: [{
        stack: 'web',
        update: { verdict: 'invented_by_a_newer_peer', topReason: null, computedAt: Date.now() },
        rollback: null,
        unavailableReason: null,
      }],
    }));

    const { body } = await getReadiness({ domains: 'updates', nodeIds: String(nodeId) });
    const cell = rowOf(body, nodeId).cells.updates!;
    expect(cell).toMatchObject({ state: 'unknown', reasonCode: 'stacks_unknown' });
    const skewed = body.findings.find((finding) => finding.id === `updates:${nodeId}:web:stacks_unknown`)!;
    // The tagged union cannot carry a word it does not know, so the finding
    // names the condition without claiming a verdict.
    expect(skewed).toMatchObject({ severity: 'unknown', verdict: null, stack: 'web' });
  });

  it('reads a rollback word from that same wider vocabulary as unknown too', async () => {
    const nodeId = addOnlineProxyNode('future-rollback');
    // The update side of this row is absent and the rollback side carries the
    // unknown word, so the guard on each verdict is what puts this row in the
    // unknown column rather than the healthy one.
    mockFetch(nodeReadHandler(evidenceBody(), {
      ...summaryBody([]),
      stacks: [{
        stack: 'web',
        update: null,
        rollback: { overall: 'mostly_fine', topReason: null, computedAt: Date.now() },
        unavailableReason: null,
      }],
    }));

    const { body } = await getReadiness({ domains: 'recovery', nodeIds: String(nodeId) });
    expect(rowOf(body, nodeId).cells.recovery).toMatchObject({ state: 'unknown', reasonCode: 'stacks_unknown' });
    expect(findingIds(body.findings)).toEqual([`recovery:${nodeId}:web:stacks_unknown`]);
    // No verdict tag, because a word this build cannot name is not a verdict it
    // can hand the frontend to render.
    expect(body.findings[0]).toMatchObject({ severity: 'unknown', stack: 'web', verdict: null });
  });

  it('surfaces a rollback that is not ready, or only partly ready', async () => {
    const nodeId = addOnlineProxyNode('rollback-proxy');
    mockFetch(nodeReadHandler(evidenceBody(), summaryBody([
      row('alpha', { rollback: 'not_ready', topReason: 'no snapshot of alpha is available' }),
      row('beta', { rollback: 'partial' }),
      row('gamma'),
    ])));

    const { body } = await getReadiness({ domains: 'updates,recovery', nodeIds: String(nodeId) });
    const node = rowOf(body, nodeId);
    // Two stacks need attention and one is ready, so the column takes the worst.
    expect(node.cells.recovery).toMatchObject({ state: 'attention', reasonCode: 'rollback_not_ready', source: 'live' });
    expect(node.cells.updates).toMatchObject({ state: 'healthy', reasonCode: null });
    expect(node.cells.recovery!.evidenceAgeMs).toBeGreaterThanOrEqual(0);

    const recovery = body.findings.filter((finding) => finding.domain === 'recovery');
    expect(findingIds(recovery)).toEqual([
      `recovery:${nodeId}:alpha:rollback_not_ready`,
      `recovery:${nodeId}:beta:rollback_partial`,
    ]);
    expect(recovery[0]).toMatchObject({
      severity: 'attention',
      stack: 'alpha',
      detail: 'no snapshot of alpha is available',
      target: { surface: 'stack', nodeId, stackName: 'alpha' },
      verdict: { kind: 'rollback', value: 'not_ready' },
    });
    expect(recovery[1]).toMatchObject({ severity: 'degraded', verdict: { kind: 'rollback', value: 'partial' } });
    // A ready stack contributes no finding.
    expect(findingIds(body.findings)).not.toContain(`recovery:${nodeId}:gamma:rollback_partial`);
    expect(body.summary.findings).toMatchObject({ attention: 1, degraded: 1, unavailable: 0, unknown: 0 });
    expectWorstFirst(body.findings);
  });

  it('classifies control rows for an admin and redacts the failure text', async () => {
    const paused = addProxyNode('paused-proxy', PROXY_BASE);
    const quiet = addProxyNode('quiet-proxy', HEALTHY_BASE);
    const db = DatabaseService.getInstance();
    db.recordFleetSyncFailure(paused, 'stacks', 'Authorization: Bearer supersecret');
    db.setFleetSyncSticky(paused, 'stacks', SYNC_ERROR_CODES.controlIdentityMismatch, 'expected-control', 'other-control');
    // No transport on either node, so this case exercises the stored Control
    // rows without any read in flight.
    mockTargets({ [paused]: null, [quiet]: null });

    const { body } = await getReadiness({ domains: 'connectivity,control', nodeIds: `${paused},${quiet}` });
    expect(body.domains).toEqual(['connectivity', 'control']);
    expect(body.domainsOmitted).toEqual([]);

    // A sticky identity mismatch is the operator-facing paused state, and it is
    // not retriable by waiting.
    const pausedCell = rowOf(body, paused).cells.control!;
    expect(pausedCell).toMatchObject({
      state: 'attention',
      reasonCode: 'control_paused',
      source: 'stored',
      counts: { resources: 1 },
    });
    const pausedFinding = body.findings.find((finding) => finding.id === `control:${paused}:control_paused`)!;
    expect(pausedFinding.target).toEqual({ surface: 'settings-nodes' });
    expect(pausedFinding.detail).not.toBeNull();
    // Redaction is a producer obligation, so the payload is checked, not the log.
    expect(JSON.stringify(body)).not.toContain('supersecret');

    // No rows is unknown, and unknown is not healthy.
    const quietCell = rowOf(body, quiet).cells.control!;
    expect(quietCell).toMatchObject({ state: 'unknown', reasonCode: 'control_unknown', counts: { resources: 0 } });
    expectCellsMatchDomains(body);
  });

  it('omits the control domain from a caller without the admin check', async () => {
    const nodeId = addProxyNode('paused-proxy', PROXY_BASE);
    DatabaseService.getInstance().setFleetSyncSticky(nodeId, 'stacks', SYNC_ERROR_CODES.controlIdentityMismatch, null, null);
    mockTargets({ [nodeId]: null });

    const { status, body } = await getReadiness({ nodeIds: String(nodeId) }, viewerAuthHeader);
    expect(status, JSON.stringify(body)).toBe(200);
    expect(body.domains).not.toContain('control');
    expect(body.domainsOmitted).toEqual(['control']);
    for (const node of body.nodes) {
      expect(Object.keys(node.cells)).not.toContain('control');
    }
    expect(body.findings.some((finding) => finding.domain === 'control')).toBe(false);
    // The remaining domains are the same shape they would have for an admin.
    expect(body.domains).toEqual(['connectivity', 'workloads', 'updates', 'recovery', 'security']);
    expectCellsMatchDomains(body);
    expect(sumNodeStates(body)).toBe(body.nodes.length);
  });

  it('answers a caller who asks only for a domain they may not see with no cells at all', async () => {
    // The visibility filter runs after the request filter, so this request passes
    // validation and then has nothing left to carry. A row with no cells is the
    // absence of evidence, which is the one thing this surface may not read as
    // good news: the node is unknown rather than healthy, and there is no cell a
    // reader could mistake for an answer. The sync row is seeded so the omission
    // is provably about who is asking and not about the data being absent.
    const nodeId = addOnlineProxyNode('filtered-control');
    seedSyncSuccess(nodeId);
    mockFetch(nodeReadHandler(evidenceBody(), summaryBody([row('web')])));

    const { status, body } = await getReadiness({ domains: 'control', nodeIds: String(nodeId) }, viewerAuthHeader);
    expect(status).toBe(200);
    expect(body.domains).toEqual([]);
    expect(body.domainsOmitted).toEqual(['control']);
    expect(rowOf(body, nodeId).cells).toEqual({});
    expect(body.summary.nodes).toMatchObject({ attention: 0, degraded: 0, unavailable: 0, unknown: 1, healthy: 0 });
    expect(body.findings).toEqual([]);
    expectCellsMatchDomains(body);
  });

  it('reads the hub own node in process rather than over HTTP', async () => {
    // What this pins is the path rather than the budget: a local node is read by
    // calling the assembly directly, so none of it goes over the wire. That read
    // is bounded by `withTimeout` on the local path rather than by the abort
    // signal, which the ceiling below cannot demonstrate on a read that
    // completes; the HTTP half of the budget is what the hung-remote case
    // exercises.
    const fetchSpy = mockFetch(() => {
      throw new Error('the local node is read in process, not over HTTP');
    });

    const { status, body, elapsedMs } = await getReadiness({ domains: 'connectivity' });
    expect(status).toBe(200);
    expect(elapsedMs).toBeLessThan(LOCAL_READ_CEILING_MS);
    expect(fetchSpy).not.toHaveBeenCalled();

    const local = body.nodes.find((node) => node.type === 'local')!;
    expect(local.transport).toBe('local');
    expect(local.reachability.note).toBe('Local node');
    expect(local.reachability.contactAt).toBeNull();
    expect(local.cells.connectivity).toMatchObject({ state: 'healthy', reasonCode: null });
    expect(body.domains).toEqual(['connectivity']);
    expect(body.domainsOmitted).toEqual([]);
    expectCellsMatchDomains(body);
  });

  it('reads this node own evidence in process for the domains that need it', async () => {
    // The one-node install is the common one, and its Workloads and Security
    // columns come from the same assembly a remote serves behind the evidence
    // route. This pins that the local row carries that evidence rather than a
    // transport failure, and that none of it went over the wire to get here.
    const fetchSpy = mockFetch(() => {
      throw new Error('the local node is read in process, not over HTTP');
    });

    const { status, body, elapsedMs } = await getReadiness({ domains: 'connectivity,workloads,security' });
    expect(status).toBe(200);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(elapsedMs).toBeLessThan(LOCAL_READ_CEILING_MS);

    const local = body.nodes.find((node) => node.type === 'local')!;
    expect(local.cells.connectivity).toMatchObject({ state: 'healthy', reasonCode: null });
    // A node with no completed scans has no healthy security column. The code is
    // left open on purpose: a machine with `trivy` on PATH reports
    // `scans_never_completed` where one without it reports `scanner_unavailable`,
    // and both are the unknown state this pins. This is the half of the local
    // assembly a case can assert without depending on what is in this host's
    // compose directory, or on what is on its PATH.
    expect(local.cells.security).toMatchObject({
      state: 'unknown',
      reasonCode: expect.stringMatching(/^(scanner_unavailable|scans_never_completed)$/),
    });
    // Workloads is asserted as a published cell rather than by state, for the
    // same reason: whether the strict listing under this host's compose directory
    // agrees with the status read is a property of the machine the suite runs on.
    expect(local.cells.workloads).toBeDefined();
    expectCellsMatchDomains(body);
  });
});

describe('GET /api/fleet/readiness per-domain evidence', () => {
  it('degrades both domains a malformed evidence payload carries, and counts it as no answer', async () => {
    const nodeId = addOnlineProxyNode('malformed-proxy');
    // The body cannot be read as evidence at all, so both domains it carries are
    // unread rather than broken. The summary read answered and keeps its own two.
    mockFetch((url) => (url.endsWith(EVIDENCE_PATH)
      ? jsonResponse({ generatedAt: Date.now(), workloads: { nonsense: true } })
      : jsonResponse(summaryBody([row('web')]))));

    const { body } = await getReadiness({ domains: ALL_DOMAINS, nodeIds: String(nodeId) });
    const node = rowOf(body, nodeId);
    for (const domain of ['workloads', 'security'] as const) {
      expect(node.cells[domain], domain).toMatchObject({ state: 'unavailable', reasonCode: 'domain_error' });
    }
    expect(node.cells.updates).toMatchObject({ state: 'healthy', reasonCode: null });
    expect(node.cells.recovery).toMatchObject({ state: 'healthy', reasonCode: null });
    expect(node.stackCount).toBeNull();

    // The same read is what Connectivity probes, and a payload it cannot read is
    // not contact: the column falls back to the hub's stored view of the node
    // rather than calling it healthy, and the stamp is left alone.
    expect(node.reachability.probedLive).toBe(false);
    expect(node.cells.connectivity).toMatchObject({ state: 'degraded', reasonCode: 'contact_stale', source: 'stored' });
    expect(contactSecondsOf(nodeId)).toBe(PRIOR_CONTACT);
    expectCellsMatchDomains(body);
  });

  it('reads a 404 evidence route as version skew rather than as an outage', async () => {
    const nodeId = addOnlineProxyNode('older-peer');
    const urls: string[] = [];
    mockFetch((url) => {
      urls.push(url);
      if (url.endsWith(EVIDENCE_PATH)) return new Response('not found', { status: 404 });
      return jsonResponse(summaryBody([row('web')]));
    });

    const { body } = await getReadiness({ domains: ALL_DOMAINS, nodeIds: String(nodeId) });
    // The node is up and its build is older, so the tier-two read is still worth
    // attempting while the three evidence-fed domains name the missing route.
    expect(urls.sort()).toEqual([`${PROXY_BASE}${EVIDENCE_PATH}`, `${PROXY_BASE}${SUMMARY_PATH}`].sort());
    const node = rowOf(body, nodeId);
    for (const domain of ['connectivity', 'workloads', 'security'] as const) {
      expect(node.cells[domain], domain).toMatchObject({ state: 'unavailable', reasonCode: 'capability_absent', source: 'live' });
    }
    expect(node.cells.updates).toMatchObject({ state: 'healthy', reasonCode: null });
    expect(node.cells.recovery).toMatchObject({ state: 'healthy', reasonCode: null });
    expect(node.stackCount).toBeNull();
    // Nothing here is an unreachable node, and a 404 counts as contact: the node
    // answered, which is what the hub's stamp records.
    expect(findingIds(body.findings)).not.toContain(`connectivity:${nodeId}:node_unreachable`);
    expect(contactSecondsOf(nodeId)).toBeGreaterThan(PRIOR_CONTACT);
    expectCellsMatchDomains(body);
  });

  it('keeps a node that answers live when a sibling predates both routes', async () => {
    // Version skew belongs to one node's build and to nothing beside it. A hub
    // that let an older peer's missing routes reach the node next to it would
    // erase trustworthy evidence, which is the mixed-fleet case the two node-
    // local routes exist to keep out of each other's way.
    const older = addProxyNode('older-peer', PROXY_BASE);
    const newer = addProxyNode('newer-peer', HEALTHY_BASE);
    setNodeStatus(older, 'online');
    setNodeStatus(newer, 'online');
    mockTargets({ [older]: proxyTarget(PROXY_BASE), [newer]: proxyTarget(HEALTHY_BASE) });
    mockFetch((url) => (url.startsWith(PROXY_BASE)
      // Neither route exists on the older build, so it answers both with 404.
      ? new Response('not found', { status: 404 })
      : nodeReadHandler(evidenceBody(), summaryBody([row('web')]))(url)));

    const { body } = await getReadiness({ domains: ALL_DOMAINS });
    // All five read the same way, over both routes: the node is up and its build
    // simply has no such endpoint, so this is version skew rather than an outage
    // or an empty answer. A 404 that reached the aggregator as an error would
    // make an older peer look like a broken one, which is the misread the
    // capability tri-state exists to prevent.
    const stale = rowOf(body, older);
    for (const domain of ['connectivity', 'workloads', 'security', 'updates', 'recovery'] as const) {
      expect(stale.cells[domain], domain).toMatchObject({ state: 'unavailable', reasonCode: 'capability_absent' });
    }

    const live = rowOf(body, newer);
    for (const domain of ['connectivity', 'workloads', 'security', 'updates', 'recovery'] as const) {
      expect(live.cells[domain], domain).toMatchObject({ state: 'healthy', reasonCode: null });
    }
    expectCellsMatchDomains(body);
  });

  it('keeps the evidence domains when the summary read fails', async () => {
    const nodeId = addOnlineProxyNode('summary-down');
    mockFetch((url) => (url.endsWith(SUMMARY_PATH)
      ? new Response('boom', { status: 500 })
      : jsonResponse(evidenceBody())));

    const { body } = await getReadiness({ domains: ALL_DOMAINS, nodeIds: String(nodeId) });
    const node = rowOf(body, nodeId);
    for (const domain of ['updates', 'recovery'] as const) {
      expect(node.cells[domain], domain).toMatchObject({ state: 'unavailable', reasonCode: 'domain_error', source: 'live' });
    }
    for (const domain of ['connectivity', 'workloads', 'security'] as const) {
      expect(node.cells[domain], domain).toMatchObject({ state: 'healthy', reasonCode: null });
    }
    // The node was reached, so the counts it reported survive its failed sibling.
    expect(node.stackCount).toBe(2);
    expectCellsMatchDomains(body);
  });

  it('publishes a stack row reason this hub registers, and downgrades one it does not', async () => {
    const nodeId = addOnlineProxyNode('reason-proxy');
    // The summary is assembled by hand rather than through `summaryBody`: one row
    // carries a reason this build has no member for, which is exactly what a peer
    // running ahead sends and not something a typed fixture can express.
    mockFetch(nodeReadHandler(evidenceBody(), {
      generatedAt: Date.now(),
      stale: false,
      truncated: false,
      stacks: [
        { stack: 'known', update: null, rollback: null, unavailableReason: 'summary_truncated' },
        { stack: 'foreign', update: null, rollback: null, unavailableReason: 'checks_failed_elsewhere' },
      ],
    }));

    const { body } = await getReadiness({ domains: 'updates', nodeIds: String(nodeId) });
    // A reason from a peer running ahead is not a fact about the stack, so the
    // row is reported unknown rather than as an unread domain.
    expect(findingIds(body.findings).sort()).toEqual([
      `updates:${nodeId}:foreign:stacks_unknown`,
      `updates:${nodeId}:known:summary_truncated`,
    ].sort());
    // Both rows are unknown, so the cell keeps the first row's reason.
    expect(rowOf(body, nodeId).cells.updates).toMatchObject({ state: 'unknown', reasonCode: 'summary_truncated' });
  });

  it('scrubs a peer explanation once more before it reaches the browser', async () => {
    const nodeId = addOnlineProxyNode('redaction-proxy');
    // A stack's reason is the one free-text field on this wire, and the contract
    // puts the scrubbing obligation on both producers. The node is one of them;
    // this hub is the other, and it is the last one before the text is rendered.
    mockFetch(nodeReadHandler(evidenceBody(), summaryBody([
      row('web', { update: 'blocked', topReason: 'could not read /home/example/app/.env' }),
    ])));

    const { body } = await getReadiness({ domains: 'updates', nodeIds: String(nodeId) });
    const finding = body.findings.find((candidate) => candidate.id === `updates:${nodeId}:web:update_blocked`)!;
    expect(finding.detail).toBe('could not read /home/<user>/app/.env');
  });

  it('never reads Recovery as healthy with no snapshot to read', async () => {
    clearSnapshots();
    try {
      const nodeId = addOnlineProxyNode('fresh-install');
      mockFetch(nodeReadHandler(evidenceBody(), summaryBody([row('web')])));

      const { body } = await getReadiness({ domains: 'updates,recovery', nodeIds: String(nodeId) });
      const node = rowOf(body, nodeId);
      // A fleet that has never been captured has no recovery point, and the one
      // answer that may not stand in for that is "this node is captured".
      expect(node.cells.recovery).toMatchObject({ state: 'unknown', reasonCode: 'stacks_unknown' });
      expect(findingIds(body.findings)).toContain(`recovery:${nodeId}:stacks_unknown`);
      // The stacks themselves were judged, so the column beside it is healthy.
      expect(node.cells.updates).toMatchObject({ state: 'healthy', reasonCode: null });
      expectCellsMatchDomains(body);
    } finally {
      clearSnapshots();
      seedCapturedSnapshot();
    }
  });

  it('reads an unreadable skip column as unknown rather than as full coverage', async () => {
    clearSnapshots();
    try {
      const nodeId = addOnlineProxyNode('unreadable-skip');
      mockFetch(nodeReadHandler(evidenceBody(), summaryBody([row('web')])));
      seedSnapshot('{not json');

      const { body } = await getReadiness({ domains: 'recovery', nodeIds: String(nodeId) });
      expect(rowOf(body, nodeId).cells.recovery).toMatchObject({ state: 'unknown', reasonCode: 'stacks_unknown' });
    } finally {
      clearSnapshots();
      seedCapturedSnapshot();
    }
  });

  it('reports a snapshot that skipped this node as a failed recovery point', async () => {
    clearSnapshots();
    try {
      const nodeId = addOnlineProxyNode('skipped-node');
      mockFetch(nodeReadHandler(evidenceBody(), summaryBody([row('web')])));
      seedSnapshot(JSON.stringify([{ nodeId }]));

      const { body } = await getReadiness({ domains: 'recovery', nodeIds: String(nodeId) });
      expect(rowOf(body, nodeId).cells.recovery).toMatchObject({ state: 'degraded', reasonCode: 'snapshot_failed' });
      const finding = body.findings.find((candidate) => candidate.id === `recovery:${nodeId}:snapshot_failed`)!;
      expect(finding).toMatchObject({ severity: 'degraded', count: 1, target: { surface: 'fleet-snapshots' } });
    } finally {
      clearSnapshots();
      seedCapturedSnapshot();
    }
  });

  it('ages the Recovery cell by the older of the reads that decided it', async () => {
    clearSnapshots();
    try {
      const nodeId = addOnlineProxyNode('aged-snapshot');
      mockFetch(nodeReadHandler(evidenceBody(), summaryBody([row('web')])));
      // The snapshot is old and it is what decided this column, because it skipped
      // this node. The verdicts beside it arrived just now, so the age the cell
      // publishes has to be the older of the two rather than the newest number in
      // the payload: an age taken from the fresh read would report a recovery
      // point the fleet does not have as recently checked.
      const snapshotAgeMs = 10 * 60_000;
      seedSnapshot(JSON.stringify([{ nodeId }]), '[]', Date.now() - snapshotAgeMs);

      const { body } = await getReadiness({ domains: 'recovery', nodeIds: String(nodeId) });
      const recovery = rowOf(body, nodeId).cells.recovery!;
      expect(recovery).toMatchObject({ state: 'degraded', reasonCode: 'snapshot_failed' });
      expect(recovery.evidenceAgeMs).toBeGreaterThanOrEqual(snapshotAgeMs);
    } finally {
      clearSnapshots();
      seedCapturedSnapshot();
    }
  });

  it('classifies the security inputs beside the posture', async () => {
    const nodeId = addOnlineProxyNode('capped-scans');
    // A posture the derivation calls Secure, over inputs that say the pass it read
    // was capped and that two scans are stale. Neither is visible in the word
    // alone, which is why the column reads them.
    mockFetch(nodeReadHandler(evidenceBody({
      security: {
        generatedAt: Date.now(),
        posture: 'Secure',
        posturePartial: true,
        scannerAvailable: true,
        staleScans: 2,
        failedScans: 1,
        lastSuccessfulScanAt: Date.now(),
      },
    }), summaryBody([])));

    const { body } = await getReadiness({ domains: 'security,workloads', nodeIds: String(nodeId) });
    const cell = rowOf(body, nodeId).cells.security!;
    expect(cell).toMatchObject({ state: 'degraded', reasonCode: 'scans_stale' });
    // The failed run is counted and raises no concern of its own: it is a tally
    // over the whole retention window rather than a fact about this moment, so a
    // node that failed one scan keeps the rest of its column. Security's own
    // derivation files it as context only, and a second surface escalating the
    // same input would be a second authority over one fact.
    expect(cell.counts).toEqual({ staleScans: 2, failedScans: 1 });
    expect(findingIds(body.findings).sort()).toEqual([
      `security:${nodeId}:posture_partial`,
      `security:${nodeId}:scans_stale`,
    ].sort());
    // The same read carries Workloads, and a capped security pass is not a
    // workload problem.
    expect(rowOf(body, nodeId).cells.workloads).toMatchObject({ state: 'healthy', reasonCode: null });
  });

  it('does not read a lifetime count of failed scan runs as a degraded column', async () => {
    const nodeId = addOnlineProxyNode('retried-scans');
    // Nine failed runs and nothing else: no stale scan, no cap, a Secure word and
    // a scanner that is answering. Every one of those runs may have been retried
    // since, and the count has no window, so it can only ever be a history. A
    // column that went degraded on it would stay degraded for the retention
    // window on a fleet that scans on a schedule, which is a column an operator
    // learns to stop reading.
    mockFetch(nodeReadHandler(evidenceBody({
      security: {
        generatedAt: Date.now(),
        posture: 'Secure',
        posturePartial: false,
        scannerAvailable: true,
        staleScans: 0,
        failedScans: 9,
        lastSuccessfulScanAt: Date.now(),
      },
    }), summaryBody([])));

    const { body } = await getReadiness({ domains: 'security', nodeIds: String(nodeId) });
    expect(rowOf(body, nodeId).cells.security).toMatchObject({
      state: 'healthy',
      reasonCode: null,
      counts: { staleScans: 0, failedScans: 9 },
    });
    expect(findingIds(body.findings)).toEqual([]);
  });

  it('repeats the scanner own verdict when it asks for action', async () => {
    const nodeId = addOnlineProxyNode('action-needed');
    // The scanner answered, is not capped, and has nothing stale or failed about
    // it: the whole of the finding is the verdict the derivation reached, which
    // is the one security fact readiness repeats rather than re-derives.
    mockFetch(nodeReadHandler(evidenceBody({
      security: {
        generatedAt: Date.now(),
        posture: 'Action needed',
        posturePartial: false,
        scannerAvailable: true,
        staleScans: 0,
        failedScans: 0,
        lastSuccessfulScanAt: Date.now(),
      },
    }), summaryBody([])));

    const { body } = await getReadiness({ domains: 'security', nodeIds: String(nodeId) });
    expect(rowOf(body, nodeId).cells.security).toMatchObject({
      state: 'attention',
      reasonCode: 'posture_action_needed',
      counts: { staleScans: 0, failedScans: 0 },
    });
    expect(body.findings.find((candidate) => candidate.id === `security:${nodeId}:posture_action_needed`)).toMatchObject({
      severity: 'attention',
      detail: null,
      target: { surface: 'security', tab: null },
    });
  });

  it('says which input is missing when the posture is Unknown', async () => {
    const noScanner = addProxyNode('no-scanner', PROXY_BASE);
    const neverRan = addProxyNode('never-scanned', HEALTHY_BASE);
    setNodeStatus(noScanner, 'online');
    setNodeStatus(neverRan, 'online');
    mockTargets({ [noScanner]: proxyTarget(PROXY_BASE), [neverRan]: proxyTarget(HEALTHY_BASE) });
    mockFetch((url) => (url.startsWith(PROXY_BASE)
      ? nodeReadHandler(evidenceBody({
        security: {
          generatedAt: Date.now(),
          posture: 'Unknown',
          posturePartial: false,
          scannerAvailable: false,
          staleScans: 0,
          failedScans: 0,
          lastSuccessfulScanAt: null,
        },
      }), summaryBody([]))(url)
      : nodeReadHandler(evidenceBody({
        security: {
          generatedAt: Date.now(),
          posture: 'Unknown',
          posturePartial: false,
          scannerAvailable: true,
          staleScans: 0,
          failedScans: 0,
          lastSuccessfulScanAt: null,
        },
      }), summaryBody([]))(url)));

    const { body } = await getReadiness({ domains: 'security', nodeIds: `${noScanner},${neverRan}` });
    // The word is the same on both nodes; what differs is the input beside it,
    // which is the whole reason the evidence carries those inputs.
    expect(rowOf(body, noScanner).cells.security).toMatchObject({ state: 'unknown', reasonCode: 'scanner_unavailable' });
    expect(rowOf(body, neverRan).cells.security).toMatchObject({ state: 'unknown', reasonCode: 'scans_never_completed' });
    const scannerFinding = body.findings.find(
      (finding) => finding.id === `security:${noScanner}:scanner_unavailable`,
    )!;
    expect(scannerFinding.target).toEqual({ surface: 'security', tab: 'scanner' });
  });

  it('costs only the Security column when a peer sends a posture word this build does not know', async () => {
    const nodeId = addOnlineProxyNode('future-posture');
    // The payload is well formed and every other field in it is readable, so a
    // word from a newer vocabulary must not take the read down with it.
    mockFetch(nodeReadHandler(evidenceBody({
      security: {
        generatedAt: Date.now(),
        posture: 'Quarantined',
        posturePartial: false,
        scannerAvailable: true,
        staleScans: 0,
        failedScans: 0,
        lastSuccessfulScanAt: null,
      },
    }), summaryBody([row('web')])));

    const { body } = await getReadiness({ domains: ALL_DOMAINS, nodeIds: String(nodeId) });
    const node = rowOf(body, nodeId);
    expect(node.cells.security).toMatchObject({ state: 'unavailable', reasonCode: 'domain_error' });
    expect(node.cells.workloads).toMatchObject({ state: 'healthy', reasonCode: null });
    // The read itself was accepted, so the rest of the payload reached its domains.
    expect(node.stackCount).toBe(2);
    expect(node.cells.updates).toMatchObject({ state: 'healthy', reasonCode: null });
    expectCellsMatchDomains(body);
  });

  it('reads a posture word that the map inherits rather than owns as an unknown word', async () => {
    const nodeId = addOnlineProxyNode('inherited-posture');
    // `constructor` is on the prototype chain of every object, so a lookup that
    // asked whether the word was known without asking whether the map owns it
    // would find `Object.prototype.constructor` and read this peer as a posture
    // this build classifies. The other column is what tells the two apart: the
    // refusal is a statement about this column, so the payload beside it is
    // untouched and the total still counts.
    mockFetch(nodeReadHandler(evidenceBody({
      security: {
        generatedAt: Date.now(),
        posture: 'constructor',
        posturePartial: false,
        scannerAvailable: true,
        staleScans: 0,
        failedScans: 0,
        lastSuccessfulScanAt: null,
      },
    }), summaryBody([row('web')])));

    const { body } = await getReadiness({ domains: 'workloads,security', nodeIds: String(nodeId) });
    const node = rowOf(body, nodeId);
    expect(node.cells.security).toMatchObject({ state: 'unavailable', reasonCode: 'domain_error' });
    expect(node.cells.workloads).toMatchObject({ state: 'healthy', reasonCode: null });
    expect(node.stackCount).toBe(2);
    expectCellsMatchDomains(body);
  });

  it('withholds the stack total when a tally it would sum did not arrive as a number', async () => {
    const nodeId = addOnlineProxyNode('odd-counts');
    // One tally in this payload is not a number, so the filter drops it from the
    // counts. What is left cannot be summed into a total: the column keeps the
    // counts it could read, and the number built from them is withheld, because a
    // total short by an unknown amount is one a reader cannot tell from a
    // complete total.
    mockFetch(nodeReadHandler(evidenceBody({
      workloads: {
        generatedAt: Date.now(),
        counts: { running: 2, weird: 'two' },
        degraded: false,
        stale: false,
        problems: [],
      },
    }), summaryBody([])));

    const { body } = await getReadiness({ domains: 'workloads', nodeIds: String(nodeId) });
    const node = rowOf(body, nodeId);
    expect(node.stackCount).toBeNull();
    // The column is healthy because the payload said so; the unreadable tally is
    // dropped from the counts rather than escalated into a cell state.
    expect(node.cells.workloads).toMatchObject({ state: 'healthy', reasonCode: null, counts: { running: 2 } });
  });

  it('withholds the stack total on a degraded read that still publishes its counts', async () => {
    const nodeId = addOnlineProxyNode('short-tally');
    // The payload says its own counts are short of the node, which is the same
    // claim about the total as an unreadable tally: the counts are published and
    // the number is not.
    mockFetch(nodeReadHandler(evidenceBody({
      workloads: {
        generatedAt: Date.now(),
        counts: { running: 1 },
        degraded: true,
        stale: false,
        problems: [],
      },
    }), summaryBody([])));

    const { body } = await getReadiness({ domains: 'workloads', nodeIds: String(nodeId) });
    const node = rowOf(body, nodeId);
    expect(node.stackCount).toBeNull();
    expect(node.cells.workloads).toMatchObject({
      state: 'unknown',
      reasonCode: 'status_evidence_degraded',
      counts: { running: 1 },
    });
  });

  it('maps each workload problem to its own code and one unknown word to one row', async () => {
    const nodeId = addOnlineProxyNode('problem-proxy');
    mockFetch(nodeReadHandler(evidenceBody({
      workloads: {
        generatedAt: Date.now(),
        counts: { running: 1 },
        degraded: false,
        stale: false,
        problems: [
          { stack: 'a', status: 'exited' },
          { stack: 'b', status: 'partial' },
          { stack: 'c', status: 'surprise' },
        ],
      },
    }), summaryBody([])));

    const { body } = await getReadiness({ domains: 'workloads,security', nodeIds: String(nodeId) });
    const cell = rowOf(body, nodeId).cells.workloads!;
    expect(cell).toMatchObject({ state: 'attention', reasonCode: 'workloads_exited', counts: { running: 1 } });
    expect(findingIds(body.findings).sort()).toEqual([
      `workloads:${nodeId}:a:workloads_exited`,
      `workloads:${nodeId}:b:workloads_partial`,
      `workloads:${nodeId}:c:workloads_unknown`,
    ].sort());
    // One unrecognized status word is one stack's answer, not the column's.
    expect(rowOf(body, nodeId).cells.security).toMatchObject({ state: 'healthy', reasonCode: null });
  });

  it('degrades Workloads when the node served a stale or degraded status bundle', async () => {
    const nodeId = addOnlineProxyNode('stale-status');
    mockFetch(nodeReadHandler(evidenceBody({
      workloads: { generatedAt: Date.now(), counts: {}, degraded: true, stale: true, problems: [] },
    }), summaryBody([])));

    const { body } = await getReadiness({ domains: 'workloads', nodeIds: String(nodeId) });
    expect(rowOf(body, nodeId).cells.workloads).toMatchObject({ state: 'unknown', reasonCode: 'status_evidence_stale' });
    // A bundle that arrived with no problems in it is still not healthy when the
    // collector that produced it failed or served a stale entry.
    expect(findingIds(body.findings).sort()).toEqual([
      `workloads:${nodeId}:status_evidence_degraded`,
      `workloads:${nodeId}:status_evidence_stale`,
    ].sort());
  });

  it('classifies a Control failure newer than its last success as degraded', async () => {
    const nodeId = addProxyNode('control-degraded', PROXY_BASE);
    seedSyncFailureAfterSuccess(nodeId, 'token was rejected');
    // No transport: this domain is classified from the hub's own rows.
    mockTargets({ [nodeId]: null });

    const { body } = await getReadiness({ domains: 'control', nodeIds: String(nodeId) });
    const cell = rowOf(body, nodeId).cells.control!;
    expect(cell).toMatchObject({
      state: 'degraded',
      reasonCode: 'control_degraded',
      source: 'stored',
      counts: { resources: 1 },
    });
    // Retriable, unlike the sticky pause: the reason is published, redacted.
    const finding = body.findings.find((candidate) => candidate.id === `control:${nodeId}:control_degraded`)!;
    expect(finding).toMatchObject({ severity: 'degraded', detail: 'token was rejected', target: { surface: 'settings-nodes' } });
  });

  it('reports the hub stored view as contact_stale when a probe fails and that view is stale', async () => {
    const nodeId = addOnlineProxyNode('stale-contact');
    mockFetch((url) => (url.endsWith(EVIDENCE_PATH)
      ? new Response('boom', { status: 500 })
      : jsonResponse(summaryBody([]))));

    // No tier two, so the node settles on its evidence budget rather than the
    // summary one.
    const { body } = await getReadiness({ domains: 'connectivity,workloads', nodeIds: String(nodeId) });
    const node = rowOf(body, nodeId);
    // The probe failed, so the column falls back to the stored classification,
    // which grades a stale contact below a live outage.
    expect(node.reachability.note).toBe('Proxy contact missing or stale (cached status)');
    expect(node.reachability.probedLive).toBe(false);
    expect(node.cells.connectivity).toMatchObject({ state: 'degraded', reasonCode: 'contact_stale', source: 'stored' });
    expect(node.cells.workloads).toMatchObject({ state: 'unavailable', reasonCode: 'domain_error' });
    expectCellsMatchDomains(body);
  });

  it('bounds how many nodes are read at once', async () => {
    const nodeIds: number[] = [];
    const targets: Record<number, ProxyTarget> = {};
    for (let index = 0; index < 12; index += 1) {
      const apiUrl = `http://fan-${index}.example.com`;
      const id = addProxyNode(`fan-${index}`, apiUrl);
      nodeIds.push(id);
      targets[id] = proxyTarget(apiUrl);
    }
    mockTargets(targets);
    const inFlight = new Set<string>();
    let peak = 0;
    mockFetch(async (url) => {
      inFlight.add(new URL(url).host);
      peak = Math.max(peak, inFlight.size);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight.delete(new URL(url).host);
      return nodeReadHandler(evidenceBody(), summaryBody([row('web')]))(url);
    });

    // Connectivity alone is one read per node, so the hosts in flight are the
    // nodes in flight. Eight is the pool this fan-out publishes as its bound.
    const { body } = await getReadiness({ domains: 'connectivity', nodeIds: nodeIds.join(',') });
    expect(body.nodes).toHaveLength(12);
    expect(peak).toBeLessThanOrEqual(8);
    // A pool of one would satisfy the bound and serialize the page, so the
    // bound is checked from both sides.
    expect(peak).toBeGreaterThan(1);
  });
});

// --- budgets ----------------------------------------------------------------

describe('readiness budgets', () => {
  it('gives the hub more time to read a node than the node takes to answer', async () => {
    // The node bounds its own pass and answers with partial results, which is why
    // its deadline exists. The hub's budget for the same read is the outer bound,
    // for a node that cannot answer at all: at or under the node's deadline it
    // would cut off answers that were about to arrive, costing both verdict
    // columns on every node in the fleet in a way that reads as an outage rather
    // than as one stale constant. The two live in modules that do not import each
    // other, so nothing else holds the ordering.
    const { SUMMARY_BUDGET_MS } = await import('../services/readiness/readinessAggregator');
    const { PASS_DEADLINE_MS } = await import('../services/readiness/stackReadinessSummary');
    expect(SUMMARY_BUDGET_MS).toBeGreaterThan(PASS_DEADLINE_MS);
  }, 20_000);

  it('settles a row that owes only the evidence read on that read own budget', async () => {
    const nodeId = addOnlineProxyNode('slow-evidence');
    const urls: string[] = [];
    mockFetch((url, init) => {
      urls.push(url);
      return hungUntilAbort(init);
    });

    const { body, elapsedMs } = await getReadiness({ domains: 'workloads', nodeIds: String(nodeId) });
    // One read was owed and it hung, so the row settles when that read gives up
    // rather than waiting on the tier this request never asked for.
    expect(urls).toEqual([`${PROXY_BASE}${EVIDENCE_PATH}`]);
    expect(elapsedMs).toBeGreaterThanOrEqual(TIER_ONE_FLOOR_MS);
    expect(elapsedMs).toBeLessThan(TIER_ONE_CEILING_MS);
    expect(rowOf(body, nodeId).cells.workloads)
      .toMatchObject({ state: 'unavailable', reasonCode: 'probe_timeout' });
    expectCellsMatchDomains(body);
  }, 20_000);
});

describe('GET /api/fleet/configuration (retired)', () => {
  it('no longer answers, whatever the caller holds', async () => {
    // Retired rather than narrowed: the inventory it returned (every node's
    // compose paths and tier, behind a `node:read` guard) is broader than
    // readiness needs, and the one tab that read it is replaced in this same
    // change, so the route goes out alongside its only caller instead of being
    // kept alive for a consumer nobody has. A fleet fan-out left in that state
    // is the kind of dead code that outlives its reason.
    for (const token of [authHeader, viewerAuthHeader]) {
      const res = await request(app).get('/api/fleet/configuration').set('Authorization', token);
      expect(res.status).toBe(404);
    }
  });
});

describe('GET /api/fleet/readiness input validation', () => {
  /** No transport anywhere: the validation cases never need a read to run. */
  function noTransports(): void {
    vi.spyOn(NodeRegistry.getInstance(), 'getProxyTarget').mockReturnValue(null);
  }

  it('rejects an unauthenticated request with 401', async () => {
    noTransports();
    const res = await request(app).get('/api/fleet/readiness');
    expect(res.status).toBe(401);
  });

  it('rejects an unknown domain instead of answering with the default set', async () => {
    noTransports();
    const res = await request(app)
      .get('/api/fleet/readiness?domains=connectivity,banana')
      .set('Authorization', authHeader);
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('domains');
  });

  it('rejects a malformed node id list', async () => {
    noTransports();
    for (const raw of ['banana', '0', '-3', '1,2,x']) {
      const res = await request(app)
        .get(`/api/fleet/readiness?nodeIds=${raw}`)
        .set('Authorization', authHeader);
      expect(res.status, `nodeIds=${raw}`).toBe(400);
    }
  });

  it('collapses a repeated domain and treats an empty list as every node', async () => {
    noTransports();
    const res = await request(app)
      .get('/api/fleet/readiness?domains=connectivity,connectivity,&nodeIds=')
      .set('Authorization', authHeader);
    expect(res.status).toBe(200);
    expect(res.body.domains).toEqual(['connectivity']);
    // The empty `nodeIds` selects the local node, which the hub reads itself.
    expect(res.body.nodes.some((node: FleetReadinessNode) => node.type === 'local')).toBe(true);
  });
});
