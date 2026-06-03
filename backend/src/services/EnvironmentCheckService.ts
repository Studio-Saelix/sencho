/**
 * First-run / preflight environment checks shared by the setup wizard's final
 * step and the admin Recovery settings tab. Where DiagnosticsService answers
 * "is my install broken" (and runs without Docker), this answers "can my
 * install actually run Docker deploys": is the Docker socket reachable and
 * permitted, is `docker compose` v2 present, is the compose directory writable
 * and mounted at the same path on host and container, is the dashboard behind
 * TLS, and is there disk headroom.
 *
 * The mapping from raw probe results to check rows is kept pure and the IO is
 * injected (see `EnvironmentProbes` / `buildRealProbes`), so the verdict logic
 * is unit-testable without a live Docker daemon or filesystem. No probe failure
 * throws out of the report: it degrades to a non-throwing row whose status fits
 * the check. The Docker socket and compose-directory probes surface a `fail`;
 * an unreadable disk degrades to a `warn` rather than a false `pass`. A missing
 * container self-inspect reads as "not containerized" (a `pass`), since that is
 * the common case and Sencho cannot prove a mapping it cannot see.
 */
import fs from 'fs/promises';
import { constants as fsConstants } from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import si from 'systeminformation';
import DockerController from './DockerController';
import { NodeRegistry } from './NodeRegistry';
import SelfIdentityService from './SelfIdentityService';
import { withTimeout } from '../utils/withTimeout';

const execFileAsync = promisify(execFile);

const DOCKER_PING_TIMEOUT_MS = 2000;
const COMPOSE_VERSION_TIMEOUT_MS = 5000;
const DISK_WARN_USE_PERCENT = 90;
const DISK_WARN_FREE_BYTES = 2 * 1024 * 1024 * 1024; // 2 GiB

export type CheckStatus = 'pass' | 'warn' | 'fail';

export type CheckId =
    | 'docker_socket'
    | 'docker_compose'
    | 'compose_dir'
    | 'path_mapping'
    | 'tls'
    | 'disk_space';

interface CheckBase {
    id: CheckId;
    label: string;
    detail: string;
}

// A pass row carries no remediation; a warn / fail row must carry one. Modelling
// this as a discriminated union makes "every actionable verdict ships a fix" a
// compile-time guarantee instead of a convention a future check could forget.
export type EnvironmentCheck =
    | (CheckBase & { status: 'pass' })
    | (CheckBase & { status: 'warn' | 'fail'; remediation: string });

export interface EnvironmentReport {
    checks: EnvironmentCheck[];
    generatedAt: number;
}

export interface DirAccess {
    exists: boolean;
    isDir: boolean;
    writable: boolean;
}

export interface DiskUsage {
    usePercent: number;
    freeBytes: number;
}

/**
 * Injected IO for the checks. The route wires `buildRealProbes`; tests pass
 * stubs. `proto` / `host` come from the request so the TLS check reflects how
 * the operator's browser actually reached the dashboard.
 */
export interface EnvironmentProbes {
    proto: string;
    host: string;
    composeDir: string;
    /** Resolves when the Docker daemon answers a ping; rejects (with `.code`) otherwise. */
    pingDocker: () => Promise<void>;
    /** Resolves the `docker compose` version string; rejects when the plugin is absent. */
    composeVersion: () => Promise<string>;
    accessDir: (dir: string) => Promise<DirAccess>;
    /** Bind mounts on the Sencho container, or null when not containerized. */
    bindMounts: () => Promise<Array<{ source: string; destination: string }> | null>;
    /** Disk usage of the filesystem backing the compose dir, or null when unknown. */
    diskUsage: (dir: string) => Promise<DiskUsage | null>;
}

function isLoopbackHost(host: string): boolean {
    // Strip the port; IPv6 literals arrive bracketed (`[::1]:1852`).
    const name = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase();
    return name === 'localhost' || name === '127.0.0.1' || name === '::1' || name === '';
}

// Normalize for path comparison: drop a single trailing slash so
// `/app/compose` and `/app/compose/` compare equal.
function normPath(p: string): string {
    return p.length > 1 ? p.replace(/[/\\]+$/, '') : p;
}

async function checkDockerSocket(probe: EnvironmentProbes['pingDocker']): Promise<EnvironmentCheck> {
    const base = { id: 'docker_socket' as const, label: 'Docker engine' };
    try {
        await probe();
        return { ...base, status: 'pass', detail: 'The Docker daemon is reachable.' };
    } catch (err) {
        const code = (err as { code?: string })?.code;
        if (code === 'EACCES' || code === 'EPERM') {
            return {
                ...base,
                status: 'fail',
                detail: 'Permission denied talking to the Docker socket.',
                remediation:
                    'Sencho cannot read /var/run/docker.sock. Mount the socket into the container '
                    + '(-v /var/run/docker.sock:/var/run/docker.sock) and make sure Sencho runs as a '
                    + 'user in the docker group, or with access to the socket.',
            };
        }
        return {
            ...base,
            status: 'fail',
            detail: 'The Docker daemon is not reachable.',
            remediation:
                'Confirm Docker is running on the host and that /var/run/docker.sock is mounted into '
                + 'the Sencho container (-v /var/run/docker.sock:/var/run/docker.sock).',
        };
    }
}

