import { execFile } from 'child_process';

/**
 * Locate and qualify the git binary once per process. Git Sources requires
 * the native git CLI at runtime; Docker images install it explicitly, but
 * bare-metal and `npm run dev` hosts may not have it, so the probe produces
 * an actionable failure instead of a confusing ENOENT deep inside a clone.
 */

// Shallow single-branch clone and ls-remote behaviors used here are stable
// long before this; the floor mainly guards against ancient builds with
// different stderr wording.
const MIN_GIT_VERSION = [2, 40, 0] as const;

let cachedProbe: Promise<string> | undefined;

function runGitVersion(): Promise<string> {
    return new Promise((resolve, reject) => {
        execFile('git', ['--version'], { windowsHide: true, timeout: 10_000 }, (err, stdout) => {
            if (err) {
                reject(err);
                return;
            }
            resolve(stdout.trim());
        });
    });
}

function parseVersion(output: string): number[] | null {
    const match = /git version (\d+)\.(\d+)(?:\.(\d+))?/.exec(output);
    if (!match) return null;
    return [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)];
}

function versionAtLeast(actual: number[], min: readonly number[]): boolean {
    for (let i = 0; i < min.length; i++) {
        const a = actual[i] ?? 0;
        if (a > min[i]) return true;
        if (a < min[i]) return false;
    }
    return true;
}

/**
 * Probe `git --version` once and cache the result. Resolves with the raw
 * version output; rejects with an operator-actionable error when the binary
 * is missing or older than the supported floor.
 */
export function ensureGitBinary(): Promise<string> {
    cachedProbe ??= (async () => {
        let output: string;
        try {
            output = await runGitVersion();
        } catch (e) {
            cachedProbe = undefined;
            const cause = e instanceof Error ? ` (${e.message})` : '';
            throw new Error(
                'The git command could not be executed. Sencho requires the native git client for Git Sources. '
                + 'If git is installed, check its permissions; otherwise install it (Docker images already include it) and restart.'
                + cause,
            );
        }
        const parsed = parseVersion(output);
        if (!parsed || !versionAtLeast(parsed, MIN_GIT_VERSION)) {
            cachedProbe = undefined;
            throw new Error(
                `The installed git client is too old (${output || 'unrecognized'}). `
                + `Git Sources requires git ${MIN_GIT_VERSION.join('.')} or newer.`,
            );
        }
        return output;
    })();
    return cachedProbe;
}

let cachedExecPath: Promise<string> | undefined;

/**
 * Absolute path of git's exec directory (cached). Used on Windows to locate
 * the installation's bundled CA bundle, whose normal discovery goes through
 * system gitconfig that this transport deliberately strips.
 */
export function getGitExecPath(): Promise<string> {
    cachedExecPath ??= new Promise<string>((resolve, reject) => {
        execFile('git', ['--exec-path'], { windowsHide: true, timeout: 10_000 }, (err, stdout) => {
            if (err) {
                // Mirror ensureGitBinary: a transient failure must not poison
                // the cache for the lifetime of the process.
                cachedExecPath = undefined;
                reject(err);
            } else {
                resolve(stdout.trim());
            }
        });
    });
    return cachedExecPath;
}

/** Test seam: forget the cached probes so subsequent calls re-run them. */
export function resetGitBinaryProbeForTests(): void {
    cachedProbe = undefined;
    cachedExecPath = undefined;
}
