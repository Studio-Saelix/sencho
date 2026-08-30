import { spawn, type ChildProcess } from 'child_process';
import { promises as fs, existsSync } from 'fs';
import os from 'os';
import path from 'path';
import { ensureGitBinary, getGitExecPath } from './gitBinary';
import {
    CREDENTIAL_HELPER_CONFIG_VALUE,
    GIT_ALLOWED_HOST_ENV_VAR,
    GIT_HELPER_PATH_ENV_VAR,
    GIT_TOKEN_ENV_VAR,
    writeCredentialHelper,
} from './credentialHelper';
import { credentialScopeHost } from './caBundle';
import { writeCombinedCaBundle } from './gitCaBundleSink';
import { isTransportFailure, type TransportFailure } from './errors';
import type { FetchRequest, FetchResult, GitTransport, ResolveRequest, ResolveResult } from './types';
import {
    buildSshCommand,
    parseRepoTransportUrl,
    type ParsedRepoUrl,
} from './sshTrust';
import { writeDeployKey, writeKnownHosts } from './sshCredentialFiles';

/**
 * Native git transport: every Git operation is an `execFile`-style spawn of
 * the real git CLI with an argv array (never a shell), a hardened
 * environment, and per-invocation config flags.
 *
 * Hardening applied to every invocation:
 * - `GIT_CONFIG_NOSYSTEM=1` plus an isolated empty HOME/USERPROFILE so the
 *   operator's ~/.gitconfig (credential helpers, insteadOf rewrites, hooks)
 *   cannot influence fetches.
 * - `protocol.allow=never` with only https re-enabled: no file://, git://,
 *   ext::, or ssh:// this early in the program.
 * - `core.hooksPath` pointed at an empty directory we own, so repository
 *   scripts can never run. (A literal /dev/null works on Linux but not
 *   Windows; an empty dir is portable.)
 * - `GIT_TERMINAL_PROMPT=0` and a neutralized GIT_ASKPASS so a missing or
 *   wrong credential fails fast instead of hanging on a prompt.
 * - Every remaining git-config channel is pinned empty (GIT_CONFIG_GLOBAL /
 *   GIT_CONFIG_SYSTEM to the null device, XDG_CONFIG_HOME cleared,
 *   GIT_CONFIG_COUNT zeroed) and inherited GIT_TRACE is cleared so packet
 *   dumps cannot carry URL material.
 * - The token reaches git ONLY through the credential helper reading
 *   SENCHO_GIT_TOKEN from the child env; it never appears in argv or URLs.
 *
 * Dev/E2E certificate bridge: when NODE_EXTRA_CA_CERTS is set (the existing
 * dev/CI wiring for the e2e TLS fixture server), its CAs are combined with
 * platform defaults into <workspace>/.meta/combined-ca.pem and passed as
 * http.sslCAInfo, mirroring Node's add-not-replace semantics. Without the
 * variable, POSIX passes nothing (OpenSSL uses system trust) and Windows
 * pins Git's own bundled bundle (see detectWindowsCABundle).
 */

const DEFAULT_TIMEOUT_MS = 30_000;
const LS_REMOTE_MAX_MS = 10_000;
const STDERR_CAP = 16_384;
const WATCHDOG_INTERVAL_MS = 1_000;
const SHA_PATTERN = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/i;

interface RunResult {
    stdout: string;
    stderr: string;
    exitCode: number;
}

interface RunOptions {
    cwd?: string;
    env: NodeJS.ProcessEnv;
    timeoutMs: number;
    onSpawn?: (child: ChildProcess) => void;
}

function isTimeoutError(e: unknown): boolean {
    return typeof e === 'object' && e !== null && (e as { gitTimedOut?: unknown }).gitTimedOut === true;
}

/** Flag an error as a git timeout so `isTimeoutError` recognises it downstream. */
function asTimeoutError<T extends Error>(err: T): T {
    return Object.assign(err, { gitTimedOut: true });
}

/**
 * Kill the whole child tree. POSIX uses the process group; Windows taskkill.
 *
 * Resolves when the kill OPERATION is finished, which on Windows means
 * taskkill has itself exited. That matters because taskkill walks the tree in
 * a separate process: the direct git child can close while taskkill is still
 * terminating its descendants, so a caller that settled on the child's close
 * alone could start deleting the workspace out from under processes that are
 * still running in it. On POSIX the group signal is delivered synchronously,
 * so there is nothing further to await.
 *
 * Never rejects: a kill that cannot be confirmed is reported through the
 * fallback warning, and the caller's own confirmation timeout bounds the wait.
 */
function killTree(child: ChildProcess | undefined): Promise<void> {
    if (!child?.pid) return Promise.resolve();
    if (process.platform === 'win32') {
        return new Promise<void>((resolve) => {
            const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
            // 'error' and 'close' can both fire for one spawn attempt; only the
            // first should trigger the fallback so a single kill never falls back
            // (or logs) twice.
            let finished = false;
            const finish = (why?: string) => {
                if (finished) return;
                finished = true;
                if (why) {
                    console.warn(`[GitSource:transport] taskkill ${why} for pid ${child.pid}; falling back to child.kill() (tree-kill guarantee no longer holds: descendants of ${child.pid} may still be running)`);
                    // This runs in an event callback, where a throw would be an
                    // uncaught exception rather than a rejection of this promise.
                    try {
                        child.kill();
                    } catch (e) {
                        console.warn(`[GitSource:transport] fallback kill for pid ${child.pid} failed: ${e instanceof Error ? e.message : String(e)}`);
                    }
                }
                resolve();
            };
            killer.on('error', (err) => finish(`failed to spawn (${err.message})`));
            killer.on('close', (code) => finish(code === 0 ? undefined : `exited ${code}`));
        });
    }
    try {
        // The child is spawned detached, so it leads its own process group.
        process.kill(-child.pid, 'SIGKILL');
    } catch {
        try {
            child.kill('SIGKILL');
        } catch (e) {
            console.warn(`[GitSource:transport] fallback kill for pid ${child.pid} failed: ${e instanceof Error ? e.message : String(e)}`);
        }
    }
    return Promise.resolve();
}

/**
 * Await a kill that has already been issued, but never longer than
 * KILL_CONFIRM_TIMEOUT_MS. A platform kill helper that wedges must not turn
 * into a caller that hangs forever with nothing logged; past the bound we say
 * so and carry on, exactly as runGit's own confirmation timer does.
 */
