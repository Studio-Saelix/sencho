import { createHash } from 'crypto';
import { spawn } from 'child_process';
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
        ? `${user}@${url.hostname}:${pathname}`
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

const DEPLOY_KEY_PEM_HEADER = /^-----BEGIN (?:OPENSSH )?PRIVATE KEY-----$/;
const DEPLOY_KEY_PEM_FOOTER = /^-----END (?:OPENSSH )?PRIVATE KEY-----$/;

/** Rebuild a deploy key PEM from validated envelope and base64 body lines only. */
export function canonicalizeDeployKeyPem(raw: string): string {
    const lines = raw.replace(/\r\n/g, '\n').trim().split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
    if (lines.length < 3) {
        throw new Error('deploy key is invalid');
    }
    const header = lines[0];
    const footer = lines[lines.length - 1];
    if (!DEPLOY_KEY_PEM_HEADER.test(header) || !DEPLOY_KEY_PEM_FOOTER.test(footer)) {
        throw new Error('deploy key is invalid');
    }
    const bodyLines = lines.slice(1, -1);
    for (const bodyLine of bodyLines) {
        if (!/^[A-Za-z0-9+/=]+$/.test(bodyLine)) {
            throw new Error('deploy key is invalid');
        }
    }
    return `${header}\n${bodyLines.join('\n')}\n${footer}\n`;
}

function canonicalizeKnownHostsLine(line: string): string {
    const material = keyMaterialFromKnownHostsLine(line);
    if (!material) {
        throw new Error('known_hosts entry is invalid');
    }
    try {
        Buffer.from(material.keyBase64, 'base64');
    } catch {
        throw new Error('known_hosts entry is invalid');
    }
    const parts = line.trim().split(/\s+/);
    let keyTypeIdx = -1;
    for (let i = 0; i < parts.length - 1; i += 1) {
        if (isSshKeyType(parts[i])) {
            keyTypeIdx = i;
            break;
        }
    }
    if (keyTypeIdx < 1) {
        throw new Error('known_hosts entry is invalid');
    }
    const hostPart = parts.slice(0, keyTypeIdx).join(' ');
    return `${hostPart} ${material.keyType} ${material.keyBase64}`;
}

/** Rebuild known_hosts content from parsed host markers and key material only. */
export function canonicalizeKnownHostsEntry(raw: string): string {
    const lines = raw.trim().split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('#'));
    if (lines.length === 0) {
        throw new Error('known_hosts entry is empty');
    }
    return `${lines.map(canonicalizeKnownHostsLine).join('\n')}\n`;
}

export interface ScannedHostKey {
    keyType: string;
    fingerprint: string;
    line: string;
}

function runSshKeyscan(address: string, port: number): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    return new Promise((resolve, reject) => {
        const args = port === DEFAULT_SSH_PORT
            ? [address]
            : ['-p', String(port), address];
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
export async function scanHostKeys(host: string, port: number, address: string): Promise<ScannedHostKey[]> {
    const result = await runSshKeyscan(address, port);
    if (result.exitCode !== 0 && !result.stdout.trim()) {
        throw new Error(result.stderr.trim() || 'ssh-keyscan failed');
    }
    const keys: ScannedHostKey[] = [];
    for (const line of result.stdout.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const material = keyMaterialFromKnownHostsLine(trimmed);
        if (!material) continue;
        const knownHost = port === DEFAULT_SSH_PORT ? host : `[${host}]:${port}`;
        const knownHostsLine = `${knownHost} ${material.keyType} ${material.keyBase64}`;
        const fingerprint = fingerprintFromKnownHostsLine(knownHostsLine);
        if (!fingerprint) continue;
        keys.push({ keyType: material.keyType, fingerprint, line: knownHostsLine });
    }
    if (keys.length === 0) {
        throw new Error('No host keys returned from ssh-keyscan');
    }
    return keys;
}

/**
 * Build GIT_SSH_COMMAND / core.sshCommand value enforcing strict host-key
 * checking against our per-fetch known_hosts file and a single deploy key.
 */
function shellQuote(value: string): string {
    return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export function buildSshCommand(
    keyPath: string,
    knownHostsPath: string,
    target: { address: string; hostKeyAlias: string },
): string {
    const key = keyPath.split(path.sep).join('/');
    const known = knownHostsPath.split(path.sep).join('/');
    const args = [
        'ssh',
        '-o BatchMode=yes',
        '-o StrictHostKeyChecking=yes',
        `-o ${shellQuote(`UserKnownHostsFile=${known}`)}`,
        '-o IdentitiesOnly=yes',
        '-o IdentityAgent=none',
        '-F /dev/null',
        `-i ${shellQuote(key)}`,
    ];
    args.push(`-o ${shellQuote(`Hostname=${target.address}`)}`);
    args.push(`-o ${shellQuote(`HostKeyAlias=${target.hostKeyAlias}`)}`);
    return args.join(' ');
}
