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
import { meshReachableReason } from '../services/MeshService';
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
        // Positive gateway evidence: a redirect to the Cloudflare Access
        // login host, or a proxy authentication challenge.
        [upgradeFailure(302, { location: 'https://team.cloudflareaccess.com/cdn-cgi/access/login' }), 'blocked_by_proxy'],
        [upgradeFailure(303, { location: 'https://cloudflareaccess.com/login', server: 'cloudflare', 'cf-ray': 'abc' }), 'blocked_by_proxy'],
        [upgradeFailure(407, { server: 'nginx' }), 'blocked_by_proxy'],
        // Generic edge headers prove only that Cloudflare forwarded the
        // response. Cloudflare forwards the remote's own refusal with the
        // same headers, so they cannot turn an unmarked 401/403/429 into a
        // gateway label.
        [upgradeFailure(401, { server: 'cloudflare' }), 'refused_unverified'],
        [upgradeFailure(403, { server: 'cloudflare', 'cf-ray': 'abc' }), 'refused_unverified'],
        [upgradeFailure(429, { 'cf-ray': 'abc' }), 'refused_unverified'],
        // A redirect identifies a gateway only when its destination does.
        // An arbitrary, relative, malformed, or missing destination says
        // nothing about which hop sent it.
        [upgradeFailure(302), 'refused_unverified'],
        [upgradeFailure(307), 'refused_unverified'],
        [upgradeFailure(302, { location: 'https://app.example.com/login' }), 'refused_unverified'],
        [upgradeFailure(308, { location: '/api/mesh/proxy-tunnel/' }), 'refused_unverified'],
        [upgradeFailure(302, { location: 'not a url at all' }), 'refused_unverified'],
        [upgradeFailure(302, { server: 'cloudflare' }), 'refused_unverified'],
        [upgradeFailure(302, { 'cf-ray': 'abc' }), 'refused_unverified'],
        [upgradeFailure(302, { location: '' }), 'refused_unverified'],
        [upgradeFailure(302, { server: 'cloudflare', 'cf-ray': 'abc', location: 'https://app.example.com/login' }), 'refused_unverified'],
        // A Sencho marker identifies the component that answered, so it
        // outranks every status-based branch, not only redirects.
        [upgradeFailure(302, { location: 'https://team.cloudflareaccess.com/login', 'x-sencho-mesh-reject': 'unauthorized' }), 'auth_failed'],
        [upgradeFailure(302, { location: 'https://team.cloudflareaccess.com/login', 'x-sencho-mesh-reject': 'scope' }), 'scope_denied'],
        [upgradeFailure(302, { location: 'https://team.cloudflareaccess.com/login', 'x-sencho-mesh-reject': 'tier' }), 'tier_denied'],
        [upgradeFailure(302, { location: 'https://team.cloudflareaccess.com/login', 'x-sencho-mesh-reject': 'forbidden' }), 'remote_refused'],
        [upgradeFailure(302, { location: 'https://app.example.com/login', 'x-sencho-mesh-reject': 'forbidden' }), 'remote_refused'],
        [upgradeFailure(404, { 'x-sencho-mesh-reject': 'forbidden' }), 'remote_refused'],
        [upgradeFailure(407, { 'x-sencho-mesh-reject': 'tier' }), 'tier_denied'],
        // Markerless 401/403/429: an older Sencho receiver emits its
        // credential refusals without a marker too, so the hop is unknown.
        [upgradeFailure(401), 'refused_unverified'],
        [upgradeFailure(403), 'refused_unverified'],
        [upgradeFailure(401, { server: 'nginx' }), 'refused_unverified'],
        [upgradeFailure(403, { server: 'nginx' }), 'refused_unverified'],
        [upgradeFailure(429), 'refused_unverified'],
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
    ])('classifies %s as %s', (err, code) => {
        expect(classifyDialError(err).code).toBe(code);
    });

    it.each([
        // A bare 401/403 from an older Sencho says nothing about which hop
        // refused, and the operator has to be told that.
        [401, 'legacy credential refusal'],
        [403, 'legacy scope or tier refusal'],
        [429, 'rate limit'],
    ])('leaves the cause of an unmarked HTTP %i (%s) unclaimed', (status) => {
        const out = classifyDialError(upgradeFailure(status));
        expect(out.code).toBe('refused_unverified');
        expect(out.message).toMatch(/without identifying whether the remote Sencho or a proxy in front of it answered/);
    });

    it.each([
        // An edge header combination that appears on a forwarded origin
        // refusal must not become a gateway diagnosis. Cloudflare forwards
        // the remote's unmarked 401/403/429 with these headers attached.
        ['Cloudflare edge headers', { server: 'cloudflare', 'cf-ray': 'abc' }],
        ['a CF-Ray only', { 'cf-ray': 'abc' }],
        ['a Cloudflare Server only', { server: 'cloudflare' }],
    ])('does not turn a forwarded refusal with %s into a gateway diagnosis', (_label, headers) => {
        for (const status of [401, 403, 429]) {
            const out = classifyDialError(upgradeFailure(status, headers));
            expect(out.code).toBe('refused_unverified');
            expect(out.message).not.toMatch(/refused by Cloudflare/);
            // The node card consumes this mapping, so the certainty claim
            // has to stay out of the displayed wording too.
            expect(meshReachableReason(out.code)).toMatch(/refused or redirected/);
            expect(meshReachableReason(out.code)).not.toMatch(/blocked by an access proxy/);
        }
    });

    it.each([
        ['a generic destination', { location: 'https://app.example.com/login' }],
        ['a relative destination', { location: '/api/mesh/proxy-tunnel/' }],
        ['a malformed destination', { location: 'not a url' }],
        ['an empty destination', { location: '' }],
        ['no destination', {}],
        ['no destination with Cloudflare edge headers', { server: 'cloudflare', 'cf-ray': 'abc' }],
    ])('keeps a redirect with %s out of the gateway label', (_label, headers) => {
        const out = classifyDialError(upgradeFailure(302, headers));
        expect(out.code).toBe('refused_unverified');
        expect(out.message).toMatch(/neither the destination nor the response headers identify the hop that redirected/);
        // An empty Location is present but unusable; do not tell the operator
        // the header was absent.
        expect(out.message).not.toMatch(/without a Location header/);
        expect(out.message).not.toMatch(/Cloudflare Access/);
        expect(meshReachableReason(out.code)).toMatch(/refused or redirected/);
        expect(meshReachableReason(out.code)).not.toMatch(/blocked by an access proxy/);
    });

    it('shows an explanation that matches the evidence for each refusal class', () => {
        // The node card renders REACHABLE_REASON, not the classification
        // message, so the certainty claim has to be pinned there too.
        expect(meshReachableReason('refused_unverified')).toMatch(/refused or redirected/);
        expect(meshReachableReason('refused_unverified')).toMatch(/remote or a proxy in front of it/);
        expect(meshReachableReason('refused_unverified')).not.toMatch(/^blocked by an access proxy/);
        expect(meshReachableReason('blocked_by_proxy')).toMatch(/access proxy/);
        expect(meshReachableReason('remote_refused')).toMatch(/remote Sencho/);
        expect(meshReachableReason('auth_failed')).toMatch(/token/);
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
        expect(out.code).toBe('blocked_by_proxy');
        expect(out.message).toMatch(/Cloudflare Access/);
        expect(meshReachableReason(out.code)).toMatch(/access proxy/);
    });

    it.each([
        // The Access host itself.
        'https://team.cloudflareaccess.com/cdn-cgi/access/login',
        'https://cloudflareaccess.com/login',
    ])('treats a redirect to %s as Access', (location) => {
        const out = classifyDialError(upgradeFailure(302, { location }));
        expect(out.code).toBe('blocked_by_proxy');
        expect(out.message).toMatch(/Cloudflare Access/);
    });

    it.each([
        // A redirect that merely mentions the Access domain is not Access,
        // and a lookalike host is not Access. Neither one identifies the hop
        // that redirected, so the diagnosis stays unclaimed.
        'https://evil.example.com/login?next=cloudflareaccess.com',
        'https://team.cloudflareaccess.com.evil.example/login',
        'not a url at all cloudflareaccess.com',
    ])('does not treat %s as Access', (location) => {
        const out = classifyDialError(upgradeFailure(302, { location }));
        expect(out.message).not.toMatch(/Cloudflare Access/);
        expect(out.code).toBe('refused_unverified');
        expect(meshReachableReason(out.code)).not.toMatch(/access proxy/);
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
        // Node's HTTP client cannot encode anything above Latin-1; accepting
        // these made a configuration error look like a network failure.
        [JSON.stringify({ 'X-Bad': 'hello世界' }), /characters above U\+00FF/],
        [JSON.stringify({ edge: { 'X-Bad': 'hello世界' } }), /characters above U\+00FF/],
        [JSON.stringify({ '*': { 'X-Bad': 'hello世界' } }), /characters above U\+00FF/],
        [JSON.stringify({ '*': { 'X-Ok': '1' }, edge: { 'X-Bad': 'snowman ☃' } }), /characters above U\+00FF/],
    ])('rejects invalid header config %s', (raw, pattern) => {
        expect(() => loadMeshProxyDialConfig({ SENCHO_MESH_PROXY_HEADERS: raw })).toThrow(pattern);
    });

    it('accepts Latin-1 header values that Node can encode', () => {
        const cfg = loadMeshProxyDialConfig({
            SENCHO_MESH_PROXY_HEADERS: JSON.stringify({ 'X-Cafe': 'Café Münster' }),
        });
        expect(cfg.headersFor('edge')).toEqual({ 'X-Cafe': 'Café Münster' });
    });

    function withCaFile(content: string, check: (file: string) => void): void {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-ca-'));
        const file = path.join(dir, 'ca.pem');
        fs.writeFileSync(file, content);
        try {
            check(file);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    }

    it('adds a CA bundle on top of the default trust anchors', () => {
        const pem = tls.rootCertificates[0];
        withCaFile(pem, (file) => {
            const cfg = loadMeshProxyDialConfig({ SENCHO_MESH_PROXY_CA_FILE: file });
            expect(cfg.ca?.at(-1)).toBe(pem);
            expect((cfg.ca ?? []).length).toBeGreaterThan(1);
            // Passing `ca` replaces Node's defaults, so the rebuilt list has
            // to keep a real default root or every public node breaks.
            expect(cfg.ca).toContain(tls.rootCertificates[0]);
        });
    });

    it('accepts a bundle with several valid certificates', () => {
        const [first, second] = tls.rootCertificates;
        withCaFile(`${first}\n${second}`, (file) => {
            const cfg = loadMeshProxyDialConfig({ SENCHO_MESH_PROXY_CA_FILE: file });
            expect(cfg.ca?.at(-1)).toContain(first.trim());
            expect(cfg.ca?.at(-1)).toContain(second.trim());
        });
    });

    it('rejects an unreadable or non-PEM CA file', () => {
        expect(() => loadMeshProxyDialConfig({ SENCHO_MESH_PROXY_CA_FILE: '/nonexistent/ca.pem' })).toThrow(MeshProxyDialConfigError);
        withCaFile('not a cert', (file) => {
            expect(() => loadMeshProxyDialConfig({ SENCHO_MESH_PROXY_CA_FILE: file })).toThrow(/PEM certificate/);
        });
    });

    it.each([
        // Node's TLS context accepts these when default roots are present, so
        // only parsing the block can turn them into a configuration error.
        ['a truncated block', '-----BEGIN CERTIFICATE-----\nMIIB'],
        ['a truncated certificate', tls.rootCertificates[0].slice(0, tls.rootCertificates[0].indexOf('-----END CERTIFICATE-----'))],
        ['a block whose body is not a certificate', '-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----'],
        ['a valid block followed by a truncated one', `${tls.rootCertificates[0]}\n-----BEGIN CERTIFICATE-----\nMIIB`],
        ['a stray end marker', `${tls.rootCertificates[0]}\n-----END CERTIFICATE-----`],
        ['a valid certificate followed by a truncated private key', `${tls.rootCertificates[0]}\n-----BEGIN PRIVATE KEY-----\nMIIB`],
        ['crossed PEM markers', `${tls.rootCertificates[0]}\n-----BEGIN PRIVATE KEY-----\nMIIB\n-----BEGIN OTHER-----\nMIIB\n-----END PRIVATE KEY-----\n-----END OTHER-----`],
    ])('rejects %s as ca configuration', (_label, content) => {
        withCaFile(content, (file) => {
            expect(() => loadMeshProxyDialConfig({ SENCHO_MESH_PROXY_CA_FILE: file })).toThrow(MeshProxyDialConfigError);
        });
    });
});
