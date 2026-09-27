import fs from 'fs';
import tls from 'tls';

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
 * the default roots, for remotes whose TLS chain uses a private CA.
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
    /** Trust anchors to use instead of Node's defaults, or undefined for defaults. */
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
        // Any C0 control character or DEL. CR and LF are the obvious
        // injection risk, but the rest are equally illegal in a header value
        // and would fail later at request construction, where the operator
        // would see "remote unreachable" instead of the real problem.
        if (typeof value !== 'string' || /[\u0000-\u001F\u007F]/.test(value)) {
            throw new MeshProxyDialConfigError(`${MESH_PROXY_HEADERS_ENV}: header "${name}" in ${where} must be a single-line string without control characters`);
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

function parseCa(caPath: string | undefined): string[] | undefined {
    const trimmed = caPath?.trim();
    if (!trimmed) return undefined;
    let pem: string;
    try {
        pem = fs.readFileSync(trimmed, 'utf8');
    } catch (err) {
        throw new MeshProxyDialConfigError(`${MESH_PROXY_CA_FILE_ENV}: cannot read ${trimmed}: ${(err as Error).message}`);
    }
    if (!pem.includes('-----BEGIN CERTIFICATE-----')) {
        throw new MeshProxyDialConfigError(`${MESH_PROXY_CA_FILE_ENV}: ${trimmed} does not contain a PEM certificate`);
    }
    return [...defaultTrustAnchors(), pem];
}

/** Parse the dial configuration from the environment. Throws on invalid config. */
export function loadMeshProxyDialConfig(env: NodeJS.ProcessEnv = process.env): MeshProxyDialConfig {
    return {
        headersFor: parseHeaders(env[MESH_PROXY_HEADERS_ENV]),
        ca: parseCa(env[MESH_PROXY_CA_FILE_ENV]),
    };
}