async function awaitKillConfirmed(kill: Promise<void> | undefined, what: string): Promise<void> {
    if (!kill) return;
    let timer: NodeJS.Timeout | undefined;
    const bound = new Promise<void>((resolve) => {
        timer = setTimeout(() => {
            console.warn(`[GitSource:transport] ${what} not confirmed within ${KILL_CONFIRM_TIMEOUT_MS}ms; continuing cleanup while it may still be running`);
            resolve();
        }, KILL_CONFIRM_TIMEOUT_MS);
    });
    try {
        await Promise.race([kill, bound]);
    } finally {
        clearTimeout(timer);
    }
}

/** Bound on how long to wait for a confirmed close after a kill is issued, so a kill that never reports back cannot hang the caller forever. */
const KILL_CONFIRM_TIMEOUT_MS = 5_000;

/**
 * Spawn git and collect output. On timeout, kills the entire child tree and
 * waits for its `close` event before rejecting: settling as soon as the kill
 * is merely issued (rather than confirmed) would let the caller start
 * cleaning up the workspace while the child tree, or the platform kill
 * helper (taskkill), is still running. Resolves with whatever exit code git
 * reported when it closes on its own.
 */
function runGit(args: string[], opts: RunOptions): Promise<RunResult> {
    return new Promise((resolve, reject) => {
        const child = spawn('git', args, {
            cwd: opts.cwd,
            env: opts.env,
            windowsHide: true,
            detached: process.platform !== 'win32',
        });
        let stdout = '';
        let stderr = '';
        let settled = false;
        let timedOut = false;
        let killConfirmTimer: NodeJS.Timeout | undefined;
        // Resolves once the kill operation itself is done (see killTree); a
        // timed-out run must not settle before BOTH this and the child's own
        // close event.
        let killFinished: Promise<void> | undefined;
        const append = (cur: string, chunk: Buffer) => (cur.length < STDERR_CAP ? cur + chunk.toString('utf8') : cur);

        const timer = setTimeout(() => {
            if (settled) return;
            timedOut = true;
            killFinished = killTree(child);
            killConfirmTimer = setTimeout(() => {
                if (settled) return;
                settled = true;
                console.error(`[GitSource:transport] kill not confirmed within ${KILL_CONFIRM_TIMEOUT_MS}ms for pid ${child.pid}; the process may still be running`);
                reject(asTimeoutError(new Error('git timed out (kill unconfirmed)')));
            }, KILL_CONFIRM_TIMEOUT_MS);
        }, opts.timeoutMs);

        child.stdout?.on('data', (c: Buffer) => {
            stdout = append(stdout, c);
        });
        child.stderr?.on('data', (c: Buffer) => {
            stderr = append(stderr, c);
        });
        const finishSettle = (): boolean => {
            if (settled) return false;
            settled = true;
            clearTimeout(timer);
            clearTimeout(killConfirmTimer);
            return true;
        };

        /**
         * Reject a timed-out run, but only once the kill operation has also
         * finished. The direct child can be gone while the platform kill
         * helper (taskkill) is still walking its descendants, and settling in
         * that window releases the caller to delete a workspace those
         * descendants are still using. Both settle paths below go through
         * here; the kill-confirmation timer above still bounds the wait.
         */
        const rejectAfterKill = (err: Error): void => {
            void (killFinished ?? Promise.resolve()).then(() => {
                if (finishSettle()) reject(asTimeoutError(err));
            });
        };

        child.on('error', (err) => {
            if (settled) return;
            // 'error' can also fire after the kill has been issued (e.g. the
            // process could not be killed); preserve the timeout flag so
            // callers still classify this as a timeout rather than a bare
            // exit failure, and wait for the kill exactly as 'close' does.
            if (timedOut) {
                rejectAfterKill(err);
                return;
            }
            if (finishSettle()) reject(err);
        });
        child.on('close', (code) => {
            if (settled) return;
            if (timedOut) {
                rejectAfterKill(new Error('git timed out'));
                return;
            }
            if (finishSettle()) resolve({ stdout, stderr, exitCode: code ?? -1 });
        });

        opts.onSpawn?.(child);
    });
}

// ─── Workspace layout ────────────────────────────────────────────────────────

interface WorkspaceLayout {
    /** Scratch dir for transport-owned files (credential helper script, combined CA bundle, isolated HOME). */
    metaDir: string;
    hooksDir: string;
    homeDir: string;
}

async function prepareWorkspace(root: string): Promise<WorkspaceLayout> {
    const metaDir = path.join(root, '.meta');
    const hooksDir = path.join(metaDir, 'hooks');
    const homeDir = path.join(metaDir, 'home');
    await fs.mkdir(hooksDir, { recursive: true });
    await fs.mkdir(homeDir, { recursive: true });
    return { metaDir, hooksDir, homeDir };
}

function buildEnv(
    homeDir: string,
    token?: string | null,
    helperPath?: string | null,
    sshCommand?: string | null,
    allowedHost?: string | null,
): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: '1',
        // GIT_CONFIG_NOSYSTEM does not block explicit config-file pointers or
        // XDG lookups; pin every channel git could read operator config from.
        GIT_CONFIG_GLOBAL: os.devNull,
        GIT_CONFIG_SYSTEM: os.devNull,
        XDG_CONFIG_HOME: '',
        GIT_CONFIG_COUNT: '0',
        GIT_TERMINAL_PROMPT: '0',
        GIT_ASKPASS: '',
        // An inherited trace flag would widen the log surface with packet
        // dumps that can carry URL material.
        GIT_TRACE: '',
        HOME: homeDir,
    };
    if (process.platform === 'win32') {
        env.USERPROFILE = homeDir;
    }
    if (token) {
        env[GIT_TOKEN_ENV_VAR] = token;
    }
    if (helperPath) {
        // The helper's location, kept out of the credential.helper config
        // value so no workspace path character can change how git's shell
        // parses it. See credentialHelper.ts.
        env[GIT_HELPER_PATH_ENV_VAR] = helperPath;
    }
    if (allowedHost) {
        env[GIT_ALLOWED_HOST_ENV_VAR] = allowedHost;
    }
    if (sshCommand) {
        env.GIT_SSH_COMMAND = sshCommand;
    }
    return env;
}

// ─── Redirect policy ────────────────────────────────────────────────────────

/**
 * Maximum number of redirect hops we tolerate before failing closed.
 * The value matches curl's default (-: 50) for HTTP and most Git providers
 * never exceed a single redirect; a tight cap protects against loops.
 */
const MAX_REDIRECT_HOPS = 5;