async function checkDockerCompose(probe: EnvironmentProbes['composeVersion']): Promise<EnvironmentCheck> {
    const base = { id: 'docker_compose' as const, label: 'Docker Compose' };
    try {
        const version = (await probe()).trim();
        return { ...base, status: 'pass', detail: version ? `Compose ${version} is available.` : 'Compose is available.' };
    } catch (err) {
        // A timeout (slow / busy daemon) is not the same as an absent plugin, so
        // it must not produce the confident "install the plugin" remediation,
        // which would send the operator down the wrong path.
        const e = err as { code?: string; killed?: boolean; signal?: string | null };
        if (e.killed || e.signal != null || e.code === 'ETIMEDOUT') {
            return {
                ...base,
                status: 'warn',
                detail: 'Could not verify the Compose version in time.',
                remediation:
                    'The `docker compose version` check timed out, usually a slow or busy Docker daemon. '
                    + 'Re-run once the host settles; if it keeps timing out, check daemon health.',
            };
        }
        return {
            ...base,
            status: 'fail',
            detail: 'The Docker Compose v2 plugin was not found.',
            remediation:
                'Install the Docker Compose v2 plugin so `docker compose version` succeeds. The official '
                + 'Docker images bundle it; on a bare host, install the docker-compose-plugin package.',
        };
    }
}

function checkComposeDir(dir: string, access: DirAccess): EnvironmentCheck {
    const base = { id: 'compose_dir' as const, label: 'Compose directory' };
    if (!access.exists) {
        return {
            ...base,
            status: 'fail',
            detail: `${dir} does not exist.`,
            remediation: `Create ${dir} on the host and mount it into Sencho, or point COMPOSE_DIR at an existing mounted directory.`,
        };
    }
    if (!access.isDir) {
        return {
            ...base,
            status: 'fail',
            detail: `${dir} exists but is not a directory.`,
            remediation: `Remove the file at ${dir} or point COMPOSE_DIR at a directory.`,
        };
    }
    if (!access.writable) {
        return {
            ...base,
            status: 'fail',
            detail: `${dir} is not writable.`,
            remediation: `Grant the user Sencho runs as write access to ${dir} so it can author and update compose files.`,
        };
    }
    return { ...base, status: 'pass', detail: `${dir} is present and writable.` };
}

function checkPathMapping(
    dir: string,
    mounts: Array<{ source: string; destination: string }> | null,
): EnvironmentCheck {
    const base = { id: 'path_mapping' as const, label: 'Path mapping' };
    if (mounts === null) {
        return {
            ...base,
            status: 'pass',
            detail: 'Sencho is not running in a container; host and container paths are the same.',
        };
    }
    const target = normPath(dir);
    const match = mounts.find(m => normPath(m.destination) === target);
    if (!match) {
        return {
            ...base,
            status: 'warn',
            detail: `${dir} is not a host bind mount.`,
            remediation:
                `Bind-mount the compose directory from the host at the same path, e.g. `
                + `-v ${dir}:${dir}. Without it, relative bind mounts in your stacks resolve against `
                + `the container filesystem instead of the host.`,
        };
    }
    if (normPath(match.source) !== target) {
        return {
            ...base,
            status: 'warn',
            detail: `Host path ${match.source} is mounted at ${match.destination}.`,
            remediation:
                `Mount the compose directory at the same path on host and container, e.g. `
                + `-v ${dir}:${dir}. A mismatch breaks relative bind mounts in your stacks, because the `
                + `daemon resolves them against the host path Sencho never sees.`,
        };
    }
    return { ...base, status: 'pass', detail: `Mounted 1:1 at ${dir}.` };
}

function checkTls(proto: string, host: string): EnvironmentCheck {
    const base = { id: 'tls' as const, label: 'TLS' };
    if (proto === 'https' || isLoopbackHost(host)) {
        return { ...base, status: 'pass', detail: proto === 'https' ? 'Reached over HTTPS.' : 'Reached over a loopback address.' };
    }
    return {
        ...base,
        status: 'warn',
        detail: `Reached over plain HTTP at ${host}.`,
        remediation:
            'Put Sencho behind a reverse proxy that terminates TLS (Caddy, Traefik, nginx) before exposing '
            + 'it beyond localhost. Credentials and session cookies travel in clear text over plain HTTP.',
    };
}

