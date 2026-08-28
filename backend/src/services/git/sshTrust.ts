import { createHash } from 'crypto';
import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import path from 'path';

/** Parsed SSH repository target for transport and host-key trust. */
export interface ParsedSshRepoUrl {
    /** URL string passed to git (scp-style or ssh://). */
    href: string;
    host: string;
    port: number;
    pathname: string;
}

const DEFAULT_SSH_PORT = 22;
const SCP_URL_PATTERN = /^([^@\s/]+)@([^:\s]+):(.+)$/;
const KNOWN_HOSTS_SCAN_TIMEOUT_MS = 15_000;

function normalizePathname(pathname: string): string {
    const trimmed = pathname.trim();
    if (!trimmed.startsWith('/')) return `/${trimmed}`;
    return trimmed;
}

/**
 * Parse scp-style `git@host:org/repo.git` URLs. Git accepts these directly;
 * ssh:// is used when a nonstandard port is required.
 */
export function parseSshScpUrl(raw: string): ParsedSshRepoUrl | null {
    const trimmed = raw.trim();
    const match = SCP_URL_PATTERN.exec(trimmed);
    if (!match) return null;
    const user = match[1];
    const hostPart = match[2];
    const repoPath = match[3].trim();
    if (!user || !hostPart || !repoPath || repoPath.includes('..')) return null;
    const colon = hostPart.lastIndexOf(':');
    let host = hostPart;
    let port = DEFAULT_SSH_PORT;
    if (colon > 0 && colon < hostPart.length - 1) {
        const portText = hostPart.slice(colon + 1);
        const parsedPort = Number.parseInt(portText, 10);
        if (!Number.isFinite(parsedPort) || parsedPort < 1 || parsedPort > 65535) return null;
        host = hostPart.slice(0, colon);
        port = parsedPort;
    }
    if (!host) return null;
    const pathname = normalizePathname(repoPath);
    const href = port === DEFAULT_SSH_PORT
        ? `${user}@${host}:${repoPath}`
        : `ssh://${user}@${host}:${port}${pathname}`;
    return { href, host, port, pathname };
}

export function parseSshUrl(raw: string): ParsedSshRepoUrl | null {
    const trimmed = raw.trim();
    let url: URL;
    try {
        url = new URL(trimmed);
    } catch {
        return parseSshScpUrl(trimmed);
    }
    if (url.protocol !== 'ssh:') return null;
    if (!url.hostname || url.username === '' || url.password !== '') return null;
    if (url.search !== '' || url.hash !== '') return null;
    const port = url.port ? Number.parseInt(url.port, 10) : DEFAULT_SSH_PORT;
    if (!Number.isFinite(port) || port < 1 || port > 65535) return null;
    const pathname = normalizePathname(url.pathname);
    if (pathname === '/' || pathname.includes('..')) return null;
    const user = url.username;
    const href = port === DEFAULT_SSH_PORT
        ? `${user}@${url.hostname}:${pathname.slice(1)}`
        : `ssh://${user}@${url.hostname}:${port}${pathname}`;
    return { href, host: url.hostname, port, pathname };
}

export type RepoTransportKind = 'https' | 'ssh';

export interface ParsedRepoUrl {
    kind: RepoTransportKind;
    href: string;
    host: string;
    port?: number;
    pathname: string;
}

export function parseRepoTransportUrl(raw: string): ParsedRepoUrl | null {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    let https: URL;
    try {
        https = new URL(trimmed);
    } catch {
        https = null as unknown as URL;
    }
    if (https && https.protocol === 'https:' && https.hostname && !https.username && !https.password
        && https.search === '' && https.hash === '') {
        return {
            kind: 'https',
            href: https.href,
            host: https.host,
            pathname: https.pathname,
        };
    }
    const ssh = parseSshUrl(trimmed);
    if (!ssh) return null;
    return {
        kind: 'ssh',
        href: ssh.href,
        host: ssh.host,
        port: ssh.port,
        pathname: ssh.pathname,
    };
}

