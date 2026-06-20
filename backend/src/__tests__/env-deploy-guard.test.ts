/**
 * The opt-in deploy guard: blocks a deploy/update when required env vars are
 * missing, only when the setting is on. Compose's own stderr is the authoritative
 * signal (so an empty `REQ=` with `${REQ:?err}` is caught, which a key-only check
 * could not), and the guard runs before any backup/cleanup/pull/up side effect.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';
import { ComposeService } from '../services/ComposeService';

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