function checkDisk(dir: string, usage: DiskUsage | null): EnvironmentCheck {
    const base = { id: 'disk_space' as const, label: 'Disk space' };
    if (!usage) {
        // Unknown is not healthy: on a preflight surface a green check would
        // tell the operator there is headroom that was never measured.
        return {
            ...base,
            status: 'warn',
            detail: 'Disk usage could not be determined.',
            remediation:
                'Sencho could not read host filesystem stats. An unknown disk state is not a guarantee of '
                + 'free space, so confirm the compose volume has headroom before deploying.',
        };
    }
    const freeGiB = (usage.freeBytes / (1024 * 1024 * 1024)).toFixed(1);
    if (usage.usePercent >= DISK_WARN_USE_PERCENT || usage.freeBytes < DISK_WARN_FREE_BYTES) {
        return {
            ...base,
            status: 'warn',
            detail: `${usage.usePercent.toFixed(0)}% used, ${freeGiB} GiB free on the compose volume.`,
            remediation:
                'Free up disk space before deploying. Pull and build steps fail partway through on a full '
                + 'volume; prune unused images and volumes from Settings or the host.',
        };
    }
    return { ...base, status: 'pass', detail: `${usage.usePercent.toFixed(0)}% used, ${freeGiB} GiB free.` };
}

// Each probe is awaited inside its check builder's own try/catch (or returns a
// degraded row), so one failing probe never rejects the whole report.
export async function collectEnvironmentReport(probes: EnvironmentProbes): Promise<EnvironmentReport> {
    const logProbeFailure = (label: string) => (e: unknown) => {
        console.warn(`[env-check] ${label} probe failed: ${(e as Error)?.message ?? String(e)}`);
    };
    const [socket, compose, access, mounts, disk] = await Promise.all([
        checkDockerSocket(probes.pingDocker),
        checkDockerCompose(probes.composeVersion),
        probes.accessDir(probes.composeDir).then(
            a => a,
            (e): DirAccess => { logProbeFailure('accessDir')(e); return { exists: false, isDir: false, writable: false }; },
        ),
        probes.bindMounts().then(m => m, (e) => { logProbeFailure('bindMounts')(e); return null; }),
        probes.diskUsage(probes.composeDir).then(d => d, (e) => { logProbeFailure('diskUsage')(e); return null; }),
    ]);

    const checks: EnvironmentCheck[] = [
        socket,
        compose,
        checkComposeDir(probes.composeDir, access),
        checkPathMapping(probes.composeDir, mounts),
        checkTls(probes.proto, probes.host),
        checkDisk(probes.composeDir, disk),
    ];

    return { checks, generatedAt: Date.now() };
}

async function realAccessDir(dir: string): Promise<DirAccess> {
    try {
        const stat = await fs.stat(dir);
        if (!stat.isDirectory()) return { exists: true, isDir: false, writable: false };
        try {
            await fs.access(dir, fsConstants.W_OK);
            return { exists: true, isDir: true, writable: true };
        } catch {
            return { exists: true, isDir: true, writable: false };
        }
    } catch {
        return { exists: false, isDir: false, writable: false };
    }
}

/**
 * Choose the filesystem backing `dir` from a `systeminformation` fsSize list:
 * the mount that is the longest path prefix of `dir` (so a dedicated compose
 * volume wins over the root mount), then `/` or `C:`, then the first entry.
 * Exported for unit testing the selection without a live filesystem.
 */
export function pickBackingMount(
    sizes: Array<{ mount: string; use?: number; available?: number }>,
    dir: string,
): DiskUsage | null {
    if (sizes.length === 0) return null;
    const target = normPath(dir);
    const backing = sizes
        .filter(s => {
            const m = normPath(s.mount);
            return target === m || target.startsWith(m + '/') || target.startsWith(m + '\\');
        })
        .sort((a, b) => b.mount.length - a.mount.length)[0]
        ?? sizes.find(s => s.mount === '/' || s.mount === 'C:')
        ?? sizes[0];
    if (!backing) return null;
    return { usePercent: backing.use ?? 0, freeBytes: backing.available ?? 0 };
}

async function realDiskUsage(dir: string): Promise<DiskUsage | null> {
    return pickBackingMount(await si.fsSize(), dir);
}

/**
 * Wire the real IO for the checks. Called by the diagnostics route; tests build
 * `EnvironmentProbes` directly with stubs.
 */
export function buildRealProbes(opts: { proto: string; host: string }): EnvironmentProbes {
    const composeDir = NodeRegistry.getInstance().getComposeDir(NodeRegistry.getInstance().getDefaultNodeId());
    return {
        proto: opts.proto,
        host: opts.host,
        composeDir,
        pingDocker: async () => {
            await withTimeout(DockerController.getInstance().getDocker().ping(), DOCKER_PING_TIMEOUT_MS, 'docker-ping');
        },
        composeVersion: async () => {
            const { stdout } = await execFileAsync('docker', ['compose', 'version', '--short'], { timeout: COMPOSE_VERSION_TIMEOUT_MS });
            return stdout;
        },
        accessDir: realAccessDir,
        bindMounts: () => SelfIdentityService.getInstance().getBindMounts(),
        diskUsage: realDiskUsage,
    };
}