/**
 * Pull every `Location: <url>` value out of git's stderr (curl/git prints the
 * hop chain when redirects are followed) and return the *final* destination
 * as an absolute URL. Returns null when the chain has no Location lines or
 * when any link cannot be resolved against the previous one. The chain length
 * is capped at MAX_REDIRECT_HOPS to bound the parse cost.
 */
export function extractFinalRedirectLocation(stderr: string, originalUrl: string): string | null {
    let current = originalUrl;
    let hops = 0;
    let last: string | null = null;
    for (const match of stderr.matchAll(/(?:^|\n)\s*Location:\s*(\S+)/gi)) {
        if (hops >= MAX_REDIRECT_HOPS) return null;
        const next = resolveLocation(current, match[1]);
        if (!next) return null;
        current = next;
        last = next;
        hops += 1;
    }
    return last;
}

/**
 * Pull every `Location: <url>` value out of git's stderr and validate each
 * hop against the redirect policy. Returns a classified TransportFailure
 * when any hop violates the policy, or null when the chain is clean. The
 * function is intentionally tolerant of an empty chain: when no Location
 * header was logged, there is nothing to validate, and the caller can
 * proceed with its normal classification.
 */
export function classifyRedirectStderr(
    stderr: string,
    originalUrl: string,
    allowedHost: string | null,
    hasToken: boolean,
): TransportFailure | null {
    if (!/Location:\s*\S+/i.test(stderr)) return null;
    let current = originalUrl;
    let hops = 0;
    for (const match of stderr.matchAll(/(?:^|\n)\s*Location:\s*(\S+)/gi)) {
        if (hops >= MAX_REDIRECT_HOPS) {
            return { transportFailure: true as const, reason: 'redirect-scope', host: originalUrl, hasToken } satisfies TransportFailure;
        }
        const next = resolveLocation(current, match[1]);
        if (!next) {
            return { transportFailure: true as const, reason: 'redirect-scope', host: originalUrl, hasToken } satisfies TransportFailure;
        }
        try {
            validateRedirectHop(current, next, allowedHost);
        } catch (e) {
            if (isTransportFailure(e)) return e;
            throw e;
        }
        current = next;
        hops += 1;
    }
    return null;
}

/**
 * Public DNS-suffix set is impractical to ship, so we treat well-known
 * dangerous ranges instead. Loopback (127/8, ::1, localhost) and the RFC 1918
 * private ranges block attempts to redirect an authenticated fetch to a host
 * that can talk to internal services the operator's browser cannot.
 */
function isForbiddenRedirectHost(host: string): boolean {
    const lower = host.toLowerCase();
    if (lower === 'localhost' || lower === 'localhost.localdomain') return true;
    if (lower.startsWith('127.') || lower === '::1' || lower === '0:0:0:0:0:0:0:1') return true;
    if (lower.startsWith('10.')) return true;
    if (lower.startsWith('172.')) {
        const parts = lower.split('.');
        const second = Number(parts[1]);
        if (Number.isFinite(second) && second >= 16 && second <= 31) return true;
    }
    if (lower.startsWith('192.168.')) return true;
    if (lower.startsWith('169.254.')) return true;
    if (lower.startsWith('fe80:') || lower.startsWith('fc') || lower.startsWith('fd')) return true;
    return false;
}

/**
 * Validate a single redirect hop's destination.
 * Same-host redirects are always allowed; cross-host redirects require the
 * caller's allowedHost to match; any redirect to a forbidden or non-HTTPS
 * destination fails closed.
 */
function validateRedirectHop(
    fromUrl: string,
    toUrl: string,
    allowedHost: string | null,
): void {
    let fromParsed: URL;
    let toParsed: URL;
    try {
        fromParsed = new URL(fromUrl);
        toParsed = new URL(toUrl);
    } catch {
        throw { transportFailure: true as const, reason: 'redirect-scope', host: fromUrl, hasToken: Boolean(allowedHost) } satisfies TransportFailure;
    }
    if (fromParsed.protocol === 'https:' && toParsed.protocol !== 'https:') {
        throw { transportFailure: true as const, reason: 'redirect-scope', host: fromUrl, hasToken: Boolean(allowedHost) } satisfies TransportFailure;
    }
    if (isForbiddenRedirectHost(toParsed.hostname)) {
        throw { transportFailure: true as const, reason: 'redirect-scope', host: fromUrl, hasToken: Boolean(allowedHost) } satisfies TransportFailure;
    }
    if (allowedHost) {
        const toScope = credentialScopeHost(toParsed.hostname, toParsed.port ? Number(toParsed.port) : undefined);
        if (toScope !== allowedHost) {
            throw { transportFailure: true as const, reason: 'redirect-scope', host: fromUrl, hasToken: true } satisfies TransportFailure;
        }
    }
}

/**
 * Parse a Location header (absolute or relative) against a base URL.
 * Returns null on parse failure so the caller can fail closed.
 */
function resolveLocation(baseUrl: string, location: string): string | null {
    try {
        return new URL(location, baseUrl).toString();
    } catch {
        return null;
    }
}

/**
 * Windows-only: locate the CA bundle bundled with Git for Windows. Stripping
 * system gitconfig (GIT_CONFIG_NOSYSTEM) also strips the installer's
 * http.sslCAInfo pointer to this file, and unlike Linux there is no /etc/ssl
 * default for the OpenSSL backend to fall back on.
 */
async function detectWindowsCABundle(): Promise<string | null> {
    try {
        const execPath = await getGitExecPath();
        const installRoot = path.resolve(execPath, '..', '..'); // <install>/mingw64/libexec/git-core -> <install>/mingw64
        const candidates = [
            path.join(installRoot, 'etc', 'ssl', 'certs', 'ca-bundle.crt'),
            path.resolve(execPath, '..', '..', '..', 'usr', 'ssl', 'certs', 'ca-bundle.crt'),
        ];
        for (const candidate of candidates) {
            if (existsSync(candidate)) return candidate.split(path.sep).join('/');
        }
    } catch {
        // Fall through: without a bundle the fetch fails with a clear TLS
        // classification instead of a silent trust downgrade.
    }
    return null;
}

