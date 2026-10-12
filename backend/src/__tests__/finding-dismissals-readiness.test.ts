/**
 * Readiness dismissals: the scope rules, the policy a finding carries, when the
 * evidence proves a finding gone, and the routes that write them.
 *
 * The route cases mock the readiness build so a finding's fingerprint and
 * severity are fixed by the test; what they prove is that the server uses its
 * own read, never what the request claims.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import { setupTestDb, cleanupTestDb, TEST_USERNAME, TEST_JWT_SECRET } from './helpers/setupTestDb';
import type {
  FleetReadinessNode,
  FleetReadinessResponse,
  NodeDomainCell,
  ReadinessFinding,
} from '../services/readiness/types';
import type { FindingDismissalRow } from '../services/findingDismissals/types';

const build = vi.hoisted(() => ({ buildFleetReadiness: vi.fn() }));
vi.mock('../services/readiness/readinessAggregator', async (importOriginal) => {
  const original = await importOriginal<typeof import('../services/readiness/readinessAggregator')>();
  return { ...original, buildFleetReadiness: build.buildFleetReadiness };
});

let tmpDir: string;
let app: import('express').Express;
let adminAuth: string;
let viewerAuth: string;
let localNodeId: number;
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;
let FindingDismissalStore: typeof import('../services/findingDismissals/FindingDismissalStore').FindingDismissalStore;
let dismissals: typeof import('../services/readiness/readinessDismissals');

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ app } = await import('../index'));
  ({ DatabaseService } = await import('../services/DatabaseService'));
  ({ FindingDismissalStore } = await import('../services/findingDismissals/FindingDismissalStore'));
  dismissals = await import('../services/readiness/readinessDismissals');

  adminAuth = `Bearer ${jwt.sign({ username: TEST_USERNAME }, TEST_JWT_SECRET, { expiresIn: '5m' })}`;
  const db = DatabaseService.getInstance();
  db.addUser({ username: 'dismiss-viewer', password_hash: await bcrypt.hash('password123', 1), role: 'viewer' });
  const viewer = db.getUserByUsername('dismiss-viewer')!;
  viewerAuth = `Bearer ${jwt.sign(
    { username: 'dismiss-viewer', role: 'viewer', tv: viewer.token_version },
    TEST_JWT_SECRET,
    { expiresIn: '5m' },
  )}`;
  localNodeId = db.getNodes().find((node) => node.type === 'local')!.id;
});

afterAll(() => {
  cleanupTestDb(tmpDir);
});

beforeEach(() => {
  build.buildFleetReadiness.mockReset();
  DatabaseService.getInstance().getDb().prepare('DELETE FROM finding_dismissals').run();
});

function finding(overrides: Partial<ReadinessFinding> = {}): ReadinessFinding {
  return {
    id: `workloads:${localNodeId}:web:workloads_partial`,
    domain: 'workloads',
    nodeId: localNodeId,
    stack: 'web',
    code: 'workloads_partial',
    severity: 'degraded',
    count: 1,
    verdict: null,
    detail: null,
    target: { surface: 'stack', nodeId: localNodeId, stackName: 'web' },
    fingerprint: 'fp-server',
    dismissPolicy: 'any',
    ...overrides,
  };
}

function response(findings: ReadinessFinding[]): FleetReadinessResponse {
  return {
    generatedAt: Date.now(),
    domains: ['workloads'],
    domainsOmitted: [],
    summary: { nodes: { attention: 0, degraded: 0, unavailable: 0, unknown: 0, healthy: 0 }, findings: { attention: 0, degraded: 0, unavailable: 0, unknown: 0 } },
    findings,
    nodes: [],
    dismissals: [],
  };
}

function cell(overrides: Partial<NodeDomainCell> = {}): NodeDomainCell {
  return { state: 'healthy', reasonCode: null, counts: {}, evidenceAgeMs: 0, source: 'live', ...overrides } as NodeDomainCell;
}

function nodeWith(id: number, cells: FleetReadinessNode['cells']): Omit<FleetReadinessNode, 'state'> {
  return { id, name: `n${id}`, type: 'local', mode: 'proxy', transport: 'local', reachability: {} as FleetReadinessNode['reachability'], cells, stackCount: 0 };
}

function row(overrides: Partial<FindingDismissalRow> = {}): FindingDismissalRow {
  return {
    id: 1, node_id: 1, surface: 'readiness', finding_key: 'workloads:1:web:workloads_partial', stack_name: 'web',
    fingerprint: 'fp', severity: 'degraded', count_at: 1, mode: 'until_change', expires_at: null,
    created_by: 'someone', created_at: 1, ...overrides,
  };
}

describe('parseReadinessKey', () => {
  it('reads node, stack and domain from the id alone', () => {
    expect(dismissals.parseReadinessKey('workloads:3:web:workloads_exited')).toEqual({ domain: 'workloads', nodeId: 3, stack: 'web' });
    expect(dismissals.parseReadinessKey('security:2:scans_stale')).toEqual({ domain: 'security', nodeId: 2, stack: null });
  });

  it.each(['', 'bogus:1:node_unreachable', 'workloads:0:x', 'workloads:abc:x', 'workloads:1', 'workloads:1:a:b:c', 'workloads:-1:x'])(
    'refuses %j', (key) => {
      expect(dismissals.parseReadinessKey(key)).toBeNull();
    },
  );
});

describe('dismissPolicyFor', () => {
  it('never lets Readiness dismiss a verdict Security owns', () => {
    expect(dismissals.dismissPolicyFor({ code: 'posture_action_needed', severity: 'attention' })).toBe('none');
    expect(dismissals.dismissPolicyFor({ code: 'posture_partial', severity: 'unknown' })).toBe('none');
  });

  it('allows only timed dismissal of evidence that could not be read', () => {
    expect(dismissals.dismissPolicyFor({ code: 'node_unreachable', severity: 'attention' })).toBe('timed');
    expect(dismissals.dismissPolicyFor({ code: 'pilot_disconnected', severity: 'attention' })).toBe('timed');
    expect(dismissals.dismissPolicyFor({ code: 'scans_never_completed', severity: 'unknown' })).toBe('timed');
    expect(dismissals.dismissPolicyFor({ code: 'control_unknown', severity: 'unknown' })).toBe('timed');
    expect(dismissals.dismissPolicyFor({ code: 'summary_truncated', severity: 'unknown' })).toBe('timed');
    expect(dismissals.dismissPolicyFor({ code: 'update_blocked', severity: 'unavailable' })).toBe('timed');
  });

  it('allows every mode for an ordinary finding', () => {
    expect(dismissals.dismissPolicyFor({ code: 'workloads_exited', severity: 'attention' })).toBe('any');
  });

  it('refuses a code this build does not know rather than defaulting to permissive', () => {
    expect(dismissals.dismissPolicyFor({ code: 'from_a_newer_peer' as never, severity: 'attention' })).toBe('none');
  });
});

describe('isFindingProvenGone', () => {
  const key = 'workloads:1:web:workloads_partial';
  const gone = (r: FindingDismissalRow, nodes: Omit<FleetReadinessNode, 'state'>[], findings: ReadinessFinding[]) =>
    dismissals.isFindingProvenGone(r, nodes, new Set(findings.map((f) => f.id)), findings);

  it('retires a dismissal when a live, evaluated cell no longer lists the finding', () => {
    expect(gone(row(), [nodeWith(1, { workloads: cell() })], [])).toBe(true);
  });

  it('keeps it while the finding is still listed', () => {
    expect(gone(row(), [nodeWith(1, { workloads: cell({ state: 'degraded', reasonCode: 'workloads_partial' }) })], [finding({ id: key, nodeId: 1 })])).toBe(false);
  });

  it('keeps it when the cell was answered from stored evidence', () => {
    expect(gone(row(), [nodeWith(1, { workloads: cell({ source: 'stored' }) })], [])).toBe(false);
  });

  it('keeps it when the domain could not be evaluated', () => {
    expect(gone(row(), [nodeWith(1, { workloads: cell({ state: 'unavailable', reasonCode: 'domain_error' }) })], [])).toBe(false);
    expect(gone(row(), [nodeWith(1, { workloads: cell({ state: 'unknown', reasonCode: 'workloads_unknown' }) })], [])).toBe(false);
  });

  it('keeps it when the node has no cell for the domain', () => {
    expect(gone(row(), [nodeWith(1, {})], [])).toBe(false);
    expect(gone(row(), [], [])).toBe(false);
  });

  it('keeps it while the read was partial, even if the cell looks evaluated', () => {
    const partial = finding({ id: 'workloads:1:status_evidence_stale', nodeId: 1, stack: null, code: 'status_evidence_stale', severity: 'unknown' });
    expect(gone(row(), [nodeWith(1, { workloads: cell({ state: 'degraded', reasonCode: 'workloads_partial' }) })], [partial])).toBe(false);
  });

  it.each(['workloads_unknown', 'scans_never_completed'] as const)('keeps it while the domain reports %s', (code) => {
    const partial = finding({ id: `workloads:1:${code}`, nodeId: 1, stack: null, code, severity: 'unknown' });
    expect(gone(row(), [nodeWith(1, { workloads: cell({ state: 'degraded', reasonCode: 'workloads_partial' }) })], [partial])).toBe(false);
  });

  it('keeps it while the node itself is flagged unreachable', () => {
    const unreachable = finding({ id: 'connectivity:1:node_unreachable', domain: 'connectivity', nodeId: 1, stack: null, code: 'node_unreachable', severity: 'attention' });
    expect(gone(row(), [nodeWith(1, { workloads: cell() })], [unreachable])).toBe(false);
  });

  it('retires a control dismissal once the hub sees a healthy control cell', () => {
    const control = row({ finding_key: 'control:1:control_paused' });
    expect(gone(control, [nodeWith(1, { control: cell({ source: 'stored' }) })], [])).toBe(true);
    expect(gone(control, [nodeWith(1, { control: cell({ state: 'attention', reasonCode: 'control_paused' }) })], [])).toBe(false);
  });
});

describe('dismissalCovers', () => {
  const NOW = 10_000;
  const covers = (f: Partial<ReadinessFinding>, r: Partial<FindingDismissalRow>) =>
    dismissals.dismissalCovers({ ...finding(), ...f }, row(r), NOW);

  it('covers an unchanged finding', () => {
    expect(covers({ fingerprint: 'fp' }, {})).toBe(true);
  });

  it('stops covering a finding whose fingerprint moved, but only for until_change', () => {
    expect(covers({ fingerprint: 'other' }, {})).toBe(false);
    expect(covers({ fingerprint: 'other' }, { mode: 'forever' })).toBe(true);
  });

  it('stops covering a finding that got more severe, whatever the mode', () => {
    expect(covers({ severity: 'attention', fingerprint: 'fp' }, { mode: 'forever' })).toBe(false);
  });

  it('stops covering a finding whose count grew but not one whose count shrank', () => {
    expect(covers({ count: 2, fingerprint: 'fp' }, { mode: 'forever', count_at: 1 })).toBe(false);
    expect(covers({ count: 1, fingerprint: 'fp' }, { mode: 'forever', count_at: 3 })).toBe(true);
  });

  it('stops covering when the policy no longer allows the stored mode', () => {
    expect(covers({ dismissPolicy: 'none', fingerprint: 'fp' }, { mode: 'forever' })).toBe(false);
    expect(covers({ dismissPolicy: 'timed', fingerprint: 'fp' }, { mode: 'forever' })).toBe(false);
    expect(covers({ dismissPolicy: 'timed', fingerprint: 'fp' }, { mode: 'days', expires_at: NOW + 1 })).toBe(true);
  });

  it('honours a timed hold until its expiry', () => {
    expect(covers({ fingerprint: 'other' }, { mode: 'days', expires_at: NOW + 1 })).toBe(true);
    expect(covers({ fingerprint: 'fp' }, { mode: 'days', expires_at: NOW })).toBe(false);
  });
});

describe('FindingDismissalStore', () => {
  const facts = (fingerprint = 'fp') => ({
    nodeId: localNodeId, surface: 'readiness' as const, findingKey: `workloads:${localNodeId}:web:workloads_partial`,
    stackName: 'web', fingerprint, severity: 'degraded', count: 1,
  });

  it('keeps a stronger dismissal when someone dismisses the same finding for less', () => {
    const store = FindingDismissalStore.getInstance();
    store.dismiss(facts(), { mode: 'forever', expiresAt: null, createdBy: 'alice', now: 1000 });
    const second = store.dismiss(facts(), { mode: 'until_change', expiresAt: null, createdBy: 'bob', now: 2000 });
    expect(second.kept).toBe(true);
    expect(second.row.mode).toBe('forever');
    expect(second.row.created_by).toBe('alice');
    expect(store.list('readiness')).toHaveLength(1);
  });

  it('replaces a stronger dismissal that no longer covers the finding, so it can be dismissed again', () => {
    const store = FindingDismissalStore.getInstance();
    store.dismiss(facts(), { mode: 'forever', expiresAt: null, createdBy: 'alice', now: 1000 });
    const worse = store.dismiss({ ...facts(), count: 3 }, { mode: 'until_change', expiresAt: null, createdBy: 'bob', now: 2000 });
    expect(worse.kept).toBe(false);
    expect(worse.row).toMatchObject({ count_at: 3, mode: 'until_change', created_by: 'bob' });
    const sev = store.dismiss({ ...facts(), count: 3, severity: 'attention' }, { mode: 'until_change', expiresAt: null, createdBy: 'carol', now: 3000 });
    expect(sev.row.severity).toBe('attention');
  });

  it('refuses a timed dismissal without an expiry, and an expiry on any other mode', () => {
    const store = FindingDismissalStore.getInstance();
    expect(() => store.dismiss(facts(), { mode: 'days', expiresAt: null, createdBy: 'a', now: 1 })).toThrow();
    expect(() => store.dismiss(facts(), { mode: 'forever', expiresAt: 5, createdBy: 'a', now: 1 })).toThrow();
  });

  it('replaces a dismissal whose fingerprint no longer matches', () => {
    const store = FindingDismissalStore.getInstance();
    store.dismiss(facts('old'), { mode: 'forever', expiresAt: null, createdBy: 'alice', now: 1000 });
    const next = store.dismiss(facts('new'), { mode: 'until_change', expiresAt: null, createdBy: 'bob', now: 2000 });
    expect(next.kept).toBe(false);
    expect(next.row.fingerprint).toBe('new');
    expect(store.list('readiness')).toHaveLength(1);
  });

  it('is removed with its node', () => {
    const db = DatabaseService.getInstance();
    const nodeId = db.addNode({ name: 'gone', type: 'remote', mode: 'proxy', compose_dir: '/tmp', is_default: false, api_url: 'http://x.example.com', api_token: 't' });
    FindingDismissalStore.getInstance().dismiss(
      { ...facts(), nodeId, findingKey: `workloads:${nodeId}:web:workloads_partial` },
      { mode: 'until_change', expiresAt: null, createdBy: 'alice', now: 1 },
    );
    db.deleteNode(nodeId);
    expect(FindingDismissalStore.getInstance().list('readiness')).toHaveLength(0);
  });
});

describe('attachReadinessDismissals', () => {
  const insert = (overrides: Partial<Parameters<InstanceType<typeof FindingDismissalStore>['dismiss']>[0]> = {}, mode: 'days' | 'until_change' = 'until_change', expiresAt: number | null = null) =>
    FindingDismissalStore.getInstance().dismiss(
      { nodeId: localNodeId, surface: 'readiness', findingKey: `workloads:${localNodeId}:web:workloads_partial`, stackName: 'web', fingerprint: 'fp', severity: 'degraded', count: 1, ...overrides },
      { mode, expiresAt, createdBy: 'alice', now: 1 },
    ).row;

  it('publishes a dismissal whose finding is still listed and unchanged', () => {
    const listed = finding({ fingerprint: 'fp' });
    insert();
    const published = dismissals.attachReadinessDismissals({
      nodes: [nodeWith(localNodeId, { workloads: cell({ state: 'degraded', reasonCode: 'workloads_partial' }) })],
      findings: [listed], domains: ['workloads'], now: 1000, startedAt: 500,
    });
    expect(published.map((d) => d.findingKey)).toEqual([listed.id]);
  });

  it('retires a dismissal for a finding that is gone from a complete read', () => {
    insert();
    const published = dismissals.attachReadinessDismissals({
      nodes: [nodeWith(localNodeId, { workloads: cell() })], findings: [], domains: ['workloads'], now: 1000, startedAt: 500,
    });
    expect(published).toEqual([]);
    expect(FindingDismissalStore.getInstance().list('readiness')).toHaveLength(0);
  });

  it('keeps a dismissal through an outage', () => {
    insert();
    dismissals.attachReadinessDismissals({
      nodes: [nodeWith(localNodeId, { workloads: cell({ state: 'unavailable', reasonCode: 'domain_error', source: 'stored' }) })],
      findings: [], domains: ['workloads'], now: 1000, startedAt: 500,
    });
    expect(FindingDismissalStore.getInstance().list('readiness')).toHaveLength(1);
  });

  it('leaves a domain this request did not carry alone', () => {
    insert();
    dismissals.attachReadinessDismissals({ nodes: [nodeWith(localNodeId, {})], findings: [], domains: ['security'], now: 1000, startedAt: 500 });
    expect(FindingDismissalStore.getInstance().list('readiness')).toHaveLength(1);
  });

  it('retires a dismissal that stopped covering a finding that changed, so a revert cannot re-hide it', () => {
    insert();
    const changed = finding({ fingerprint: 'moved' });
    const first = dismissals.attachReadinessDismissals({
      nodes: [nodeWith(localNodeId, { workloads: cell({ state: 'degraded', reasonCode: 'workloads_partial' }) })],
      findings: [changed], domains: ['workloads'], now: 1000, startedAt: 500,
    });
    expect(first).toEqual([]);
    expect(FindingDismissalStore.getInstance().list('readiness')).toHaveLength(0);
    // The finding drifts back to the state that was dismissed: it stays visible.
    const second = dismissals.attachReadinessDismissals({
      nodes: [nodeWith(localNodeId, { workloads: cell({ state: 'degraded', reasonCode: 'workloads_partial' }) })],
      findings: [finding({ fingerprint: 'fp' })], domains: ['workloads'], now: 2000, startedAt: 1500,
    });
    expect(second).toEqual([]);
  });

  it('never retires a dismissal made after this evaluation began', () => {
    FindingDismissalStore.getInstance().dismiss(
      { nodeId: localNodeId, surface: 'readiness', findingKey: `workloads:${localNodeId}:web:workloads_partial`, stackName: 'web', fingerprint: 'fp', severity: 'degraded', count: 1 },
      { mode: 'until_change', expiresAt: null, createdBy: 'alice', now: 900 },
    );
    const published = dismissals.attachReadinessDismissals({
      nodes: [nodeWith(localNodeId, { workloads: cell() })], findings: [], domains: ['workloads'], now: 1000, startedAt: 800,
    });
    expect(published).toHaveLength(1);
    expect(FindingDismissalStore.getInstance().list('readiness')).toHaveLength(1);
  });

  it('drops an expired timed dismissal and one for a node that no longer exists', () => {
    insert({}, 'days', 500);
    insert({ nodeId: 9999, findingKey: 'workloads:9999:web:workloads_partial' });
    dismissals.attachReadinessDismissals({
      nodes: [nodeWith(localNodeId, { workloads: cell({ state: 'degraded', reasonCode: 'workloads_partial' }) })],
      findings: [finding()], domains: ['workloads'], now: 1000, startedAt: 500,
    });
    expect(FindingDismissalStore.getInstance().list('readiness')).toHaveLength(0);
  });
});

describe('POST /api/fleet/dismissals/readiness', () => {
  // The state the operator saw; matches the finding the mocked read returns unless a case says otherwise.
  const seen = { fingerprint: 'fp-server', count: 1 };
  const post = (body: unknown, auth = adminAuth) =>
    request(app).post('/api/fleet/dismissals/readiness').set('Authorization', auth).send({ ...seen, ...(body as object) });
  const id = () => `workloads:${localNodeId}:web:workloads_partial`;

  it('records the server-read fingerprint, severity and count, never a severity the request claims', async () => {
    build.buildFleetReadiness.mockResolvedValue(response([finding({ count: 2 })]));
    const res = await post({ findingId: id(), mode: 'until_change', count: 2, severity: 'attention' });
    expect(res.status).toBe(201);
    expect(res.body.dismissal).toMatchObject({ findingKey: id(), fingerprint: 'fp-server', severity: 'degraded', count: 2, mode: 'until_change' });
    expect(res.body.kept).toBe(false);
  });

  it('reads only the one node and domain the id names', async () => {
    build.buildFleetReadiness.mockResolvedValue(response([finding()]));
    await post({ findingId: id(), mode: 'until_change' });
    expect(build.buildFleetReadiness).toHaveBeenCalledWith(expect.objectContaining({
      domains: ['workloads'], nodeIds: [localNodeId], withDismissals: false,
    }));
  });

  it('turns days into an expiry and bounds it', async () => {
    build.buildFleetReadiness.mockResolvedValue(response([finding()]));
    const ok = await post({ findingId: id(), mode: 'days', days: 7 });
    expect(ok.status).toBe(201);
    expect(ok.body.dismissal.expiresAt).toBeGreaterThan(Date.now() + 6 * 86_400_000);
    expect((await post({ findingId: id(), mode: 'days', days: 0 })).status).toBe(400);
    expect((await post({ findingId: id(), mode: 'days', days: 1.5 })).status).toBe(400);
    expect((await post({ findingId: id(), mode: 'days', days: '7' })).status).toBe(400);
    expect((await post({ findingId: id(), mode: 'days', days: true })).status).toBe(400);
    const defaulted = await post({ findingId: id(), mode: 'days' });
    expect(defaulted.status).toBe(201);
    expect(defaulted.body.dismissal.expiresAt).toBeGreaterThan(Date.now() + 6 * 86_400_000);
    expect((await post({ findingId: id(), mode: 'days', days: 366 })).status).toBe(400);
  });

  it('does not reveal whether a node exists to a caller without permission', async () => {
    const res = await post({ findingId: 'workloads:9999:web:workloads_partial', mode: 'until_change' }, viewerAuth);
    expect(res.status).toBe(403);
  });

  it('refuses a malformed id, a bad mode, and a node that does not exist', async () => {
    expect((await post({ findingId: 'nonsense', mode: 'until_change' })).status).toBe(400);
    expect((await post({ findingId: id(), mode: 'sometimes' })).status).toBe(400);
    expect((await post({ findingId: 'workloads:9999:web:workloads_partial', mode: 'until_change' })).status).toBe(404);
  });

  it('answers 409 when the finding is no longer present', async () => {
    build.buildFleetReadiness.mockResolvedValue(response([]));
    const res = await post({ findingId: id(), mode: 'until_change' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('FINDING_GONE');
  });

  it('refuses findings Readiness may not dismiss', async () => {
    build.buildFleetReadiness.mockResolvedValue(response([finding({ id: `security:${localNodeId}:posture_action_needed`, domain: 'security', stack: null, code: 'posture_action_needed', dismissPolicy: 'none' })]));
    expect((await post({ findingId: `security:${localNodeId}:posture_action_needed`, mode: 'until_change' })).status).toBe(400);
  });

  it('allows only a timed dismissal of a finding about missing evidence', async () => {
    const key = `workloads:${localNodeId}:status_evidence_stale`;
    build.buildFleetReadiness.mockResolvedValue(response([finding({ id: key, stack: null, code: 'status_evidence_stale', severity: 'unknown', dismissPolicy: 'timed' })]));
    expect((await post({ findingId: key, mode: 'forever' })).status).toBe(400);
    expect((await post({ findingId: key, mode: 'until_change' })).status).toBe(400);
    expect((await post({ findingId: key, mode: 'days', days: 3 })).status).toBe(201);
  });

  it('refuses a caller without permission on that stack, and never reads the node for them', async () => {
    build.buildFleetReadiness.mockResolvedValue(response([finding()]));
    const res = await post({ findingId: id(), mode: 'until_change' }, viewerAuth);
    expect(res.status).toBe(403);
    expect(build.buildFleetReadiness).not.toHaveBeenCalled();
    expect(FindingDismissalStore.getInstance().list('readiness')).toHaveLength(0);
  });

  it('requires admin for a control finding', async () => {
    const res = await post({ findingId: `control:${localNodeId}:control_paused`, mode: 'until_change' }, viewerAuth);
    expect(res.status).toBe(403);
  });

  it('reports a duplicate as kept and does not create a second row', async () => {
    build.buildFleetReadiness.mockResolvedValue(response([finding()]));
    await post({ findingId: id(), mode: 'forever' });
    const again = await post({ findingId: id(), mode: 'until_change' });
    expect(again.status).toBe(200);
    expect(again.body.kept).toBe(true);
    expect(FindingDismissalStore.getInstance().list('readiness')).toHaveLength(1);
  });

  it('refuses to dismiss a finding that changed after the operator saw it', async () => {
    build.buildFleetReadiness.mockResolvedValue(response([finding({ count: 3 })]));
    const worse = await post({ findingId: id(), mode: 'until_change' });
    expect(worse.status).toBe(409);
    expect(worse.body.code).toBe('FINDING_CHANGED');
    build.buildFleetReadiness.mockResolvedValue(response([finding({ fingerprint: 'moved' })]));
    expect((await post({ findingId: id(), mode: 'until_change' })).status).toBe(409);
    expect(FindingDismissalStore.getInstance().list('readiness')).toHaveLength(0);
  });

  it('requires the state that was seen', async () => {
    const res = await request(app).post('/api/fleet/dismissals/readiness').set('Authorization', adminAuth)
      .send({ findingId: id(), mode: 'until_change' });
    expect(res.status).toBe(400);
  });

  it('requires a signed-in caller', async () => {
    expect((await request(app).post('/api/fleet/dismissals/readiness').send({ findingId: id(), mode: 'until_change' })).status).toBe(401);
  });
});

describe('DELETE /api/fleet/dismissals/:id', () => {
  const seed = () => FindingDismissalStore.getInstance().dismiss(
    { nodeId: localNodeId, surface: 'readiness', findingKey: `workloads:${localNodeId}:web:workloads_partial`, stackName: 'web', fingerprint: 'fp', severity: 'degraded', count: 1 },
    { mode: 'until_change', expiresAt: null, createdBy: 'alice', now: 1 },
  ).row;

  it('restores the finding', async () => {
    const created = seed();
    const res = await request(app).delete(`/api/fleet/dismissals/${created.id}`).set('Authorization', adminAuth);
    expect(res.status).toBe(204);
    expect(FindingDismissalStore.getInstance().get(created.id)).toBeNull();
  });

  it('refuses a caller who could not have dismissed it', async () => {
    const created = seed();
    expect((await request(app).delete(`/api/fleet/dismissals/${created.id}`).set('Authorization', viewerAuth)).status).toBe(403);
    expect(FindingDismissalStore.getInstance().get(created.id)).not.toBeNull();
  });

  it('answers 404 for an unknown id and 400 for a malformed one', async () => {
    expect((await request(app).delete('/api/fleet/dismissals/99999').set('Authorization', adminAuth)).status).toBe(404);
    expect((await request(app).delete('/api/fleet/dismissals/abc').set('Authorization', adminAuth)).status).toBe(400);
  });
});
