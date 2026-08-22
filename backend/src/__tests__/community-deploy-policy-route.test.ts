/**
 * Community deploy-policy route regressions: a matching block_on_deploy policy
 * must hard-block via the stack deploy route on Community (local session and
 * trusted node_proxy with x-sencho-tier: community), returning the established
 * 409 payload and never calling deployStack.
 */
import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import request, { type Response } from 'supertest';
import jwt from 'jsonwebtoken';
import { setupTestDb, cleanupTestDb, loginAsTestAdmin, TEST_JWT_SECRET } from './helpers/setupTestDb';
import { PROXY_TIER_HEADER } from '../services/license-headers';

vi.mock('../services/FileSystemService', () => ({
  FileSystemService: {
    getInstance: () => ({
      getStacks: vi.fn().mockResolvedValue([]),
      getBaseDir: () => '/tmp/compose',
      readComposeFile: vi.fn().mockResolvedValue(''),
      hasComposeFile: vi.fn().mockResolvedValue(true),
    }),
  },
}));

let tmpDir: string;
let app: import('express').Express;
let authCookie: string;
let listImagesSpy: ReturnType<typeof vi.spyOn>;
let deploySpy: ReturnType<typeof vi.spyOn>;
let trivyAvailableSpy: ReturnType<typeof vi.spyOn>;
let scanSpy: ReturnType<typeof vi.spyOn>;

function expectPolicyHardBlock(res: Response): void {
  expect(res.status).toBe(409);
  expect(res.body.error).toContain('community-block-critical');
  expect(res.body.policy).toMatchObject({ name: 'community-block-critical' });
  expect(res.body.violations).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ imageRef: 'nginx:bad' }),
    ]),
  );
  expect(scanSpy).toHaveBeenCalled();
  expect(deploySpy).not.toHaveBeenCalled();
}

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ app } = await import('../index'));
  authCookie = await loginAsTestAdmin(app);

  const { ComposeService } = await import('../services/ComposeService');
  listImagesSpy = vi.spyOn(ComposeService.prototype, 'listStackImages').mockResolvedValue(['nginx:bad']);
  deploySpy = vi.spyOn(ComposeService.prototype, 'deployStack').mockResolvedValue({ recoveryId: null, deployedGenerationId: null });

  const TrivyService = (await import('../services/TrivyService')).default;
  const trivy = TrivyService.getInstance();
  trivyAvailableSpy = vi.spyOn(trivy, 'isTrivyAvailable').mockReturnValue(true);
  scanSpy = vi.spyOn(trivy, 'scanImagePreflight').mockResolvedValue({
    id: 42,
    node_id: 1,
    image_ref: 'nginx:bad',
    image_digest: null,
    scanned_at: Date.now(),
    total_vulnerabilities: 1,
    critical_count: 1,
    high_count: 0,
    medium_count: 0,
    low_count: 0,
    unknown_count: 0,
    fixable_count: 0,
    secret_count: 0,
    misconfig_count: 0,
    scanners_used: 'vuln',
    highest_severity: 'CRITICAL',
    os_info: null,
    trivy_version: '0.50.0',
    scan_duration_ms: null,
    triggered_by: 'deploy-preflight',
    status: 'completed',
    error: null,
    stack_context: 'community-block-app',
    policy_evaluation: null,
  });

  const { DatabaseService } = await import('../services/DatabaseService');
  DatabaseService.getInstance().createScanPolicy({
    name: 'community-block-critical',
    node_id: null,
    node_identity: '',
    stack_pattern: 'community-block-*',
    max_severity: 'HIGH',
    block_on_deploy: 1,
    block_on_severity: 1,
    block_on_kev: 0,
    block_on_fixable: 0,
    enabled: 1,
    replicated_from_control: 0,
  });
});

afterAll(() => {
  listImagesSpy.mockRestore();
  deploySpy.mockRestore();
  trivyAvailableSpy.mockRestore();
  scanSpy.mockRestore();
  vi.restoreAllMocks();
  cleanupTestDb(tmpDir);
});

beforeEach(() => {
  deploySpy.mockClear();
  listImagesSpy.mockClear();
  scanSpy.mockClear();
});

describe('Community deploy policy hard-block (route)', () => {
  it('returns 409 and skips deployStack for a local Community session', async () => {
    const res = await request(app)
      .post('/api/stacks/community-block-app/deploy')
      .set('Cookie', authCookie);

    expectPolicyHardBlock(res);
  });

  it('returns 409 and skips deployStack for trusted node_proxy Community tier', async () => {
    const token = jwt.sign({ scope: 'node_proxy' }, TEST_JWT_SECRET, { expiresIn: '1m' });

    const res = await request(app)
      .post('/api/stacks/community-block-proxy/deploy')
      .set('Authorization', `Bearer ${token}`)
      .set(PROXY_TIER_HEADER, 'community');

    expectPolicyHardBlock(res);
  });
});