/**
 * Build the CA-anchor configuration for one fetch.
 *
 * Mirrors Node's own NODE_EXTRA_CA_CERTS semantics (extra anchors ADDED to
 * the defaults, never replacing them) by writing a combined PEM bundle into
 * the fetch workspace's `.meta` dir:
 * - No NODE_EXTRA_CA_CERTS and no per-source PEM: production posture.
 *   POSIX passes nothing and lets OpenSSL use system trust; Windows pins
 *   Git's own bundled bundle, because stripping system gitconfig also
 *   strips the installer's pointer to it.
 * - With NODE_EXTRA_CA_CERTS and/or a per-source PEM: defaults PLUS the extra
 *   CAs, so private-CA servers and public hosts validate in the same fetch.
 *
 * The per-source PEM and the env-var file are written by
 * `writeCombinedCaBundle` in `./gitCaBundleSink.ts`; the sink module is the
 * single point CodeQL is asked to ignore for `js/http-to-file-access` because
 * every input it writes is either a file path inside the per-fetch workspace
 * (no external taint) or a PEM that the caller has already validated.
 */
async function resolveCaArgs(layout: WorkspaceLayout, perSourceCaPem?: string | null): Promise<string[]> {
    const isWindows = process.platform === 'win32';

    // Per-source and env-var anchors live in a single combined file written by
    // the sink module. The sink now includes system anchors when custom
    // anchors are present, so we only need to handle the "no custom anchors"
    // case specially for Windows.
    const combined = await writeCombinedCaBundle(layout.metaDir, perSourceCaPem);
    if (combined) {
        return ['-c', `http.sslCAInfo=${combined.path}`];
    }

    // No custom anchors: on POSIX we pass nothing (system trust applies
    // directly via OpenSSL). On Windows we still need the Git-bundled
    // pointer because GIT_CONFIG_NOSYSTEM stripped the installer's config.
    if (isWindows) {
        const bundle = await detectWindowsCABundle();
        return bundle ? ['-c', `http.sslCAInfo=${bundle}`] : [];
    }

    return [];
}

/**
 * Config shared by every invocation. With no helper, credential.helper is
 * explicitly cleared so nothing from the environment can answer prompts.
 */
async function commonArgs(
    layout: WorkspaceLayout,
    helperPath: string | null,
    ssh: boolean,
    perSourceCaPem?: string | null,
): Promise<string[]> {
    const args = [
        '-c', 'protocol.allow=never',
    ];
    if (ssh) {
        args.push('-c', 'protocol.ssh.allow=always');
    } else {
        args.push('-c', 'protocol.https.allow=always');
        // Cross-host redirect protection uses TWO layers (both must agree):
        // (1) Host-scoped credential helper: only emits PAT when git requests
        //     the configured repository host. Redirect to different host = no
        //     credentials = follow-up fetch fails with standard TLS/not-found.
        // (2) Post-failure validation: classifyRedirectStderr parses stderr
        //     for Location headers on non-zero exit and validates each hop via
        //     validateRedirectHop (same-host allowed; cross-host blocked when
        //     allowedHost is set; forbidden hosts always refused).
        // We do NOT disable git's redirect following (followRedirects=false)
        // because that denies legitimate same-host redirects and prevents the
        // stderr parser from seeing Location headers needed to validate.
        // Cross-host redirects to untrusted hosts receive no credentials and
        // are caught by (1); same-host redirects proceed; failed redirects
        // are caught by (2).
        // Cross-host redirect safety is enforced by the host-scoped credential
        // helper (see credentialHelper.ts): the helper reads host/port from
        // stdin and only emits the PAT when the requested host matches the
        // configured repository's host. Same-host redirects continue to work;
        // a redirect to a different host receives no credentials, and the
        // follow-up fetch will fail with the standard TLS / not-found error.
    }
    args.push('-c', `core.hooksPath=${layout.hooksDir.split(path.sep).join('/')}`);
    if (process.platform === 'win32') {
        // With every config channel neutralized above, git falls back to its
        // build-default TLS backend, which on Git for Windows can be
        // schannel. Schannel ignores http.sslCAInfo (breaking the dev/E2E CA
        // bridge) and trusts per-Windows-cert-store state, so pin the
        // OpenSSL backend that ships with Git for Windows. Production Alpine
        // git is OpenSSL-backed and unaffected by this flag's absence.
        args.push('-c', 'http.sslBackend=openssl');
    }
    args.push(...await resolveCaArgs(layout, perSourceCaPem));
    if (helperPath !== null) {
        // A fixed value: the helper's path reaches git through the child env
        // instead of being interpolated here, so a workspace path containing
        // a space (or a quote, `$`, `;`, ...) cannot change how git's shell
        // parses it. See credentialHelper.ts for the parsing rule.
        args.push('-c', `credential.helper=${CREDENTIAL_HELPER_CONFIG_VALUE}`);
    } else {
        args.push('-c', 'credential.helper=');
    }
    return args;
}

/**
 * Everything one invocation needs: the workspace layout, the child env, and
 * the shared config argv.
 *
 * The credential handoff is assembled in exactly this one place because its
 * three parts have to agree. If the config named the helper variable but the
 * env did not export it, git would find nothing to run, fall back to an
 * anonymous fetch, and a private repo's 401 would then classify as
 * REPO_NOT_FOUND instead of AUTH_FAILED. That is a silent downgrade, so the
 * config arg is keyed off the helper actually having been written rather than
 * off the token being present.
 */
async function prepareInvocation(
    workspaceRoot: string,
    repoUrl: string,
    token?: string | null,
    sshAuth?: ResolveRequest['sshAuth'],
    caBundlePem?: string | null,
): Promise<{ layout: WorkspaceLayout; env: NodeJS.ProcessEnv; baseArgs: string[]; allowedHost: string | null }> {
    const layout = await prepareWorkspace(workspaceRoot);
    let sshCommand: string | null = null;
    if (sshAuth) {
        const keyPath = await writeDeployKey(layout.metaDir, sshAuth.privateKey);
        const knownPath = await writeKnownHosts(layout.metaDir, sshAuth.knownHostsEntry);
        sshCommand = buildSshCommand(keyPath, knownPath);
    }
    const helperPath = token ? await writeCredentialHelper(layout.metaDir) : null;
    const parsed = parseRepoTransportUrl(repoUrl);
    const allowedHost = parsed?.kind === 'https' && token
        ? credentialScopeHost(parsed.host)
        : null;
    const env = buildEnv(layout.homeDir, token, helperPath, sshCommand, allowedHost);
    const baseArgs = await commonArgs(layout, helperPath, Boolean(sshAuth), caBundlePem);
    return { layout, env, baseArgs, allowedHost };
}

// ─── Input validation ────────────────────────────────────────────────────────

function invalidUrl(host: string, hasToken: boolean): TransportFailure {
    return { transportFailure: true as const, reason: 'invalid-url', host, hasToken };
}

function assertValidRepoUrl(repoUrl: string, hasToken: boolean): ParsedRepoUrl {
    const parsed = parseRepoTransportUrl(repoUrl);
    if (!parsed) {
        throw invalidUrl('unknown', hasToken);
    }
    return parsed;
}