/** SHA256 fingerprint in OpenSSH display form (`SHA256:...`). */
export function fingerprintFromKnownHostsLine(line: string): string | null {
    const material = keyMaterialFromKnownHostsLine(line);
    if (!material) return null;
    try {
        const digest = createHash('sha256').update(Buffer.from(material.keyBase64, 'base64')).digest('base64');
        return `SHA256:${digest.replace(/=+$/, '')}`;
    } catch {
        return null;
    }
}

function isSshKeyType(token: string): boolean {
    return token.startsWith('ssh-') || token.startsWith('ecdsa-') || token.startsWith('sk-');
}

function keyMaterialFromKnownHostsLine(line: string): { keyType: string; keyBase64: string } | null {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return null;
    const parts = trimmed.split(/\s+/);
    if (parts.length < 3) return null;
    for (let i = 0; i < parts.length - 1; i += 1) {
        if (isSshKeyType(parts[i])) {
            return { keyType: parts[i], keyBase64: parts[i + 1] };
        }
    }
    return null;
}

export interface ScannedHostKey {
    keyType: string;
    fingerprint: string;
    line: string;
}

function runSshKeyscan(host: string, port: number): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    return new Promise((resolve, reject) => {
        const args = port === DEFAULT_SSH_PORT
            ? ['-H', host]
            : ['-p', String(port), '-H', host];
        const child = spawn('ssh-keyscan', args, { windowsHide: true });
        let stdout = '';
        let stderr = '';
        child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
        child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
        const timer = setTimeout(() => {
            child.kill('SIGKILL');
        }, KNOWN_HOSTS_SCAN_TIMEOUT_MS);
        child.on('error', (err) => {
            clearTimeout(timer);
            reject(err);
        });
        child.on('close', (code) => {
            clearTimeout(timer);
            resolve({ stdout, stderr, exitCode: code ?? -1 });
        });
    });
}

/** Fetch host keys from the server without trusting them (probe step only). */
export async function scanHostKeys(host: string, port: number): Promise<ScannedHostKey[]> {
    const result = await runSshKeyscan(host, port);
    if (result.exitCode !== 0 && !result.stdout.trim()) {
        throw new Error(result.stderr.trim() || 'ssh-keyscan failed');
    }
    const keys: ScannedHostKey[] = [];
    for (const line of result.stdout.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const fingerprint = fingerprintFromKnownHostsLine(trimmed);
        if (!fingerprint) continue;
        const material = keyMaterialFromKnownHostsLine(trimmed);
        const keyType = material?.keyType ?? 'unknown';
        keys.push({ keyType, fingerprint, line: trimmed });
    }
    if (keys.length === 0) {
        throw new Error('No host keys returned from ssh-keyscan');
    }
    return keys;
}

export async function writeDeployKey(metaDir: string, pem: string): Promise<string> {
    const keyPath = path.join(metaDir, 'deploy-key');
    await fs.writeFile(keyPath, pem.endsWith('\n') ? pem : `${pem}\n`, { mode: 0o600 });
    return keyPath.split(path.sep).join('/');
}

export async function writeKnownHosts(metaDir: string, entry: string): Promise<string> {
    const knownHostsPath = path.join(metaDir, 'known_hosts');
    const normalized = entry.trim().split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith('#')).join('\n');
    if (!normalized) {
        throw new Error('known_hosts entry is empty');
    }
    await fs.writeFile(knownHostsPath, `${normalized}\n`, { mode: 0o600 });
    return knownHostsPath.split(path.sep).join('/');
}

/**
 * Build GIT_SSH_COMMAND / core.sshCommand value enforcing strict host-key
 * checking against our per-fetch known_hosts file and a single deploy key.
 */
export function buildSshCommand(keyPath: string, knownHostsPath: string): string {
    const key = keyPath.split(path.sep).join('/');
    const known = knownHostsPath.split(path.sep).join('/');
    return [
        'ssh',
        '-o', 'BatchMode=yes',
        '-o', 'StrictHostKeyChecking=yes',
        '-o', 'UserKnownHostsFile=' + known,
        '-o', 'IdentitiesOnly=yes',
        '-o', 'IdentityAgent=none',
        '-F', '/dev/null',
        '-i', key,
    ].join(' ');
}
