/**
 * The deploy guard (on by default): blocks a deploy/update when required env vars are
 * missing, only when the setting is on. Compose's own stderr is the authoritative
 * signal (so an empty `REQ=` with `${REQ:?err}` is caught, which a key-only check
 * could not), and the guard runs before any backup/cleanup/pull/up side effect.
 *
 * The GitOps decrypt overlay is the other input, and it has the opposite
 * confidentiality regime: its env files are plaintext secrets, so Compose's
 * diagnostic for it is withheld rather than parsed. A `:?` message is itself
 * interpolated, so the diagnostic can carry a decrypted value, and those tests
 * run the real Compose binary to keep that behavior pinned.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';
import { ComposeService } from '../services/ComposeService';
import { gitSecretsAreaBase } from '../services/gitops/managedPaths';
import { WITHHELD_DECRYPTED_REQUIRED_ENV_OUTPUT } from '../helpers/decryptedComposeOutput';

let tmpDir: string;
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;
let nodeId: number;

// The stderr `docker compose config` emits for an unset OR empty `${REQ:?err}`.
const REQUIRED_MISSING_STDERR = 'required variable REQ is missing a value: must be provided';

function setBlocking(on: boolean): void {
  vi.spyOn(DatabaseService.getInstance(), 'getGlobalSettings')
    .mockReturnValue({ env_block_deploy_on_missing_required: on ? '1' : '0' } as Record<string, string>);
}

function stubStderr(stderr: string, rendered: string | null = null) {
  const compose = ComposeService.getInstance(nodeId);
  const spy = vi.spyOn(compose, 'renderConfig').mockResolvedValue({ rendered, stderr, code: rendered === null ? 1 : 0, timedOut: false });
  return { compose, spy };
}

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ DatabaseService } = await import('../services/DatabaseService'));
  nodeId = (DatabaseService.getInstance().getDb().prepare('SELECT id FROM nodes WHERE is_default = 1').get() as { id: number }).id;
});

afterAll(() => cleanupTestDb(tmpDir));
afterEach(() => vi.restoreAllMocks());

describe('assertRequiredEnvPresent', () => {
  it('does not render when the setting is off', async () => {
    setBlocking(false);
    const { compose, spy } = stubStderr(REQUIRED_MISSING_STDERR);
    await (compose as unknown as { assertRequiredEnvPresent(s: string): Promise<void> }).assertRequiredEnvPresent('s');
    expect(spy).not.toHaveBeenCalled();
  });

  it('blocks when a required variable is unset or empty', async () => {
    setBlocking(true);
    const { compose } = stubStderr(REQUIRED_MISSING_STDERR);
    await expect((compose as unknown as { assertRequiredEnvPresent(s: string): Promise<void> }).assertRequiredEnvPresent('s'))
      .rejects.toThrow(/REQ/);
  });

  it('names every missing variable with plural grammar', async () => {
    setBlocking(true);
    const { compose } = stubStderr('required variable A is missing a value\nrequired variable B is missing a value');
    await expect((compose as unknown as { assertRequiredEnvPresent(s: string): Promise<void> }).assertRequiredEnvPresent('s'))
      .rejects.toThrow(/variables A, B are missing/);
  });

  it('allows when all required variables are present', async () => {
    setBlocking(true);
    const { compose } = stubStderr('', '{"services":{}}');
    await expect((compose as unknown as { assertRequiredEnvPresent(s: string): Promise<void> }).assertRequiredEnvPresent('s'))
      .resolves.toBeUndefined();
  });

  it('does not block on a render failure unrelated to required vars', async () => {
    setBlocking(true);
    const { compose } = stubStderr('yaml: line 2: mapping values are not allowed');
    await expect((compose as unknown as { assertRequiredEnvPresent(s: string): Promise<void> }).assertRequiredEnvPresent('s'))
      .resolves.toBeUndefined();
  });

  it('falls through without blocking when the settings read fails', async () => {
    vi.spyOn(DatabaseService.getInstance(), 'getGlobalSettings').mockImplementation(() => { throw new Error('db down'); });
    const { compose, spy } = stubStderr(REQUIRED_MISSING_STDERR);
    await expect((compose as unknown as { assertRequiredEnvPresent(s: string): Promise<void> }).assertRequiredEnvPresent('s'))
      .resolves.toBeUndefined();
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('deployStack/updateStack guard ordering', () => {
  it('deployStack throws before taking an atomic backup when a required var is missing', async () => {
    setBlocking(true);
    const compose = ComposeService.getInstance(nodeId);
    vi.spyOn(compose, 'renderConfig').mockResolvedValue({ rendered: null, stderr: REQUIRED_MISSING_STDERR, code: 1, timedOut: false });
    const backup = vi.spyOn(compose as unknown as { createAtomicBackup(...a: unknown[]): Promise<void> }, 'createAtomicBackup').mockResolvedValue(undefined);
    await expect(compose.deployStack('s', undefined, true)).rejects.toThrow(/REQ/);
    expect(backup).not.toHaveBeenCalled();
  });

  it('updateStack throws before taking an atomic backup when a required var is missing', async () => {
    setBlocking(true);
    const compose = ComposeService.getInstance(nodeId);
    vi.spyOn(compose, 'renderConfig').mockResolvedValue({ rendered: null, stderr: REQUIRED_MISSING_STDERR, code: 1, timedOut: false });
    const backup = vi.spyOn(compose as unknown as { createAtomicBackup(...a: unknown[]): Promise<void> }, 'createAtomicBackup').mockResolvedValue(undefined);
    await expect(compose.updateStack('s', undefined, true)).rejects.toThrow(/REQ/);
    expect(backup).not.toHaveBeenCalled();
  });
});

describe('assertRequiredEnvPresent over a GitOps decrypt overlay', () => {
  // The value Compose must never be asked to hand back. A `:?` message is itself
  // interpolated, so `${SECRET}` resolves into the very text Compose reports and
  // lands on the phrase the name-only parser keys on.
  const SENTINEL = 'audit_guard_secret_word';
  const NESTED_COMPOSE = [
    'services:',
    '  app:',
    '    image: alpine:3',
    '    environment:',
    '      - "FAIL=${MISSING:?required variable ${SECRET} is missing}"',
    '',
  ].join('\n');

  /**
   * A real decrypt-overlay directory: a stack area under the git-secrets root,
   * with the plaintext project Compose would actually read there.
   */
  function writeOverlay(stackName: string, compose: string, env: string): string {
    const dir = path.join(gitSecretsAreaBase(), String(nodeId), stackName, 'op-1');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'compose.yaml'), compose);
    fs.writeFileSync(path.join(dir, '.env'), env);
    return dir;
  }

  function guard(compose: ComposeService, stackName: string, stackDirOverride?: string): Promise<void> {
    return (compose as unknown as {
      assertRequiredEnvPresent: (s: string, d?: string) => Promise<void>;
    }).assertRequiredEnvPresent(stackName, stackDirOverride);
  }

  it('publishes the withheld refusal, not the interpolated value, for a nested :? message', async () => {
    setBlocking(true);
    const overlayDir = writeOverlay('guard-overlay-nested', NESTED_COMPOSE, `SECRET=${SENTINEL}\n`);

    // Control: the real binary really does print the resolved value. Without
    // this, a green assertion below could just mean Compose failed differently.
    let composeStderr = '';
    try {
      execFileSync('docker', ['compose', 'config', '--quiet'], {
        cwd: overlayDir,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 20_000,
      });
    } catch (err) {
      composeStderr = String((err as { stderr?: Buffer }).stderr ?? '');
    }
    expect(composeStderr).toContain(SENTINEL);

    const error = await guard(ComposeService.getInstance(nodeId), 'guard-overlay-nested', overlayDir)
      .then(() => null, (e: Error) => e);

    // The refusal still blocks, with Sencho's own wording and the deploy remedy.
    expect(error?.message).toBe(
      `Deploy blocked: ${WITHHELD_DECRYPTED_REQUIRED_ENV_OUTPUT}then deploy again.`,
    );
    expect(error?.message).not.toContain(SENTINEL);
    expect(error?.message).not.toContain('MISSING');
  });

  it('allows an overlay render that resolved', async () => {
    setBlocking(true);
    const overlayDir = writeOverlay(
      'guard-overlay-ok',
      'services:\n  app:\n    image: alpine:3\n',
      `SECRET=${SENTINEL}\n`,
    );
    await expect(guard(ComposeService.getInstance(nodeId), 'guard-overlay-ok', overlayDir))
      .resolves.toBeUndefined();
  });

  it('leaves the live project naming the variables it is missing', async () => {
    // The control for the two tests above: without an overlay the guard still
    // reads Compose's diagnostic, because that project is not a secret store.
    setBlocking(true);
    const { compose } = stubStderr(REQUIRED_MISSING_STDERR);
    await expect(guard(compose, 's')).rejects.toThrow(
      'Deploy blocked: required environment variable REQ is missing. Define it in a .env or env_file, then deploy again.',
    );
  });
});