function repoHostLabel(repo: ParsedRepoUrl): string {
    if (repo.kind === 'ssh' && repo.port && repo.port !== 22) {
        return `${repo.host}:${repo.port}`;
    }
    return repo.host;
}

/**
 * Ceiling on a ref name. Git itself imposes no branch-length limit worth
 * matching (`check-ref-format --branch` accepts names into the thousands, up
 * to the filesystem's own path limits), so this is Sencho's bound, not git's,
 * and the API and the transport have to agree on it: a name the route accepts
 * and stores must not be rejected later by the transport that fetches it.
 * `routes/gitSources.ts` imports this constant for exactly that reason.
 */
export const REF_MAX_LEN = 256;
// ASCII control characters, space, and the characters git's own
// check-ref-format forbids anywhere in a ref (~^:?*[\). Everything else,
// including non-ASCII scripts, is a legitimate branch-name character.
const REF_DISALLOWED_CHARS = /[\x00-\x20\x7f~^:?*[\\]/;

/**
 * Validates a ref name against the rules `git check-ref-format --branch`
 * applies to a branch: no control characters, space, or `~^:?*[\`; no `..`
 * or `@{`; no path component starting with `.` or ending in `.lock`; no
 * leading `-` (git's own `--branch` mode already refuses this, since a
 * leading dash makes the name ambiguous with a flag on argv, which is
 * exactly the injection risk this validator exists to close). The one rule
 * that is ours rather than git's is REF_MAX_LEN, shared with the route so the
 * two cannot disagree.
 */
function assertValidRef(ref: string, host: string, hasToken: boolean): void {
    const segments = ref.split('/');
    const valid = ref.length > 0
        && ref.length <= REF_MAX_LEN
        && !ref.startsWith('-')
        && !REF_DISALLOWED_CHARS.test(ref)
        && !ref.includes('..')
        && !ref.includes('@{')
        && !ref.endsWith('.')
        && segments.every((seg) => seg.length > 0 && !seg.startsWith('.') && !seg.endsWith('.lock'));
    if (!valid) {
        throw { transportFailure: true as const, reason: 'invalid-ref', host, hasToken } satisfies TransportFailure;
    }
}

// ─── Size watchdog ───────────────────────────────────────────────────────────

async function treeSize(root: string): Promise<number> {
    let total = 0;
    const stack: string[] = [root];
    while (stack.length) {
        const dir = stack.pop();
        if (!dir) break;
        const entries = await fs.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
            const p = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                stack.push(p);
            } else if (entry.isFile()) {
                total += (await fs.stat(p)).size;
            }
            // Symlinks are neither followed nor counted; clones made here do
            // not create them and counting targets could inflate the sum.
        }
    }
    return total;
}

interface Watchdog {
    stop(): void;
}

/**
 * Polls the workspace's on-disk size and fires `onBreach` once it exceeds
 * `maxBytes`. Exported for tests.
 */
export function startSizeWatchdog(
    root: string,
    maxBytes: number,
    onBreach: () => void,
): Watchdog {
    let stopped = false;
    let busy = false;
    let readFailures = 0;
    const timer = setInterval(() => {
        if (stopped || busy) return;
        busy = true;
        void treeSize(root)
            .then((size) => {
                readFailures = 0;
                if (!stopped && size > maxBytes) {
                    stopped = true;
                    clearInterval(timer);
                    onBreach();
                }
            })
            .catch(() => {
                // Benign right after teardown (ENOENT mid-walk), but a
                // persistent inability to measure the workspace silently
                // disables the documented cap; say so once per streak.
                readFailures += 1;
                if (!stopped && readFailures === 3) {
                    console.warn('[GitSource:transport] could not stat clone workspace; GITSOURCE_MAX_CLONE_BYTES enforcement is degraded for this fetch.');
                }
            })
            .finally(() => {
                busy = false;
            });
    }, WATCHDOG_INTERVAL_MS);
    return {
        stop(): void {
            stopped = true;
            clearInterval(timer);
        },
    };
}

// ─── Transport implementation ────────────────────────────────────────────────

async function ensureBinaryReady(hasToken: boolean): Promise<void> {
    try {
        await ensureGitBinary();
    } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        const stale = /too old/.test(message);
        throw { transportFailure: true as const, reason: stale ? 'git-old' : 'git-missing', stderr: message, host: 'unknown', hasToken } satisfies TransportFailure;
    }
}

interface ResolvedRemoteRefs {
    branchSha: string | null;
    tagSha: string | null;
}

/**
 * Ask the remote where a bare ref name lives. One `ls-remote` with explicit
 * refspecs for both namespaces keeps the response tiny (a name matches at
 * most a couple of lines even on huge repos), so the stdout cap can never
 * truncate the answer we need. For an annotated tag the peeled `^{}` entry
 * carries the commit, so it wins over the raw tag-object line; a lightweight
 * tag's raw line already points at the commit.
 */
async function lsRemoteRefs(
    repo: ParsedRepoUrl,
    ref: string,
    env: NodeJS.ProcessEnv,
    baseArgs: string[],
    timeoutMs: number,
    hasToken: boolean,
    allowedHost: string | null = null,
): Promise<ResolvedRemoteRefs> {
    const host = repoHostLabel(repo);
    let res: RunResult;
    try {
        res = await runGit(
            [...baseArgs, 'ls-remote', repo.href, `refs/heads/${ref}`, `refs/tags/${ref}`, `refs/tags/${ref}^{}`],
            { env, timeoutMs: Math.min(timeoutMs, LS_REMOTE_MAX_MS) },
        );
    } catch (e) {
        if (isTimeoutError(e)) {
            throw { transportFailure: true as const, reason: 'timeout', host, hasToken } satisfies TransportFailure;
        }
        throw e;
    }
    if (res.exitCode !== 0) {
        // If the failure followed a cross-host or forbidden redirect, surface
        // it as a redirect-scope failure rather than a generic exit error.
        // The destination is parsed from git's stderr, so no pre-flight
        // network call is required.
        const redirectFailure = classifyRedirectStderr(res.stderr, repo.href, allowedHost, hasToken);
        if (redirectFailure) throw redirectFailure;
        throw { transportFailure: true as const, reason: 'exit', stderr: res.stderr, exitCode: res.exitCode, argv: baseArgs, host, hasToken } satisfies TransportFailure;
    }
    const found: ResolvedRemoteRefs = { branchSha: null, tagSha: null };
    for (const line of res.stdout.split(/\r?\n/)) {
        const tabIndex = line.indexOf('\t');
        if (tabIndex === -1) continue;
        const sha = line.slice(0, tabIndex).trim();
        if (!SHA_PATTERN.test(sha)) continue;
        const full = line.slice(tabIndex + 1).trim();
        if (full === `refs/heads/${ref}`) {
            found.branchSha = sha.toLowerCase();
        } else if (full === `refs/tags/${ref}^{}`) {
            found.tagSha = sha.toLowerCase();
        } else if (full === `refs/tags/${ref}` && found.tagSha === null) {
            found.tagSha = sha.toLowerCase();
        }
    }
    return found;
}

