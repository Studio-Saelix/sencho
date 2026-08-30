/**
 * Regression coverage for the no-repin invariant on a floating-tag self-update.
 *
 * The Fleet dev-build update reaches SelfUpdateService WITH a targetVersion
 * even though the frontend omits one: the route substitutes the stable compare
 * target (resolveUpdateTarget in routes/fleet.ts) and forwards it through
 * ImageOperationService. So the guard that actually protects a :dev install is
 * not the absence of a target, it is the `pinKind === 'semver'` test inside the
 * repin branch. The worst-case failure is silently rewriting the compose file
 * from :dev to a stable tag, which would move the install off the dev channel.
 *
 * These exercise the real SelfUpdateService decision rather than a mock
 * standing in for it, and pair the floating cases with a semver case so the
 * negative assertions cannot pass vacuously.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockExecFile, mockExecFileAsync, mockWriteFileSync } = vi.hoisted(() => ({
  mockExecFile: vi.fn(),
  mockExecFileAsync: vi.fn(),
  mockWriteFileSync: vi.fn(),
}));

vi.mock('child_process', () => ({
  exec: vi.fn(),
  execFile: mockExecFile,
}));
vi.mock('util', () => ({
  promisify: () => mockExecFileAsync,
}));
vi.mock('../services/DatabaseService', () => ({
  DatabaseService: { getInstance: () => ({ getGlobalSettings: () => ({}) }) },
}));
// SelfUpdateService imports `fs` as a namespace; spying on the real ESM
// namespace object throws ("Module namespace is not configurable"), so the
// write path is swapped for a mock while every other fs function stays real.
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return { ...actual, writeFileSync: mockWriteFileSync };
});

const DEV_IMAGE_REF = 'ghcr.io/studio-saelix/sencho-dev:dev';
const SEMVER_IMAGE_REF = 'saelix/sencho:0.93.3';
const WORKING_DIR = '/opt/sencho';
const COMPOSE_FILE = '/opt/sencho/docker-compose.yml';
// The stable release the Fleet route resolves and forwards when the caller
// (a dev-image update) supplies no target of its own.
const RESOLVED_TARGET = '0.99.0';

// Mirrors SelfUpdateService's private ComposeContext shape (not exported), so
// the test-only field poke below stays structurally checked against drift.
type TestComposeContext = {
  workingDir: string;
  configFiles: string;
  serviceName: string;
  imageName: string;
  dataDirHost: string | null;
  hostBindMounts: Array<{ source: string; destination: string }>;
};

/** The argv SelfUpdateService hands the helper container, or null if unspawned. */
function helperArgs(): string[] | null {
  const call = mockExecFile.mock.calls[0] as [string, string[]] | undefined;
  return call ? call[1] : null;
}

describe('SelfUpdateService.triggerUpdate (no-repin invariant)', () => {
  let SelfUpdateService: typeof import('../services/SelfUpdateService').default;

  /** Point the service at a compose project declaring `composeImageRef`. */
  async function setupWithComposeImage(composeImageRef: string): Promise<void> {
    vi.clearAllMocks();
    // `docker pull` yields nothing; the throwaway `cat` container returns the
    // compose file, which is what the fresh pin resolution actually parses.
    mockExecFileAsync.mockImplementation(async (_cmd: string, args: string[]) =>
      args[0] === 'pull'
        ? { stdout: '', stderr: '' }
        : { stdout: `services:\n  sencho:\n    image: ${composeImageRef}\n`, stderr: '' },
    );
    ({ default: SelfUpdateService } = await import('../services/SelfUpdateService'));
    (SelfUpdateService.getInstance() as unknown as { composeContext: TestComposeContext }).composeContext = {
      workingDir: WORKING_DIR,
      configFiles: COMPOSE_FILE,
      serviceName: 'sencho',
      imageName: composeImageRef,
      dataDirHost: '/opt/sencho/data',
      hostBindMounts: [],
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('keeps a :dev pin on its own tag when the route forwards a stable target', async () => {
    await setupWithComposeImage(DEV_IMAGE_REF);

    // The production call shape: Fleet resolved a stable compare target and
    // forwarded it, so the repin branch runs and must decline on a floating pin.
    await SelfUpdateService.getInstance().triggerUpdate({ targetVersion: RESOLVED_TARGET });

    expect(mockExecFileAsync).toHaveBeenCalledWith(
      'docker',
      ['pull', DEV_IMAGE_REF],
      expect.objectContaining({ timeout: 300_000 }),
    );
    // The forwarded stable version must never become the pulled reference.
    expect(mockExecFileAsync).not.toHaveBeenCalledWith(
      'docker',
      ['pull', expect.stringContaining(RESOLVED_TARGET)],
      expect.anything(),
    );
    // A staged compose patch is written only when a repin is committed.
    expect(mockWriteFileSync).not.toHaveBeenCalled();

    const args = helperArgs();
    expect(args).not.toBeNull();
    expect(args).toContain(`${WORKING_DIR}:${WORKING_DIR}:ro`);
    expect(args).not.toContain(`${WORKING_DIR}:${WORKING_DIR}:rw`);
    expect(args![args!.length - 1]).not.toContain('cp ');
  });

  it('pulls the current dev image unchanged when no target is supplied at all', async () => {
    await setupWithComposeImage(DEV_IMAGE_REF);

    // The legacy pull-current path (no target anywhere) skips the repin branch
    // outright rather than declining inside it.
    await SelfUpdateService.getInstance().triggerUpdate();

    expect(mockExecFileAsync).toHaveBeenCalledWith(
      'docker',
      ['pull', DEV_IMAGE_REF],
      expect.objectContaining({ timeout: 300_000 }),
    );
    expect(mockWriteFileSync).not.toHaveBeenCalled();
    expect(helperArgs()).toContain(`${WORKING_DIR}:${WORKING_DIR}:ro`);
  });

  it('still repins a semver pin to the target (the assertions above are not vacuous)', async () => {
    await setupWithComposeImage(SEMVER_IMAGE_REF);

    await SelfUpdateService.getInstance().triggerUpdate({ targetVersion: RESOLVED_TARGET });

    // Contrast case: a semver pin is exactly what the floating pin must not do.
    expect(mockExecFileAsync).toHaveBeenCalledWith(
      'docker',
      ['pull', `saelix/sencho:${RESOLVED_TARGET}`],
      expect.objectContaining({ timeout: 300_000 }),
    );
    expect(mockWriteFileSync).toHaveBeenCalledWith(
      expect.stringContaining('.sencho-compose-patch'),
      expect.stringContaining(`saelix/sencho:${RESOLVED_TARGET}`),
      'utf8',
    );

    const args = helperArgs();
    expect(args).toContain(`${WORKING_DIR}:${WORKING_DIR}:rw`);
    expect(args![args!.length - 1]).toContain('cp ');
  });
});
