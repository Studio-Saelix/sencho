/**
 * Shared availability probes for the real-git and real-sshd E2E fixtures.
 *
 * Mirrors backend/src/__tests__/__helpers__/externalDeps.ts. Kept as a
 * separate file rather than a shared import: backend's tsconfig pins
 * `rootDir` to backend/src, so a cross-directory import would fail
 * `tsc --noEmit` there.
 *
 * `gitServer.helper.ts` and `sshGit.helper.ts` used to each probe with their
 * own local `spawnSync` check and let a missing dependency silently skip the
 * spec, in CI as well as locally. These wrappers keep that local-dev
 * behavior but throw under CI, where the dependency is expected to be
 * present and a skip would be a false claim of coverage.
 */
import { spawnSync } from 'child_process';

export type DependencyProbe = () => boolean;

export const defaultGitProbe: DependencyProbe = () =>
  spawnSync('git', ['--version'], { stdio: 'ignore' }).status === 0;

export const defaultSshdProbe: DependencyProbe = () =>
  spawnSync('/usr/sbin/sshd', ['-V'], { stdio: 'ignore' }).status === 0;

function requireDependency(name: string, hint: string, probe: DependencyProbe): boolean {
  const present = probe();
  if (!present && process.env.CI) {
    throw new Error(`${name} is required in CI but was not found. ${hint}`);
  }
  return present;
}

/** True when the system `git` binary is available; throws under CI if not. */
export function requireGitBinary(probe: DependencyProbe = defaultGitProbe): boolean {
  return requireDependency(
    'git',
    'Ensure the CI image installs the git CLI before running the E2E suite.',
    probe,
  );
}

/** True when a local `sshd` binary is available; throws under CI if not. */
export function requireSshd(probe: DependencyProbe = defaultSshdProbe): boolean {
  return requireDependency(
    'sshd',
    'Ensure the CI image installs openssh-server and frees loopback port 22 (see .github/workflows/ci.yml).',
    probe,
  );
}
