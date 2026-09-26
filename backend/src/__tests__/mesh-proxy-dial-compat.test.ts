/**
 * Proxy-mode dial compatibility with reverse proxies, tunnels and private
 * CAs: operator headers and CA bundle config, and failure classification
 * that names the actual cause instead of a generic "unreachable".
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import tls from 'tls';
import { describe, expect, it } from 'vitest';
import { classifyDialError } from '../services/MeshProxyTunnelDialer';
import { loadMeshProxyDialConfig, MeshProxyDialConfigError } from '../mesh/proxyDialConfig';
import { UnsafeOutboundTargetError } from '../utils/outboundTarget';

function upgradeFailure(status: number, headers: Record<string, string> = {}): Error {
    const err = new Error(`upgrade failed: HTTP ${status}`) as Error & { httpStatus: number; httpHeaders: Record<string, string> };
    err.httpStatus = status;
    err.httpHeaders = headers;
    return err;
}

function errnoError(code: string, message = code): Error {
    return Object.assign(new Error(message), { code });
}

describe('classifyDialError', () => {
    it.each([
        [upgradeFailure(401, { 'x-sencho-mesh-reject': 'unauthorized' }), 'auth_failed'],
        [upgradeFailure(403, { 'x-sencho-mesh-reject': 'scope' }), 'scope_denied'],
        [upgradeFailure(403, { 'x-sencho-mesh-reject': 'tier' }), 'tier_denied'],
        [upgradeFailure(404), 'endpoint_not_found'],
        [upgradeFailure(403, { server: 'cloudflare', 'cf-ray': 'abc' }), 'blocked_by_proxy'],
        [upgradeFailure(302, { location: 'https://team.cloudflareaccess.com/cdn-cgi/access/login' }), 'blocked_by_proxy'],
        [upgradeFailure(401, { server: 'nginx' }), 'blocked_by_proxy'],
        [upgradeFailure(502, { server: 'nginx' }), 'proxy_upstream_error'],
        [upgradeFailure(530, { server: 'cloudflare' }), 'proxy_upstream_error'],
        [upgradeFailure(200), 'upgrade_rejected'],
        [upgradeFailure(400), 'upgrade_rejected'],
        [errnoError('UNABLE_TO_GET_ISSUER_CERT_LOCALLY'), 'tls_failed'],
        [errnoError('ERR_TLS_CERT_ALTNAME_INVALID'), 'tls_failed'],
        [errnoError('SELF_SIGNED_CERT_IN_CHAIN'), 'tls_failed'],
        [errnoError('ENOTFOUND'), 'dns_failed'],
        [errnoError('ECONNREFUSED'), 'connection_refused'],
        [new Error('Opening handshake has timed out'), 'timeout'],
        [new UnsafeOutboundTargetError('blocked'), 'blocked_address'],
        [new UnsafeOutboundTargetError('unresolved'), 'dns_failed'],
        [errnoError('ECONNRESET'), 'network_error'],
        // A Sencho refusal it did not classify is neither a bad token nor a
        // gateway problem, so it must not be reported as either.
        [upgradeFailure(403, { 'x-sencho-mesh-reject': 'forbidden' }), 'remote_refused'],
        [upgradeFailure(401, { 'x-sencho-mesh-reject': 'forbidden' }), 'remote_refused'],
        // A proxy auth challenge and a rate limit are both something in front
        // of the remote refusing; neither is fixed by forwarding Upgrade.
        [upgradeFailure(407, { server: 'nginx' }), 'blocked_by_proxy'],
        [upgradeFailure(429, { server: 'cloudflare' }), 'blocked_by_proxy'],
    ])('classifies %s as %s', (err, code) => {
        expect(classifyDialError(err).code).toBe(code);
    });

    it('reads the reason through a wrapped unsafe-target error', () => {
        // The guard accepts err.cause, so the reason has to be read the same
        // way; otherwise a wrapped DNS failure is reported as a blocked
        // address and the operator goes looking at the wrong thing.
        const wrappedDns = Object.assign(new Error('dial failed'), {
            cause: new UnsafeOutboundTargetError('unresolved'),
        });
        expect(classifyDialError(wrappedDns).code).toBe('dns_failed');

        const wrappedBlocked = Object.assign(new Error('dial failed'), {
            cause: new UnsafeOutboundTargetError('blocked'),
        });
        expect(classifyDialError(wrappedBlocked).code).toBe('blocked_address');
    });

    it('names Cloudflare when a redirect points at Cloudflare Access', () => {
        const out = classifyDialError(upgradeFailure(302, { location: 'https://team.cloudflareaccess.com/login' }));
        expect(out.message).toMatch(/Cloudflare Access/);
    });
});

describe('loadMeshProxyDialConfig', () => {
    it('applies a flat header map to every node', () => {
        const cfg = loadMeshProxyDialConfig({
            SENCHO_MESH_PROXY_HEADERS: JSON.stringify({ 'CF-Access-Client-Id': 'id', 'CF-Access-Client-Secret': 'secret' }),
        });
        expect(cfg.headersFor('edge')).toEqual({ 'CF-Access-Client-Id': 'id', 'CF-Access-Client-Secret': 'secret' });
        expect(cfg.headersFor(undefined)).toEqual({ 'CF-Access-Client-Id': 'id', 'CF-Access-Client-Secret': 'secret' });
    });

    it('selects per-node headers with "*" as the fallback', () => {
        const cfg = loadMeshProxyDialConfig({
            SENCHO_MESH_PROXY_HEADERS: JSON.stringify({ '*': { 'X-Default': '1' }, edge: { 'X-Edge': '1' } }),
        });
        expect(cfg.headersFor('edge')).toEqual({ 'X-Edge': '1' });
        expect(cfg.headersFor('other')).toEqual({ 'X-Default': '1' });
    });

    it('returns no headers when unset', () => {
        expect(loadMeshProxyDialConfig({}).headersFor('edge')).toEqual({});
    });

    it.each([
        ['not json', /not valid JSON/],
        ['[1,2]', /JSON object/],
        [JSON.stringify({ Authorization: 'Bearer x' }), /managed by Sencho/],
        [JSON.stringify({ 'Sec-WebSocket-Key': 'x' }), /managed by Sencho/],
        [JSON.stringify({ 'x-sencho-tier': 'paid' }), /managed by Sencho/],
        [JSON.stringify({ 'X-Bad': 'line\r\nInjected: 1' }), /single-line/],
        [JSON.stringify({ 'X-Bad': 'bell\u0007here' }), /control characters/],
        [JSON.stringify({ 'X-Bad': 'nul\u0000here' }), /control characters/],
        [JSON.stringify({ 'X-Bad': 'del\u007Fhere' }), /control characters/],
        [JSON.stringify({ 'X-Bad': 42 }), /single-line/],
        [JSON.stringify({ 'bad header': 'x' }), /invalid header name/],
    ])('rejects invalid header config %s', (raw, pattern) => {
        expect(() => loadMeshProxyDialConfig({ SENCHO_MESH_PROXY_HEADERS: raw })).toThrow(pattern);
    });

    it('adds a CA bundle on top of the default trust anchors', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-ca-'));
        const file = path.join(dir, 'ca.pem');
        const pem = tls.rootCertificates[0];
        fs.writeFileSync(file, pem);
        try {
            const cfg = loadMeshProxyDialConfig({ SENCHO_MESH_PROXY_CA_FILE: file });
            expect(cfg.ca?.at(-1)).toBe(pem);
            expect((cfg.ca ?? []).length).toBeGreaterThan(1);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('rejects an unreadable or non-PEM CA file', () => {
        expect(() => loadMeshProxyDialConfig({ SENCHO_MESH_PROXY_CA_FILE: '/nonexistent/ca.pem' })).toThrow(MeshProxyDialConfigError);
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-ca-'));
        const file = path.join(dir, 'ca.pem');
        fs.writeFileSync(file, 'not a cert');
        try {
            expect(() => loadMeshProxyDialConfig({ SENCHO_MESH_PROXY_CA_FILE: file })).toThrow(/PEM certificate/);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});
