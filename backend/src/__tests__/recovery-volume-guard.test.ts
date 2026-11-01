/**
 * The recovery repository volume must survive every stack-level removal of
 * volumes. The Compose-level refusal is in compose-service.test.ts and the route
 * answers in stack-down-remove-volumes.test.ts; this file covers the name rules
 * and the DELETE route end to end.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import request from 'supertest';
import { setupTestDb, cleanupTestDb, loginAsTestAdmin } from './helpers/setupTestDb';
import {
  recoveryVolumeNamesIn,
  RecoveryVolumeProtectedError,
  isRecoveryVolumeProtectedError,
  sendIfRecoveryVolumeProtected,
} from '../helpers/recoveryVolumeGuard';

describe('recoveryVolumeNamesIn', () => {
  const none = () => false;

  it('matches every generation under the reserved prefix, kept ones included', () => {
    expect(recoveryVolumeNamesIn([
      'sencho-recovery-b90046dbc292-f10bb14901f3-g3',
      'sencho-recovery-b90046dbc292-f10bb14901f3-g4',
      'app_data',
    ], none)).toEqual([
      'sencho-recovery-b90046dbc292-f10bb14901f3-g3',
      'sencho-recovery-b90046dbc292-f10bb14901f3-g4',
    ]);
  });

  it('matches a registered locator whatever its name', () => {
    expect(recoveryVolumeNamesIn(['legacy-repo', 'app_data'], (name) => name === 'legacy-repo')).toEqual(['legacy-repo']);
  });

  it('does not match a volume that merely contains the prefix, or a project-prefixed name', () => {
    expect(recoveryVolumeNamesIn(['my-sencho-recovery-data', 'sencho-recovery', 'sencho_data'], none)).toEqual([]);
  });

  it('lists a repeated name once', () => {
    expect(recoveryVolumeNamesIn(['sencho-recovery-x-g1', 'sencho-recovery-x-g1'], none)).toEqual(['sencho-recovery-x-g1']);
  });
});

describe('sendIfRecoveryVolumeProtected', () => {
  it('answers 423 for a refusal and leaves any other error to the caller', () => {
    const json = vi.fn();
    const res = { headersSent: false, status: vi.fn(() => ({ json })) } as unknown as import('express').Response;

    expect(sendIfRecoveryVolumeProtected(res, new Error('boom'))).toBe(false);
    expect(res.status).not.toHaveBeenCalled();

    const refusal = new RecoveryVolumeProtectedError('refused');
    expect(isRecoveryVolumeProtectedError(refusal)).toBe(true);
    expect(sendIfRecoveryVolumeProtected(res, refusal)).toBe(true);
    expect(res.status).toHaveBeenCalledWith(423);
    expect(json).toHaveBeenCalledWith({ error: 'refused', code: 'recovery_volume_protected' });
  });
});

describe('DELETE /api/stacks/:name?pruneVolumes=true', () => {
  const REPOSITORY_VOLUME = 'sencho-recovery-b90046dbc292-f10bb14901f3-g4';
  let tmpDir: string;
  let app: import('express').Express;
  let cookie: string;
  let ComposeService: typeof import('../services/ComposeService').ComposeService;
  let dockerSpawn: ReturnType<typeof vi.fn>;

  function writeStack(name: string): string {
    const dir = path.join(process.env.COMPOSE_DIR!, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'compose.yaml'), 'services:\n  web:\n    image: alpine:3.20\n');
    return dir;
  }

  beforeAll(async () => {
    tmpDir = await setupTestDb();
    ({ ComposeService } = await import('../services/ComposeService'));
    ({ app } = await import('../index'));
    cookie = await loginAsTestAdmin(app);
  });

  afterAll(async () => {
    await cleanupTestDb(tmpDir);
  });

  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    // The endpoint guard is not what is under test; the Compose run is observed instead.
    vi.spyOn(ComposeService.prototype, 'evaluateDockerEndpoint').mockResolvedValue(null);
    dockerSpawn = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(ComposeService.prototype as unknown as { execute: () => Promise<void> }, 'execute')
      .mockImplementation(dockerSpawn as unknown as () => Promise<void>);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function render(volumeNames: string[]) {
    vi.spyOn(ComposeService.prototype, 'renderConfig').mockResolvedValue({
      rendered: JSON.stringify({
        name: 'repomount',
        services: { web: { image: 'alpine:3.20' } },
        volumes: Object.fromEntries(volumeNames.map((name, i) => [`v${i}`, { name }])),
      }),
      stderr: '',
      code: 0,
      timedOut: false,
    });
  }

  it('refuses with 423 and removes neither the stack nor its volumes when it declares the repository volume', async () => {
    const dir = writeStack('repomount');
    render([REPOSITORY_VOLUME]);

    const res = await request(app).delete('/api/stacks/repomount?pruneVolumes=true').set('Cookie', cookie);

    expect(res.status).toBe(423);
    expect(res.body.code).toBe('recovery_volume_protected');
    expect(dockerSpawn).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(dir, 'compose.yaml'))).toBe(true);
  });

  it('deletes the same stack when volumes are not pruned', async () => {
    const dir = writeStack('repomount-noprune');
    render([REPOSITORY_VOLUME]);

    const res = await request(app).delete('/api/stacks/repomount-noprune').set('Cookie', cookie);

    expect(res.status).toBe(200);
    const args = dockerSpawn.mock.calls.map((call) => call[1] as string[]);
    expect(args.some((a) => a.includes('--volumes'))).toBe(false);
    expect(fs.existsSync(dir)).toBe(false);
  });

  it('deletes a stack whose compose file Compose rejects, so it is not stranded by the check', async () => {
    const dir = writeStack('unrenderable');
    vi.spyOn(ComposeService.prototype, 'renderConfig').mockResolvedValue({
      rendered: null, stderr: 'invalid compose file', code: 15, timedOut: false,
    });

    const res = await request(app).delete('/api/stacks/unrenderable?pruneVolumes=true').set('Cookie', cookie);

    expect(res.status).toBe(200);
    expect(fs.existsSync(dir)).toBe(false);
  });

  it('refuses the delete when the check of the stack\'s volumes did not finish', async () => {
    const dir = writeStack('unfinished');
    vi.spyOn(ComposeService.prototype, 'renderConfig').mockResolvedValue({
      rendered: null, stderr: 'timed out', code: null, timedOut: true,
    });

    const res = await request(app).delete('/api/stacks/unfinished?pruneVolumes=true').set('Cookie', cookie);

    expect(res.status).toBe(423);
    expect(res.body.code).toBe('recovery_volume_protected');
    expect(dockerSpawn).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(dir, 'compose.yaml'))).toBe(true);
  });

  it('still prunes the volumes of an ordinary stack', async () => {
    const dir = writeStack('ordinary');
    render(['ordinary_data']);

    const res = await request(app).delete('/api/stacks/ordinary?pruneVolumes=true').set('Cookie', cookie);

    expect(res.status).toBe(200);
    const args = dockerSpawn.mock.calls.map((call) => call[1] as string[]);
    expect(args.some((a) => a.includes('--volumes'))).toBe(true);
    expect(fs.existsSync(dir)).toBe(false);
  });
});