/** Remote fetch rounds allowed after the initial shallow tip fetch. */
const MAX_FF_FETCH_ROUNDS = 14;
/** Per-round deepen step cap for exponential backoff. */
const MAX_FF_DEEPEN_STEP = 2048;

/**
 * Whether `descendantSha` is a fast-forward from `ancestorSha` on the remote.
 * Distinguishes a normal branch advance from a force-push after ls-remote has
 * already resolved the ref to a new tip.
 *
 * Fetches the descendant tip once, then deepens that shallow boundary with
 * exponentially increasing steps until the prior commit is reachable, the
 * downloaded history is complete, or a safety budget is exhausted. Operational
 * failures throw a classified TransportFailure; only a proven non-fast-forward
 * returns false.
 */
export async function verifyFastForward(req: {
    repoUrl: string;
    ancestorSha: string;
    descendantSha: string;
    token?: string | null;
    sshAuth?: ResolveRequest['sshAuth'];
    caBundlePem?: string | null;
    timeoutMs?: number;
    workspaceRoot: string;
    maxBytes: number;
}): Promise<boolean> {
    const ancestor = req.ancestorSha.toLowerCase();
    const descendant = req.descendantSha.toLowerCase();
    if (ancestor === descendant) return true;

    const hasToken = Boolean(req.token) || Boolean(req.sshAuth);
    await ensureBinaryReady(hasToken);
    const repo = assertValidRepoUrl(req.repoUrl, hasToken);
    const host = repoHostLabel(repo);
    const timeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const deadline = Date.now() + timeoutMs;
    const remainingMs = (): number => Math.max(1, deadline - Date.now());
    const assertTimeBudget = (): void => {
        if (Date.now() >= deadline) {
            throw { transportFailure: true as const, reason: 'timeout', host, hasToken } satisfies TransportFailure;
        }
    };
    const { env, baseArgs } = await prepareInvocation(
        req.workspaceRoot, req.repoUrl, req.token, req.sshAuth, req.caBundlePem,
    );
    const repoDir = path.join(req.workspaceRoot, 'ff-check');
    await fs.mkdir(repoDir, { recursive: true });

    let sizeExceeded = false;
    let activeChild: ChildProcess | undefined;
    let breachKill: Promise<void> | undefined;
    const watchdog = startSizeWatchdog(req.workspaceRoot, req.maxBytes, () => {
        sizeExceeded = true;
        breachKill = killTree(activeChild);
    });

    const throwIfSizeExceeded = (): void => {
        if (sizeExceeded) {
            throw { transportFailure: true as const, reason: 'size', maxBytes: req.maxBytes, host: repoHostLabel(repo), hasToken } satisfies TransportFailure;
        }
    };

    try {
        const materialize = async (args: string[]): Promise<RunResult> => {
            assertTimeBudget();
            let res: RunResult;
            try {
                res = await runGit(args, {
                    cwd: repoDir,
                    env,
                    timeoutMs: remainingMs(),
                    onSpawn: (child) => { activeChild = child; },
                });
            } catch (e) {
                throwIfSizeExceeded();
                if (isTimeoutError(e)) {
                    throw { transportFailure: true as const, reason: 'timeout', host: repoHostLabel(repo), hasToken } satisfies TransportFailure;
                }
                throw { transportFailure: true as const, reason: 'exit', stderr: e instanceof Error ? e.message : String(e), argv: args, host: repoHostLabel(repo), hasToken } satisfies TransportFailure;
            }
            throwIfSizeExceeded();
            if (res.exitCode !== 0) {
                throw { transportFailure: true as const, reason: 'exit', stderr: res.stderr, exitCode: res.exitCode, argv: args, host: repoHostLabel(repo), hasToken } satisfies TransportFailure;
            }
            return res;
        };

        const probeFailure = (res: RunResult, argv: string[]): never => {
            throw {
                transportFailure: true as const,
                reason: 'exit',
                stderr: res.stderr,
                exitCode: res.exitCode,
                argv,
                host: repoHostLabel(repo),
                hasToken,
            } satisfies TransportFailure;
        };

        const runProbe = async (args: string[]): Promise<RunResult> => {
            assertTimeBudget();
            try {
                const res = await runGit(args, {
                    cwd: repoDir,
                    env,
                    timeoutMs: Math.min(remainingMs(), LS_REMOTE_MAX_MS),
                });
                throwIfSizeExceeded();
                return res;
            } catch (e) {
                throwIfSizeExceeded();
                if (isTimeoutError(e)) {
                    throw { transportFailure: true as const, reason: 'timeout', host: repoHostLabel(repo), hasToken } satisfies TransportFailure;
                }
                throw {
                    transportFailure: true as const,
                    reason: 'exit',
                    stderr: e instanceof Error ? e.message : String(e),
                    argv: args,
                    host: repoHostLabel(repo),
                    hasToken,
                } satisfies TransportFailure;
            }
        };

        const isMissingObjectProbe = (res: RunResult): boolean => {
            if (res.exitCode === 0) return false;
            if (res.exitCode === 1) return true;
            const err = res.stderr.toLowerCase();
            return err.includes('not a valid object name')
                || err.includes('bad object')
                || err.includes('could not get');
        };

        await materialize([...baseArgs, 'init']);
        await materialize([...baseArgs, 'fetch', '--depth=1', repo.href, descendant]);

        const countReachable = async (): Promise<number> => {
            const argv = [...baseArgs, 'rev-list', '--count', descendant];
            const listed = await runProbe(argv);
            if (listed.exitCode !== 0) {
                return probeFailure(listed, argv);
            }
            const parsed = Number.parseInt(listed.stdout.trim(), 10);
            if (!Number.isFinite(parsed) || parsed < 0) {
                throw {
                    transportFailure: true as const,
                    reason: 'exit',
                    stderr: `unexpected rev-list output: ${listed.stdout}`,
                    exitCode: listed.exitCode,
                    argv,
                    host: repoHostLabel(repo),
                    hasToken,
                } satisfies TransportFailure;
            }
            return parsed;
        };

        const isShallowRepository = async (): Promise<boolean> => {
            const argv = [...baseArgs, 'rev-parse', '--is-shallow-repository'];
            const shallow = await runProbe(argv);
            if (shallow.exitCode !== 0) {
                return probeFailure(shallow, argv);
            }
            const flag = shallow.stdout.trim();
            if (flag === 'true') return true;
            if (flag === 'false') return false;
            throw {
                transportFailure: true as const,
                reason: 'exit',
                stderr: `unexpected shallow-repository output: ${shallow.stdout}`,
                exitCode: shallow.exitCode,
                argv,
                host: repoHostLabel(repo),
                hasToken,
            } satisfies TransportFailure;
        };

        const isProvenAncestor = async (): Promise<boolean> => {
            const argv = [...baseArgs, 'merge-base', '--is-ancestor', ancestor, descendant];
            const ancestry = await runProbe(argv);
            if (ancestry.exitCode === 0) return true;
            if (ancestry.exitCode === 1) return false;
            return probeFailure(ancestry, argv);
        };

        let reachableCount = await countReachable();
        let fetchRounds = 1;
        let deepenStep = 1;

        const assertWithinSizeBudget = async (): Promise<void> => {
            const finalSize = await treeSize(req.workspaceRoot).catch((e: unknown) => {
                console.warn(`[GitSource:transport] final size measurement failed for ${req.workspaceRoot}, failing closed: ${e instanceof Error ? e.message : String(e)}`);
                return -1;
            });
            if (sizeExceeded || finalSize < 0 || finalSize > req.maxBytes) {
                throw { transportFailure: true as const, reason: 'size', maxBytes: req.maxBytes, host: repoHostLabel(repo), hasToken } satisfies TransportFailure;
            }
        };

        while (true) {
            assertTimeBudget();

            const ancestorArgv = [...baseArgs, 'cat-file', '-e', `${ancestor}^{commit}`];
            const hasAncestor = await runProbe(ancestorArgv);
            if (hasAncestor.exitCode === 0) {
                await assertWithinSizeBudget();
                return await isProvenAncestor();
            }
            if (!isMissingObjectProbe(hasAncestor)) {
                return probeFailure(hasAncestor, ancestorArgv);
            }

            if (!(await isShallowRepository())) {
                await assertWithinSizeBudget();
                return false;
            }

            if (fetchRounds >= MAX_FF_FETCH_ROUNDS) {
                throw { transportFailure: true as const, reason: 'timeout', host: repoHostLabel(repo), hasToken } satisfies TransportFailure;
            }

            const previousCount = reachableCount;
            await materialize([...baseArgs, 'fetch', `--deepen=${deepenStep}`, repo.href, descendant]);
            fetchRounds += 1;
            reachableCount = await countReachable();

            if (reachableCount <= previousCount) {
                if (!(await isShallowRepository())) {
                    await assertWithinSizeBudget();
                    return false;
                }
                throw { transportFailure: true as const, reason: 'timeout', host: repoHostLabel(repo), hasToken } satisfies TransportFailure;
            }

            deepenStep = Math.min(deepenStep * 2, MAX_FF_DEEPEN_STEP);
        }
    } finally {
        watchdog.stop();
        await awaitKillConfirmed(breachKill, `size-breach kill for ${repoHostLabel(repo)}`);
        await fs.rm(repoDir, { recursive: true, force: true }).catch((e: unknown) => {
            console.warn(`[GitSource:transport] failed to remove fast-forward scratch repo ${repoDir}: ${e instanceof Error ? e.message : String(e)}`);
        });
    }
}

