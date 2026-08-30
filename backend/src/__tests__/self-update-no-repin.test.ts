/**
 * Regression coverage for the no-repin invariant on a floating-tag self-update
 * (the dev-build "Update now" path: triggerUpdate() called with neither
 * targetVersion nor targetImageRef, exactly as executeClaimedCommunityUpdate
 * invokes it for a :dev image). The worst-case failure mode is silently
 * repinning the compose file to a stable tag; this proves the actual
 * SelfUpdateService decision, not a mock standing in for it, pulls the
 * compose-declared ref unchanged and never stages or copies a compose rewrite.
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

describe('SelfUpdateService.triggerUpdate (no-repin invariant)', () => {
  let SelfUpdateService: typeof import('../services/SelfUpdateService').default;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockExecFileAsync.mockResolvedValue({ stdout: '', stderr: '' });
    ({ default: SelfUpdateService } = await import('../services/SelfUpdateService'));
    (SelfUpdateService.getInstance() as unknown as { composeContext: TestComposeContext }).composeContext = {
      workingDir: '/opt/sencho',
      configFiles: '/opt/sencho/docker-compose.yml',
      serviceName: 'sencho',
      imageName: DEV_IMAGE_REF,
      dataDirHost: '/opt/sencho/data',
      hostBindMounts: [],
    };
  });

  it('pulls the current dev image unchanged and never stages a compose rewrite', async () => {
    await SelfUpdateService.getInstance().triggerUpdate();

    // No targetVersion/targetImageRef means the repin branch never runs, so the
    // exact compose-declared ref is pulled: no re-resolution, no tag rewrite.
    expect(mockExecFileAsync).toHaveBeenCalledWith(
      'docker',
      ['pull', DEV_IMAGE_REF],
      expect.objectContaining({ timeout: 300_000 }),
    );

    // The staged compose patch is only ever written on the repin branch.
    expect(mockWriteFileSync).not.toHaveBeenCalled();

    // The recreate helper mounts the working dir read-only (repinWritable is
    // only set when a composeCopy is staged) and its command has no cp step.
    expect(mockExecFile).toHaveBeenCalledTimes(1);
    const [, helperArgs] = mockExecFile.mock.calls[0] as [string, string[]];
    expect(helperArgs).toContain('/opt/sencho:/opt/sencho:ro');
    expect(helperArgs).not.toContain('/opt/sencho:/opt/sencho:rw');
    const composeCmd = helperArgs[helperArgs.length - 1];
    expect(composeCmd).not.toContain('cp ');
  });
});
