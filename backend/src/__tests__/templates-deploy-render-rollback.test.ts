/**
 * Rollback contract for a template deploy refused by the external-network gate.
 *
 * The gate's diagnosis quotes Docker Compose's own stderr, and Compose's stderr
 * for a malformed compose file contains wording that the generic error rules
 * also match (a YAML complaint, a missing-variable complaint). Those rules carry
 * `canSilentlyRollback: false` because a container may already be running when
 * they fire. A pre-flight refusal is not that case: nothing was ever started,
 * so it must always roll back, and its own message must reach the operator
 * rather than being replaced by a rule's paraphrase.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import { setupTestDb, cleanupTestDb, TEST_JWT_SECRET } from './helpers/setupTestDb';

const mockResolveMissingExternalNetworks = vi.fn();

vi.mock('../services/network/resolveMissingExternalNetworks', () => ({
  resolveMissingExternalNetworks: (...args: unknown[]) => mockResolveMissingExternalNetworks(...args),
}));

let tmpDir: string;
let app: import('express').Express;
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;
let adminToken: string;
let ComposeService: typeof import('../services/ComposeService').ComposeService;

/** A render failure whose quoted stderr carries YAML wording the rules match. */
const YAML_WORDED_RENDER_ERROR =
  'Sencho could not render the effective Compose model: yaml: line 4: mapping values are not allowed here '
  + 'Check the compose and env files for a YAML syntax error, an unresolved include or merge, or a required variable with no value.';

const minimalTemplate = {
  title: 'rollback-probe',
  description: 'placeholder',
  image: 'nginx:alpine',
};

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ DatabaseService } = await import('../services/DatabaseService'));
  ({ ComposeService } = await import('../services/ComposeService'));

  const { LicenseService } = await import('../services/LicenseService');
  vi.spyOn(LicenseService.getInstance(), 'getTier').mockReturnValue('paid');

  const passwordHash = await bcrypt.hash('password123', 1);
  const id = DatabaseService.getInstance().addUser({
    username: 'rollback-admin',
    password_hash: passwordHash,
    role: 'admin',
  });
  const user = DatabaseService.getInstance().getUserById(id)!;
  adminToken = jwt.sign(
    { username: user.username, role: 'admin', tv: user.token_version },
    TEST_JWT_SECRET,
    { expiresIn: '5m' },
  );

  ({ app } = await import('../index'));
});

afterAll(() => {
  vi.restoreAllMocks();
  cleanupTestDb(tmpDir);
});

describe('POST /api/templates/deploy refused by the external-network gate', () => {
  it('rolls back and reports the real cause even when the quoted stderr matches an error rule', async () => {
    // Rollback stage 1 would shell out to docker; nothing was ever started, so
    // there is nothing to bring down.
    const downStack = vi.spyOn(ComposeService.prototype, 'downStack').mockResolvedValue(undefined);
    mockResolveMissingExternalNetworks.mockResolvedValue({
      status: 'render_unavailable',
      autoCreateEnabled: false,
      stackName: 'yaml-worded',
      networks: [],
      declaredExternalCount: 0,
      renderError: YAML_WORDED_RENDER_ERROR,
    });

    const res = await request(app)
      .post('/api/templates/deploy')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ stackName: 'yaml-worded', template: minimalTemplate });

    expect(res.status).toBe(500);
    // The generic YAML_SYNTAX rule would have suppressed the rollback and left
    // the broken compose.yaml on disk, making a retry fail on a name conflict.
    expect(res.body.rolledBack).toBe(true);
    expect(downStack).toHaveBeenCalledWith('yaml-worded', { removeVolumes: true });
    // The operator gets the diagnosis, not "Syntax error in compose.yaml".
    expect(res.body.error).toBe(YAML_WORDED_RENDER_ERROR);
    expect(res.body.error).toContain('mapping values are not allowed here');
    expect(res.body.ruleId).toBe('missing_external_networks');
  });

  it('leaves nothing on disk, so the same name can be retried', async () => {
    vi.spyOn(ComposeService.prototype, 'downStack').mockResolvedValue(undefined);
    mockResolveMissingExternalNetworks.mockResolvedValue({
      status: 'render_unavailable',
      autoCreateEnabled: false,
      stackName: 'retryable',
      networks: [],
      declaredExternalCount: 0,
      renderError: YAML_WORDED_RENDER_ERROR,
    });

    await request(app)
      .post('/api/templates/deploy')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ stackName: 'retryable', template: minimalTemplate });

    const { FileSystemService } = await import('../services/FileSystemService');
    const stacks = await FileSystemService.getInstance().getStacks();
    expect(stacks).not.toContain('retryable');
  });
});
