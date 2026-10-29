import fs from 'fs';
import tls from 'tls';
import { X509Certificate } from 'crypto';

/**
 * Operator configuration for the central → remote proxy-mode mesh dial.
 *
 * `SENCHO_MESH_PROXY_HEADERS` adds HTTP headers to the WebSocket upgrade,
 * for gateways in front of a remote Sencho that need their own credential
 * (for example Cloudflare Access service tokens). JSON, either one map for
 * every node:
 *   {"CF-Access-Client-Id": "...", "CF-Access-Client-Secret": "..."}
 * or maps keyed by node name, with "*" as the fallback:
 *   {"*": {...}, "edge": {...}}
 *
 * `SENCHO_MESH_PROXY_CA_FILE` points at a PEM bundle trusted in addition to
 * the default roots, for remotes whose TLS chain uses a private CA. Only the
 * mesh dial consumes it; see docs/features/sencho-mesh.mdx for the
 * fleet-management trust option.
 *
 * Both settings are loaded by the dialer on the first proxy-mode dial and
 * kept for the process once a load succeeds; a failed load is retried on the
 * next dial. Changing a loaded configuration needs a restart.
 */
export const MESH_PROXY_HEADERS_ENV = 'SENCHO_MESH_PROXY_HEADERS';
export const MESH_PROXY_CA_FILE_ENV = 'SENCHO_MESH_PROXY_CA_FILE';

/**
 * Headers Sencho owns on the upgrade. Overriding them would break the
 * WebSocket handshake or the remote's authentication, so config naming
 * them is rejected.
 */
const RESERVED_HEADERS = new Set([
    'authorization',
    'host',
    'connection',
    'upgrade',
    'content-length',
    'transfer-encoding',
    'x-sencho-tier',
]);

export class MeshProxyDialConfigError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'MeshProxyDialConfigError';
    }
}

export interface MeshProxyDialConfig {
    /** Extra upgrade headers for the node with this name. */
    headersFor(nodeName: string | undefined): Record<string, string>;
    /** Default roots plus the configured bundle, or undefined for defaults alone. */
    ca?: string[];
}

function validateHeaderMap(raw: unknown, where: string): Record<string, string> {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new MeshProxyDialConfigError(`${MESH_PROXY_HEADERS_ENV}: ${where} must be an object of header names to string values`);
    }
    const out: Record<string, string> = {};
    for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
        if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(name)) {
            throw new MeshProxyDialConfigError(`${MESH_PROXY_HEADERS_ENV}: invalid header name in ${where}`);
        }
        const lower = name.toLowerCase();
        if (RESERVED_HEADERS.has(lower) || lower.startsWith('sec-websocket-')) {
            throw new MeshProxyDialConfigError(`${MESH_PROXY_HEADERS_ENV}: header "${name}" is managed by Sencho and cannot be set`);
        }
        // Node's outgoing header validator accepts only HTAB, printable
        // ASCII, and Latin-1 (U+0080-U+00FF). Anything else fails later at
        // request construction, where the operator would see "remote
        // unreachable" instead of the real configuration problem. CR and LF
        // are the obvious injection risk; the rest are equally illegal.
        if (typeof value !== 'string' || /[\u0000-\u001F\u007F\u0100-\uFFFF]/.test(value)) {
            throw new MeshProxyDialConfigError(
                `${MESH_PROXY_HEADERS_ENV}: header "${name}" in ${where} must be a single-line string without control characters or characters above U+00FF`,
            );
        }
        out[name] = value;
    }
    return out;
}

function parseHeaders(raw: string | undefined): (nodeName: string | undefined) => Record<string, string> {
    if (!raw || !raw.trim()) return () => ({});
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        throw new MeshProxyDialConfigError(`${MESH_PROXY_HEADERS_ENV} is not valid JSON`);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new MeshProxyDialConfigError(`${MESH_PROXY_HEADERS_ENV} must be a JSON object`);
    }
    const values = Object.values(parsed as Record<string, unknown>);
    const perNode = values.length > 0 && values.every((v) => v !== null && typeof v === 'object');
    if (!perNode) {
        const all = validateHeaderMap(parsed, 'the header map');
        return () => ({ ...all });
    }
    const maps = new Map<string, Record<string, string>>();
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        maps.set(key, validateHeaderMap(value, key === '*' ? 'the "*" entry' : `the entry for node "${key}"`));
    }
    return (nodeName) => ({ ...((nodeName !== undefined && maps.get(nodeName)) || maps.get('*') || {}) });
}

