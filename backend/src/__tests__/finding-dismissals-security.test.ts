/**
 * Security posture dismissals: the reason key and fingerprint, the per-reason
 * policy, and the routes that write and read them.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import { setupTestDb, cleanupTestDb, TEST_USERNAME, TEST_JWT_SECRET } from './helpers/setupTestDb';
import {
  POSTURE_REASON_KEYS,
  parseSecurityKey,
  postureDismissPolicy,
  postureFingerprint,
  postureKeySeverity,
  postureReasonKey,
  securityDismissalKey,
} from '../services/securityPostureDismissals';
import { derivePostureReasons, type SecurityPostureFacts } from '../services/securityPosture';

let tmpDir: string;
let app: import('express').Express;
let adminAuth: string;
let viewerAuth: string;
let deployerAuth: string;
let localNodeId: number;
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;
let FindingDismissalStore: typeof import('../services/findingDismissals/FindingDismissalStore').FindingDismissalStore;

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ app } = await import('../index'));
  ({ DatabaseService } = await import('../services/DatabaseService'));
  ({ FindingDismissalStore } = await import('../services/findingDismissals/FindingDismissalStore'));

  adminAuth = `Bearer ${jwt.sign({ username: TEST_USERNAME }, TEST_JWT_SECRET, { expiresIn: '5m' })}`;
  const db = DatabaseService.getInstance();
  localNodeId = db.getNodes().find((node) => node.type === 'local')!.id;

  const sign = (username: string, role: string, tv: number) =>
    `Bearer ${jwt.sign({ username, role, tv }, TEST_JWT_SECRET, { expiresIn: '5m' })}`;
  db.addUser({ username: 'sec-viewer', password_hash: await bcrypt.hash('password123', 1), role: 'viewer' });
  viewerAuth = sign('sec-viewer', 'viewer', db.getUserByUsername('sec-viewer')!.token_version);

  db.addUser({ username: 'sec-deployer', password_hash: await bcrypt.hash('password123', 1), role: 'viewer' });
  const deployer = db.getUserByUsername('sec-deployer')!;
  db.addRoleAssignment({ user_id: deployer.id, role: 'deployer', resource_type: 'stack', resource_id: 'web', node_id: localNodeId });
  deployerAuth = sign('sec-deployer', 'viewer', deployer.token_version);
});

afterAll(() => {
  cleanupTestDb(tmpDir);
});

beforeEach(() => {
  DatabaseService.getInstance().getDb().prepare('DELETE FROM finding_dismissals').run();
});

const keyFor = (reasonKey: string, nodeId = localNodeId) => `security:${nodeId}:${reasonKey}`;

const baseFacts = (overrides: Partial<SecurityPostureFacts> = {}): SecurityPostureFacts => ({
  scannerAvailable: true, hasCompletedScan: true, fixableCriticalHigh: 0, fixableWithImageUpdate: 0,
  fixableWaitingUpstream: 0, fixableUpdateUnknown: 0, updateChecksDisabled: false, secrets: 0,
  dangerousCompose: 0, knownExploited: 0, publiclyExposed: 0, exposureIntentConflict: 0,
  exposedUnclassified: 0, elevatedExploitRisk: 0, rawCritical: 0, rawHigh: 0, residualCriticalHigh: 0,
  staleScans: 0, failedScans: 0, needsReview: 0, ...overrides,
});

describe('security reason key', () => {
  it('round trips node and reason', () => {
    expect(parseSecurityKey(securityDismissalKey(3, 'needs_review:all'))).toEqual({ nodeId: 3, reasonKey: 'needs_review:all' });
    expect(parseSecurityKey(securityDismissalKey(3, 'public_exposure:unclassified'))?.reasonKey).toBe('public_exposure:unclassified');
  });

  it('separates the two public_exposure reasons by severity', () => {
    expect(postureReasonKey('public_exposure', 'blocker')).toBe('public_exposure:conflict');
    expect(postureReasonKey('public_exposure', 'review')).toBe('public_exposure:unclassified');
  });

  it.each([
    '', 'networking:1:needs_review:all', 'security:0:needs_review:all', 'security:x:needs_review:all',
    'security:1:bogus:all', 'security:1:needs_review', 'security:1:needs_review:all:extra', `security:1:${'a'.repeat(200)}:all`,
  ])('refuses %j', (key) => {
    expect(parseSecurityKey(key)).toBeNull();
  });
});

describe('security policy', () => {
  it('never lets a blocker be dismissed, and the severity a key carries matches its policy', () => {
    for (const key of POSTURE_REASON_KEYS) {
      if (postureKeySeverity(key) === 'blocker') expect(postureDismissPolicy(key)).toBe('none');
      else expect(['any', 'timed']).toContain(postureDismissPolicy(key));
    }
  });

  it('allows only a timed dismissal of missing or old evidence', () => {
    expect(postureDismissPolicy('update_check_uncertain:all')).toBe('timed');
    expect(postureDismissPolicy('stale_scan:all')).toBe('timed');
    expect(postureDismissPolicy('needs_review:all')).toBe('any');
  });
});

describe('posture fingerprint', () => {
  const t = (imageRef: string, stackName?: string) => ({ imageRef, stackName });

  it('ignores order and moves when a target changes', () => {
    const a = postureFingerprint({ severity: 'review', targets: [t('a'), t('b')] });
    expect(postureFingerprint({ severity: 'review', targets: [t('b'), t('a')] })).toBe(a);
    expect(postureFingerprint({ severity: 'review', targets: [t('a'), t('c')] })).not.toBe(a);
    expect(postureFingerprint({ severity: 'review', targets: [t('a', 'web'), t('b')] })).not.toBe(a);
    expect(postureFingerprint({ severity: 'info', targets: [t('a'), t('b')] })).not.toBe(a);
  });

  it('moves when the target list was capped', () => {
    expect(postureFingerprint({ severity: 'review', targets: [t('a')], targetsTruncated: true }))
      .not.toBe(postureFingerprint({ severity: 'review', targets: [t('a')] }));
  });

  it('is carried on derived reasons and survives a message-only change', () => {
    const [reason] = derivePostureReasons(baseFacts({ needsReview: 2 })).reasons;
    expect(reason).toMatchObject({ key: 'needs_review:all', dismissPolicy: 'any' });
    expect(reason.fingerprint).toBe(postureFingerprint({ severity: 'review' }));
    expect(derivePostureReasons(baseFacts({ needsReview: 9 })).reasons[0].fingerprint).toBe(reason.fingerprint);
  });

  it('marks blockers as not dismissable on the reason itself', () => {
    const { reasons } = derivePostureReasons(baseFacts({ secrets: 1, exposureIntentConflict: 1, exposedUnclassified: 1 }));
    const byKey = Object.fromEntries(reasons.map((r) => [r.key, r.dismissPolicy]));
    expect(byKey).toEqual({
      'secret:all': 'none', 'public_exposure:conflict': 'none', 'public_exposure:unclassified': 'any',
    });
  });

  it('prefers per stack and service rows for a confirmed update', () => {
    const { reasons } = derivePostureReasons(baseFacts({
      fixableWithImageUpdate: 1,
      fixableWithImageUpdateTargets: ['nginx:1'],
      fixableWithImageUpdateServiceTargets: [{ imageRef: 'nginx:1', stackName: 'web', serviceName: 'app' }],
    }));
    expect(reasons[0].targets).toEqual([{ imageRef: 'nginx:1', stackName: 'web', serviceName: 'app' }]);
  });

  it('falls back to image-only rows when no service rows are known', () => {
    const { reasons } = derivePostureReasons(baseFacts({ fixableWithImageUpdate: 1, fixableWithImageUpdateTargets: ['nginx:1'] }));
    expect(reasons[0].targets).toEqual([{ imageRef: 'nginx:1' }]);
  });
});

describe('POST /api/fleet/dismissals/security', () => {
  const seen = { fingerprint: 'fp-1', count: 2, severity: 'review' };
  const post = (body: unknown, auth = adminAuth) =>
    request(app).post('/api/fleet/dismissals/security').set('Authorization', auth).send({ ...seen, ...(body as object) });

  it('stores the dismissal under the key, with no stack', async () => {
    const findingId = keyFor('needs_review:all');
    const res = await post({ findingId, mode: 'until_change' });
    expect(res.status).toBe(201);
    expect(res.body.dismissal).toMatchObject({
      nodeId: localNodeId, surface: 'security', findingKey: findingId, fingerprint: 'fp-1', severity: 'review', count: 2, mode: 'until_change',
    });
    expect(FindingDismissalStore.getInstance().list('security')[0].stack_name).toBeNull();
  });

  it('refuses a blocker', async () => {
    for (const key of ['fixable_cve:all', 'secret:all', 'dangerous_compose:all', 'public_exposure:conflict']) {
      expect((await post({ findingId: keyFor(key), mode: 'until_change', severity: 'blocker' })).status).toBe(400);
    }
    expect(FindingDismissalStore.getInstance().list('security')).toHaveLength(0);
  });

  it('refuses a severity that does not match the key', async () => {
    expect((await post({ findingId: keyFor('needs_review:all'), mode: 'until_change', severity: 'info' })).status).toBe(400);
    expect((await post({ findingId: keyFor('needs_review:all'), mode: 'until_change', severity: 'blocker' })).status).toBe(400);
  });

  it('refuses a malformed key, an unreadable state, and an over-long key', async () => {
    const findingId = keyFor('needs_review:all');
    expect((await post({ findingId: 'security:1:nope', mode: 'until_change' })).status).toBe(400);
    expect((await post({ findingId: `security:1:${'a'.repeat(300)}:all`, mode: 'until_change' })).status).toBe(400);
    expect((await post({ findingId, mode: 'until_change', fingerprint: '' })).status).toBe(400);
    expect((await post({ findingId, mode: 'until_change', count: 0 })).status).toBe(400);
    expect((await post({ findingId, mode: 'sometimes' })).status).toBe(400);
  });

  it('allows only a timed dismissal of missing or old evidence', async () => {
    const findingId = keyFor('update_check_uncertain:all');
    expect((await post({ findingId, mode: 'until_change' })).status).toBe(400);
    expect((await post({ findingId, mode: 'forever' })).status).toBe(400);
    expect((await post({ findingId, mode: 'days', days: 7 })).status).toBe(201);
  });

  it('keeps every reason behind node management', async () => {
    const findingId = keyFor('needs_review:all');
    expect((await post({ findingId, mode: 'until_change' }, deployerAuth)).status).toBe(403);
    expect((await post({ findingId, mode: 'until_change' }, viewerAuth)).status).toBe(403);
    expect(FindingDismissalStore.getInstance().list('security')).toHaveLength(0);
  });

  it('refuses a node that does not exist', async () => {
    expect((await post({ findingId: keyFor('needs_review:all', 9999), mode: 'until_change' })).status).toBe(404);
  });

  it('never weakens a stronger row', async () => {
    const findingId = keyFor('needs_review:all');
    await post({ findingId, mode: 'forever' });
    const again = await post({ findingId, mode: 'until_change' });
    expect(again.status).toBe(200);
    expect(again.body.kept).toBe(true);
    expect(FindingDismissalStore.getInstance().list('security')).toHaveLength(1);
  });

  it('does not accept a networking key', async () => {
    expect((await post({ findingId: `networking:${localNodeId}:shared-network|||x|`, mode: 'until_change' })).status).toBe(400);
  });
});

describe('GET /api/fleet/dismissals/security', () => {
  const seed = (findingKey: string, mode: 'until_change' | 'days' = 'until_change', expiresAt: number | null = null) =>
    FindingDismissalStore.getInstance().dismiss(
      { nodeId: localNodeId, surface: 'security', findingKey, stackName: null, fingerprint: 'fp', severity: 'review', count: 1 },
      { mode, expiresAt, createdBy: 'alice', now: 1 },
    ).row;

  it('lists the node dismissals and drops a timed one whose time is up', async () => {
    const live = keyFor('needs_review:all');
    seed(live);
    seed(keyFor('stale_scan:all'), 'days', 5);
    const res = await request(app).get(`/api/fleet/dismissals/security?nodeId=${localNodeId}`).set('Authorization', viewerAuth);
    expect(res.status).toBe(200);
    expect(res.body.dismissals.map((d: { findingKey: string }) => d.findingKey)).toEqual([live]);
    expect(FindingDismissalStore.getInstance().list('security')).toHaveLength(1);
  });

  it('refuses a bad node id', async () => {
    expect((await request(app).get('/api/fleet/dismissals/security').set('Authorization', adminAuth)).status).toBe(400);
  });
});

describe('DELETE /api/fleet/dismissals/:id for a security row', () => {
  const seed = () => FindingDismissalStore.getInstance().dismiss(
    { nodeId: localNodeId, surface: 'security', findingKey: keyFor('needs_review:all'), stackName: null, fingerprint: 'fp', severity: 'review', count: 1 },
    { mode: 'until_change', expiresAt: null, createdBy: 'alice', now: 1 },
  ).row;

  it('restores it for someone who manages the node', async () => {
    const row = seed();
    expect((await request(app).delete(`/api/fleet/dismissals/${row.id}`).set('Authorization', adminAuth)).status).toBe(204);
    expect(FindingDismissalStore.getInstance().get(row.id)).toBeNull();
  });

  it('refuses someone who could not have dismissed it', async () => {
    const row = seed();
    expect((await request(app).delete(`/api/fleet/dismissals/${row.id}`).set('Authorization', deployerAuth)).status).toBe(403);
    expect(FindingDismissalStore.getInstance().get(row.id)).not.toBeNull();
  });
});
