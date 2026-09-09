/**
 * Shared availability probes for the real-git and real-sshd integration
 * suites.
 *
 * Every suite used to carry its own copy of `gitAvailable()`/`sshdAvailable()`
 * and pass the result straight to `describe.skipIf`, so a missing dependency
 * in CI silently skipped the suite instead of failing the build: proof of a
 * combination could stop running with nothing in the test output to say so.
 * These wrappers keep the same local-dev behavior (skip when the dependency
 * is absent) but throw under CI, where the dependency is expected to be
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
        'Ensure the CI image installs the git CLI before running the backend suite.',
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