function defaultTrustAnchors(): string[] {
    // Node >= 22.15 exposes the effective default set (bundled roots plus
    // NODE_EXTRA_CA_CERTS). Passing `ca` replaces that set, so rebuild it.
    const getCa = (tls as unknown as { getCACertificates?: (type?: string) => string[] }).getCACertificates;
    if (typeof getCa === 'function') return getCa('default');
    const anchors = [...tls.rootCertificates];
    const extra = process.env.NODE_EXTRA_CA_CERTS?.trim();
    if (extra) {
        try { anchors.push(fs.readFileSync(extra, 'utf8')); } catch { /* Node already warned at startup */ }
    }
    return anchors;
}

/**
 * Reject a bundle Node's TLS layer would silently accept but never use: a
 * truncated block, a block whose base64 is not a certificate, or stray
 * markers. `tls.createSecureContext` accepts such strings when default roots
 * are present, so validating with `X509Certificate` is the only way the
 * operator learns about a corrupt CA file at configuration time instead of
 * seeing every node fail later with a TLS error.
 *
 * Text outside certificate blocks is allowed: exported bundles and keytool
 * output carry comments between the certificates.
 */
function validateCaBundle(pem: string, source: string): void {
    const blocks = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) ?? [];
    if (blocks.length === 0) {
        throw new MeshProxyDialConfigError(`${MESH_PROXY_CA_FILE_ENV}: ${source} does not contain a PEM certificate`);
    }
    // Every PEM block, not only certificates, has to be complete and properly
    // nested: a valid certificate followed by a truncated private-key block,
    // or crossed markers, is still corrupt and must not be cached as usable
    // configuration. A stack catches both truncation and misordered markers.
    const stack: string[] = [];
    let certificateBegins = 0;
    for (const match of pem.matchAll(/-----(BEGIN|END) ([^-]+)-----/g)) {
        const [, kind, rawLabel] = match;
        const label = rawLabel.trim();
        if (kind === 'BEGIN') {
            stack.push(label);
            if (label === 'CERTIFICATE') certificateBegins += 1;
        } else if (stack.pop() !== label) {
            throw new MeshProxyDialConfigError(`${MESH_PROXY_CA_FILE_ENV}: ${source} contains an incomplete or misordered PEM block`);
        }
    }
    if (stack.length > 0 || certificateBegins !== blocks.length) {
        throw new MeshProxyDialConfigError(`${MESH_PROXY_CA_FILE_ENV}: ${source} contains an incomplete or misordered PEM block`);
    }
    for (const block of blocks) {
        try {
            new X509Certificate(block);
        } catch {
            throw new MeshProxyDialConfigError(
                `${MESH_PROXY_CA_FILE_ENV}: ${source} contains a PEM block that is not a valid X.509 certificate`,
            );
        }
    }
}

function parseCa(caPath: string | undefined): string[] | undefined {
    const trimmed = caPath?.trim();
    if (!trimmed) return undefined;
    let pem: string;
    try {
        pem = fs.readFileSync(trimmed, 'utf8');
    } catch (err) {
        throw new MeshProxyDialConfigError(`${MESH_PROXY_CA_FILE_ENV}: cannot read ${trimmed}: ${(err as Error).message}`);
    }
    validateCaBundle(pem, trimmed);
    return [...defaultTrustAnchors(), pem];
}

/** Parse the dial configuration from the environment. Throws on invalid config. */
export function loadMeshProxyDialConfig(env: NodeJS.ProcessEnv = process.env): MeshProxyDialConfig {
    return {
        headersFor: parseHeaders(env[MESH_PROXY_HEADERS_ENV]),
        ca: parseCa(env[MESH_PROXY_CA_FILE_ENV]),
    };
}