export const nativeGitTransport: GitTransport = {
    async resolveRef(req: ResolveRequest): Promise<ResolveResult> {
        const hasToken = Boolean(req.token) || Boolean(req.sshAuth);
        await ensureBinaryReady(hasToken);
        const repo = assertValidRepoUrl(req.repoUrl, hasToken);

        if (SHA_PATTERN.test(req.ref)) {
            // A full SHA is self-resolving: the immutable identity IS the
            // value, so there is nothing to look up. Reachability is verified
            // at fetch, where the host either serves the object or refuses it
            // (classified as UNSUPPORTED_REF).
            return { commitSha: req.ref.toLowerCase(), kind: 'sha' };
        }

        assertValidRef(req.ref, repoHostLabel(repo), hasToken);

        // Compute the credential scope host for the configured repository.
        // The credential helper (see credentialHelper.ts) refuses to emit
        // credentials for any other host, but we additionally pre-classify
        // redirect-scope failures here so the operator gets a clear message
        // when git follows a redirect to a different host.
        const allowedHost = hasToken && repo.kind === 'https' ? credentialScopeHost(repo.host) : null;

        const { env, baseArgs } = await prepareInvocation(
            req.workspaceRoot, req.repoUrl, req.token, req.sshAuth, req.caBundlePem,
        );
        const found = await lsRemoteRefs(
            repo, req.ref, env, baseArgs,
            req.timeoutMs ?? DEFAULT_TIMEOUT_MS, hasToken, allowedHost,
        );
        if (found.branchSha) return { commitSha: found.branchSha, kind: 'branch' };
        if (found.tagSha) return { commitSha: found.tagSha, kind: 'tag' };
        throw { transportFailure: true as const, reason: 'ref-not-found', host: repoHostLabel(repo), hasToken } satisfies TransportFailure;
    },

    async fetchAtCommit(req: FetchRequest): Promise<FetchResult> {
        const hasToken = Boolean(req.token) || Boolean(req.sshAuth);
        await ensureBinaryReady(hasToken);
        const repo = assertValidRepoUrl(req.repoUrl, hasToken);
        assertValidRef(req.ref, repoHostLabel(repo), hasToken);

        // The credential scope host is set inside prepareInvocation via
        // GIT_ALLOWED_HOST_ENV_VAR so the credential helper refuses to emit
        // credentials for any other host. Redirects to a different host are
        // caught by classifyRedirectStderr in the failure path below.
        const { layout, env, baseArgs, allowedHost } = await prepareInvocation(
            req.workspaceRoot, req.repoUrl, req.token, req.sshAuth, req.caBundlePem,
        );
        const checkout = path.join(req.workspaceRoot, 'repo');
        const timeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUT_MS;

        // Shared between the watchdog breach flag and the active child handle:
        // whichever fires first tears the clone down; the other becomes a no-op.
        let sizeExceeded = false;
        let activeChild: ChildProcess | undefined;
        // A breach kill is subject to the same ordering hazard as a timeout
        // kill: the caller deletes this workspace as soon as we return, so the
        // kill has to be finished first, not merely issued.
        let breachKill: Promise<void> | undefined;
        const watchdog = startSizeWatchdog(req.workspaceRoot, req.maxBytes, () => {
            sizeExceeded = true;
            breachKill = killTree(activeChild);
        });

        try {
            // Run each materialization step through one failure mapper. A size
            // breach wins over the timeout wording: both kills are ours, but
            // the operator guidance differs. runGit resolves on any exit code,
            // so a non-zero exit is classified here by its real stderr rather
            // than leaking a generic GIT_ERROR upstream.
            const materialize = async (args: string[]): Promise<RunResult> => {
                let res: RunResult;
                try {
                    res = await runGit(args, {
                        cwd: layout.homeDir, env, timeoutMs,
                        onSpawn: (child) => { activeChild = child; },
                    });
                } catch (e) {
                    // A size breach wins over the timeout wording.
                    if (sizeExceeded) {
                        throw { transportFailure: true as const, reason: 'size', maxBytes: req.maxBytes, host: repoHostLabel(repo), hasToken } satisfies TransportFailure;
                    }
                    if (isTimeoutError(e)) {
                        throw { transportFailure: true as const, reason: 'timeout', host: repoHostLabel(repo), hasToken } satisfies TransportFailure;
                    }
                    // Non-zero exit may follow a redirect. Check stderr for
                    // redirect-scope failures before reporting a generic exit error.
                    const redirectFailureCatch = classifyRedirectStderr(
                        e instanceof Error ? e.message : String(e), repo.href, allowedHost, hasToken,
                    );
                    if (redirectFailureCatch) throw redirectFailureCatch;
                    throw { transportFailure: true as const, reason: 'exit', stderr: e instanceof Error ? e.message : String(e), argv: args, host: repoHostLabel(repo), hasToken } satisfies TransportFailure;
                }
                // A watchdog-triggered SIGKILL settles runGit's promise via the
                // child's normal 'close' event (code null -> exitCode -1), not
                // a rejection, so this is the common path for an in-flight
                // breach and must check sizeExceeded before the generic mapping.
                if (sizeExceeded) {
                    throw { transportFailure: true as const, reason: 'size', maxBytes: req.maxBytes, host: repoHostLabel(repo), hasToken } satisfies TransportFailure;
                }
                if (res.exitCode !== 0) {
                    // Non-zero exit may follow a redirect. Check stderr for
                    // redirect-scope failures before reporting a generic exit error.
                    const redirectFailureExit = classifyRedirectStderr(res.stderr, repo.href, allowedHost, hasToken);
                    if (redirectFailureExit) throw redirectFailureExit;
                    throw { transportFailure: true as const, reason: 'exit', stderr: res.stderr, exitCode: res.exitCode, argv: args, host: repoHostLabel(repo), hasToken } satisfies TransportFailure;
                }
                return res;
            };

            if (req.refKind === 'sha') {
                // `--branch` cannot take a bare SHA, so a pinned commit uses a
                // third strategy: init a repo, fetch exactly that object, and
                // check it out detached. The host must allow fetching a direct
                // SHA (GitHub does by default); a refusal surfaces as a
                // non-zero `git fetch` here and classifies as UNSUPPORTED_REF.
                await materialize([...baseArgs, 'init', checkout]);
                await materialize([...baseArgs, '-C', checkout, 'fetch', '--depth=1', repo.href, req.ref]);
                await materialize([...baseArgs, '-C', checkout, 'checkout', '--detach', req.ref]);
            } else {
                // A bare name works for both branches and tags: `--branch`
                // detaches at the named ref's commit either way, and passing a
                // fully-qualified `refs/tags/<ref>` is rejected by git
                // (`Remote branch ... not found`). The resolved kind is
                // already pinned by ls-remote, and the rev-parse HEAD
                // verification below confirms the checkout matched it.
                const branchArg = req.ref;
                await materialize([
                    ...baseArgs, 'clone',
                    '--depth=1', '--single-branch', '--no-tags', '--no-recurse-submodules',
                    '--branch', branchArg, repo.href, checkout,
                ]);
            }

            let actual: string;
            try {
                const head = await runGit([...baseArgs, 'rev-parse', 'HEAD'], {
                    cwd: checkout,
                    env,
                    timeoutMs: Math.min(timeoutMs, LS_REMOTE_MAX_MS),
                });
                actual = head.stdout.trim().toLowerCase();
                if (!SHA_PATTERN.test(actual)) {
                    throw { transportFailure: true as const, reason: 'exit', stderr: `unexpected rev-parse output: ${head.stdout}`, exitCode: head.exitCode, host: repoHostLabel(repo), hasToken } satisfies TransportFailure;
                }
            } catch (e) {
                if (isTransportFailure(e)) throw e;
                if (isTimeoutError(e)) {
                    throw { transportFailure: true as const, reason: 'timeout', host: repoHostLabel(repo), hasToken } satisfies TransportFailure;
                }
                throw { transportFailure: true as const, reason: 'exit', stderr: e instanceof Error ? e.message : String(e), host: repoHostLabel(repo), hasToken } satisfies TransportFailure;
            }

            if (actual !== req.commitSha.toLowerCase()) {
                // The branch tip moved between resolution and fetch. Refuse
                // rather than materialize content nobody reviewed.
                throw { transportFailure: true as const, reason: 'tip-changed', host: repoHostLabel(repo), hasToken } satisfies TransportFailure;
            }

            // Deterministic final measure: a breach landing between the last
            // watchdog tick and successful verification must not slip through
            // as an over-cap success. A read failure here (permissions,
            // workspace removed mid-walk) must fail closed rather than treat
            // an unmeasurable workspace as within budget.
            const finalSize = await treeSize(req.workspaceRoot).catch((e: unknown) => {
                console.warn(`[GitSource:transport] final size measurement failed for ${req.workspaceRoot}, failing closed: ${e instanceof Error ? e.message : String(e)}`);
                return -1;
            });
            if (sizeExceeded || finalSize < 0 || finalSize > req.maxBytes) {
                throw { transportFailure: true as const, reason: 'size', maxBytes: req.maxBytes, host: repoHostLabel(repo), hasToken } satisfies TransportFailure;
            }

            return { commitSha: actual, dir: checkout };
        } finally {
            watchdog.stop();
            await awaitKillConfirmed(breachKill, `size-breach kill for ${repoHostLabel(repo)}`);
        }
    },
};
