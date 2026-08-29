import https from 'https';
import http from 'http';
import { CryptoService } from './CryptoService';
import { DatabaseService, type Registry, type RegistryType } from './DatabaseService';
import { isDebugEnabled } from '../utils/debug';
import { sanitizeForLog } from '../utils/safeLog';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface RegistryCreateInput {
    name: string;
    url: string;
    type: RegistryType;
    username: string;
    secret: string;
    aws_region?: string | null;
}

export interface RegistryUpdateInput {
    name?: string;
    url?: string;
    type?: RegistryType;
    username?: string;
    secret?: string;
    aws_region?: string | null;
}

export interface TestCredentialsInput {
    type: RegistryType;
    url: string;
    username: string;
    secret: string;
    aws_region?: string | null;
}

export interface DockerConfigJson {
    auths: Record<string, { auth: string }>;
}

export interface ResolvedDockerConfig {
    config: DockerConfigJson;
    warnings: string[];
}

export type RegistryAuthForIdResult =
    | {
        ok: true;
        username: string;
        password: string;
        registryHost: string;
        type: RegistryType;
        name: string;
    }
    | { ok: false; code: 'missing' | 'decrypt_failed' | 'ecr_failed'; message: string };

/** Host used for Docker Registry HTTP API calls (/v2/...). */
export function registryApiHost(reg: Pick<Registry, 'url' | 'type'>): string {
    if (reg.type === 'dockerhub') return 'registry-1.docker.io';
    return hostFromStoredRegistry(reg);
}

interface HttpResult {
    statusCode: number;
    headers: Record<string, string | string[] | undefined>;
    body: string;
}

interface EcrCacheEntry {
    username: string;
    password: string;
    expiresAt: number; // epoch ms
}

const DOCKER_HUB_AUTHS_KEY = 'https://index.docker.io/v1/';
const ECR_CACHE_SAFETY_MS = 5 * 60 * 1000;
const ECR_DEFAULT_TTL_MS = 12 * 60 * 60 * 1000;

// ─── URL helpers ─────────────────────────────────────────────────────────────

/**
 * Canonical storage form for a registry URL.
 *
 * - Docker Hub: always the legacy v1 URL (what the Docker CLI expects in
 *   `~/.docker/config.json`).
 * - All other types: protocol stripped, trailing slashes removed. This keeps
 *   stored URLs aligned with the `auths` key format Docker uses, and makes
 *   host matching unambiguous.
 */
export function normalizeRegistryUrl(url: string, type: RegistryType): string {
    if (type === 'dockerhub') return DOCKER_HUB_AUTHS_KEY;
    return url.trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
}

/** HTTP URL used to probe the registry's /v2/ endpoint. Always has a protocol. */
function toProbeUrl(url: string, type: RegistryType): string {
    if (type === 'dockerhub') return 'https://index.docker.io';
    const stripped = url.trim().replace(/\/+$/, '');
    if (stripped.startsWith('http://') || stripped.startsWith('https://')) return stripped;
    return `https://${stripped}`;
}

/** Canonical host for matching (image ref → stored credential). */
export function hostFromStoredRegistry(reg: Pick<Registry, 'url' | 'type'>): string {
    if (reg.type === 'dockerhub') return 'index.docker.io';
    try {
        const withProtocol = reg.url.startsWith('http') ? reg.url : `https://${reg.url}`;
        return new URL(withProtocol).host.toLowerCase();
    } catch {
        return reg.url.replace(/^https?:\/\//i, '').replace(/\/.*$/, '').toLowerCase();
    }
}

/** Normalize an image reference's host (the thing ImageUpdateService passes in). */
export function normalizeImageHost(host: string): string {
    const lower = host.trim().toLowerCase();
    // Docker Hub aliases resolve to the same credential.
    if (lower === 'docker.io' || lower === 'registry-1.docker.io' || lower === '') {
        return 'index.docker.io';
    }
    return lower;
}

// ─── HTTP helper (one-hop redirect) ──────────────────────────────────────────

function httpGet(
    url: string,
    headers: Record<string, string> = {},
    timeoutMs = 10000,
    allowRedirect = true,
): Promise<HttpResult> {
    return new Promise((resolve, reject) => {
        const lib = url.startsWith('https:') ? https : http;
        const req = lib.get(url, { headers }, (res) => {
            const status = res.statusCode ?? 0;
            const location = res.headers.location;
            if (allowRedirect && location && (status === 301 || status === 302 || status === 307 || status === 308)) {
                res.resume();
                let nextUrl: URL;
                try {
                    nextUrl = new URL(location, url);
                } catch {
                    reject(new Error('Invalid redirect location'));
                    return;
                }
                // Strip Authorization on cross-host redirects to prevent leaking credentials
                // to a registry-controlled Location header.
                let nextHeaders = headers;
                try {
                    const originalHost = new URL(url).host.toLowerCase();
                    if (nextUrl.host.toLowerCase() !== originalHost) {
                        const { Authorization: _drop, ...rest } = headers;
                        void _drop;
                        nextHeaders = rest;
                    }
                } catch {
                    // If the original URL cannot be parsed, err on the safe side and strip.
                    const { Authorization: _drop, ...rest } = headers;
                    void _drop;
                    nextHeaders = rest;
                }
                if (isDebugEnabled()) {
                    console.debug(`[RegistryService][debug] redirect ${status} ${sanitizeForLog(url)} -> ${sanitizeForLog(nextUrl.toString())} (auth ${nextHeaders === headers ? 'kept' : 'stripped'})`);
                }
                httpGet(nextUrl.toString(), nextHeaders, timeoutMs, false).then(resolve, reject);
                return;
            }
            let body = '';
            res.on('data', (chunk: Buffer) => { body += chunk.toString(); });
            res.on('end', () => resolve({
                statusCode: status,
                headers: res.headers as Record<string, string | string[] | undefined>,
                body,
            }));
        });
        req.on('error', reject);
        req.setTimeout(timeoutMs, () => req.destroy(new Error('Request timed out')));
    });
}

export type DockerConfigHostState = 'missing' | 'available' | 'unavailable';

export interface DockerConfigHostResolution {
    state: DockerConfigHostState;
    auth?: { username: string; password: string };
    expiresAt?: number;
}

// ─── Service ─────────────────────────────────────────────────────────────────

export class RegistryService {
    private static instance: RegistryService;
    private crypto: CryptoService;
    private ecrCache = new Map<number, EcrCacheEntry>();

    private constructor() {
        this.crypto = CryptoService.getInstance();
    }

    public static getInstance(): RegistryService {
        if (!RegistryService.instance) {
            RegistryService.instance = new RegistryService();
        }
        return RegistryService.instance;
    }

    // ─── CRUD ────────────────────────────────────────────────────────────────

    public getAll(): (Omit<Registry, 'secret'> & { has_secret: boolean })[] {
        const db = DatabaseService.getInstance();
        return db.getRegistries().map(r => {
            const { secret, ...rest } = r;
            return { ...rest, has_secret: !!secret };
        });
    }

    public getById(id: number): (Omit<Registry, 'secret'> & { has_secret: boolean }) | undefined {
        const db = DatabaseService.getInstance();
        const r = db.getRegistry(id);
        if (!r) return undefined;
        const { secret, ...rest } = r;
        return { ...rest, has_secret: !!secret };
    }

    public create(input: RegistryCreateInput): number {
        const db = DatabaseService.getInstance();
        const now = Date.now();
        const id = db.addRegistry({
            name: input.name,
            url: normalizeRegistryUrl(input.url, input.type),
            type: input.type,
            username: input.username,
            secret: this.crypto.encrypt(input.secret),
            aws_region: input.aws_region ?? null,
            created_at: now,
            updated_at: now,
        });
        console.info(`[RegistryService] Registry created: id=${id} type=${sanitizeForLog(input.type)} name="${sanitizeForLog(input.name)}"`);
        return id;
    }

    public update(id: number, input: RegistryUpdateInput): void {
        const db = DatabaseService.getInstance();
        const existing = db.getRegistry(id);
        if (!existing) throw new Error('Registry not found');

        const updates: Partial<Omit<Registry, 'id' | 'created_at'>> = {
            updated_at: Date.now(),
        };

        if (input.name !== undefined) updates.name = input.name;
        if (input.type !== undefined) updates.type = input.type;
        const effectiveType = input.type ?? existing.type;
        if (input.url !== undefined) updates.url = normalizeRegistryUrl(input.url, effectiveType);
        if (input.username !== undefined) updates.username = input.username;
        if (input.secret !== undefined && input.secret !== '') {
            updates.secret = this.crypto.encrypt(input.secret);
        }
        if (input.aws_region !== undefined) updates.aws_region = input.aws_region;

        db.updateRegistry(id, updates);
        this.ecrCache.delete(id);
        console.info(`[RegistryService] Registry updated: id=${id} name="${existing.name}"`);
    }

    public delete(id: number): void {
        const db = DatabaseService.getInstance();
        const existing = db.getRegistry(id);
        db.deleteRegistry(id);
        this.ecrCache.delete(id);
        if (existing) {
            console.info(`[RegistryService] Registry deleted: id=${id} name="${existing.name}"`);
        }
    }

    // ─── Test connectivity ───────────────────────────────────────────────────

    /** Test an already-saved registry by id. Decrypts the stored secret. */
    public async testConnection(id: number): Promise<{ success: boolean; error?: string }> {
        const db = DatabaseService.getInstance();
        const reg = db.getRegistry(id);
        if (!reg) return { success: false, error: 'Registry not found' };

        let password: string;
        try {
            password = this.crypto.decrypt(reg.secret);
        } catch (e) {
            return { success: false, error: `Could not decrypt stored secret: ${(e as Error).message}` };
        }

        return this.testWithCredentials({
            type: reg.type,
            url: reg.url,
            username: reg.username,
            secret: password,
            aws_region: reg.aws_region,
        });
    }

    /**
     * Test credentials without persisting them. Powers the "Test before save"
     * UX in the create/edit form.
     */
    public async testWithCredentials(input: TestCredentialsInput): Promise<{ success: boolean; error?: string }> {
        const t0 = Date.now();
        try {
            if (input.type === 'ecr') {
                if (!input.aws_region) {
                    return { success: false, error: 'AWS region is required for ECR registries.' };
                }
                if (isDebugEnabled()) {
                    console.debug(`[RegistryService][debug] testWithCredentials ECR region=${sanitizeForLog(input.aws_region)}`);
                }
                await this.fetchEcrToken(input.username, input.secret, input.aws_region);
                if (isDebugEnabled()) {
                    console.debug(`[RegistryService][debug] ECR test succeeded in ${Date.now() - t0}ms`);
                }
                return { success: true };
            }

            const probeUrl = toProbeUrl(input.url, input.type);
            const basicAuth = Buffer.from(`${input.username}:${input.secret}`).toString('base64');
            if (isDebugEnabled()) {
                console.debug(`[RegistryService][debug] testWithCredentials probing ${sanitizeForLog(probeUrl)}/v2/`);
            }
            const res = await httpGet(`${probeUrl}/v2/`, { Authorization: `Basic ${basicAuth}` });

            if (res.statusCode === 200) {
                if (isDebugEnabled()) {
                    console.debug(`[RegistryService][debug] test succeeded via 200 in ${Date.now() - t0}ms`);
                }
                return { success: true };
            }

            if (res.statusCode === 401) {
                const wwwAuth = res.headers['www-authenticate'] as string | undefined;
                if (!wwwAuth) return { success: false, error: 'Registry returned 401 without an auth challenge.' };

                const realmMatch = wwwAuth.match(/realm="([^"]+)"/);
                if (!realmMatch) return { success: false, error: 'Could not parse registry auth challenge.' };

                const serviceMatch = wwwAuth.match(/service="([^"]+)"/);
                const params = new URLSearchParams();
                if (serviceMatch) params.set('service', serviceMatch[1]);
                const tokenUrl = `${realmMatch[1]}?${params.toString()}`;

                if (isDebugEnabled()) {
                    console.debug(`[RegistryService][debug] exchanging Basic for Bearer at ${tokenUrl}`);
                }
                const tokenRes = await httpGet(tokenUrl, { Authorization: `Basic ${basicAuth}` });
                if (tokenRes.statusCode !== 200) {
                    return { success: false, error: `Authentication failed (HTTP ${tokenRes.statusCode}).` };
                }
                if (isDebugEnabled()) {
                    console.debug(`[RegistryService][debug] test succeeded via bearer in ${Date.now() - t0}ms`);
                }
                return { success: true };
            }

            return { success: false, error: `Registry returned HTTP ${res.statusCode}.` };
        } catch (e) {
            return { success: false, error: (e as Error).message };
        }
    }

    // ─── Docker config resolution (for ComposeService) ───────────────────────

    public async resolveDockerConfig(): Promise<ResolvedDockerConfig> {
        const db = DatabaseService.getInstance();
        const registries = db.getRegistries();
        const auths: Record<string, { auth: string }> = {};
        const warnings: string[] = [];

        if (isDebugEnabled()) {
            const summary = registries.map(r => `${r.type}:${r.name}`).join(', ');
            console.debug(`[RegistryService][debug] resolveDockerConfig registries=[${summary}]`);
        }

        for (const reg of registries) {
            try {
                let username = reg.username;
                let password: string;

                if (reg.type === 'ecr') {
                    const creds = await this.getEcrCredentials(reg);
                    username = creds.username;
                    password = creds.password;
                } else {
                    password = this.crypto.decrypt(reg.secret);
                }

                const authsKey = reg.type === 'dockerhub' ? DOCKER_HUB_AUTHS_KEY : reg.url;
                auths[authsKey] = { auth: Buffer.from(`${username}:${password}`).toString('base64') };
            } catch (e) {
                const msg = `Registry "${reg.name}" credentials unavailable: ${(e as Error).message}`;
                console.warn(`[RegistryService] ${msg}`);
                warnings.push(msg);
            }
        }

        return { config: { auths }, warnings };
    }

    /** Resolve a Docker config containing credentials for one registry host only. */
    public async resolveDockerConfigForHost(registryHost: string): Promise<ResolvedDockerConfig> {
        const detailed = await this.resolveDockerConfigForHostDetailed(registryHost);
        if (detailed.state !== 'available' || !detailed.auth) {
            return { config: { auths: {} }, warnings: [] };
        }

        const normalized = normalizeImageHost(registryHost);
        return {
            config: {
                auths: {
                    [normalized]: {
                        auth: Buffer.from(`${detailed.auth.username}:${detailed.auth.password}`).toString('base64'),
                    },
                },
            },
            warnings: [],
        };
    }

    /**
     * Tri-state host resolution for registry delivery. Target `unavailable`
     * means a configured row exists but credentials could not be resolved.
     */
    public async resolveDockerConfigForHostDetailed(registryHost: string): Promise<DockerConfigHostResolution> {
        const db = DatabaseService.getInstance();
        const registries = db.getRegistries();
        const normalized = normalizeImageHost(registryHost);
        const match = registries.find(r => hostFromStoredRegistry(r) === normalized);

        if (!match) {
            return { state: 'missing' };
        }

        try {
            if (match.type === 'ecr') {
                const creds = await this.getEcrCredentials(match);
                const cached = this.ecrCache.get(match.id);
                const expiresAt = cached?.expiresAt ?? Date.now() + ECR_DEFAULT_TTL_MS;
                return {
                    state: 'available',
                    auth: { username: creds.username, password: creds.password },
                    expiresAt,
                };
            }
            return {
                state: 'available',
                auth: {
                    username: match.username,
                    password: this.crypto.decrypt(match.secret),
                },
            };
        } catch (e) {
            console.warn(
                `[RegistryService] resolveDockerConfigForHostDetailed(${registryHost}) failed:`,
                sanitizeForLog((e as Error).message),
            );
            return { state: 'unavailable' };
        }
    }


    /**
     * Resolve credentials for a specific registry row by ID only.
     * Never falls back to host-based matching (duplicate hosts must use the requested ID).
     */
    public async getAuthForRegistryId(id: number): Promise<RegistryAuthForIdResult> {
        const reg = DatabaseService.getInstance().getRegistry(id);
        if (!reg) {
            return { ok: false, code: 'missing', message: 'Registry not found' };
        }
        try {
            const registryHost = registryApiHost(reg);
            if (reg.type === 'ecr') {
                const creds = await this.getEcrCredentials(reg);
                return {
                    ok: true,
                    username: creds.username,
                    password: creds.password,
                    registryHost,
                    type: reg.type,
                    name: reg.name,
                };
            }
            return {
                ok: true,
                username: reg.username,
                password: this.crypto.decrypt(reg.secret),
                registryHost,
                type: reg.type,
                name: reg.name,
            };
        } catch (e) {
            const detail = e instanceof Error ? e.message : String(e);
            console.warn(
                `[RegistryService] getAuthForRegistryId(${id}) failed:`,
                sanitizeForLog(detail),
            );
            if (reg.type === 'ecr') {
                return { ok: false, code: 'ecr_failed', message: 'Failed to refresh ECR credentials' };
            }
            return { ok: false, code: 'decrypt_failed', message: 'Failed to decrypt registry credentials' };
        }
    }

    // ─── Registry auth for ImageUpdateService ────────────────────────────────

    public async getAuthForRegistry(registryHost: string): Promise<{ username: string; password: string } | null> {
        const db = DatabaseService.getInstance();
        const registries = db.getRegistries();
        const normalized = normalizeImageHost(registryHost);

        const match = registries.find(r => hostFromStoredRegistry(r) === normalized);

        if (isDebugEnabled()) {
            console.debug(`[RegistryService][debug] getAuthForRegistry host="${registryHost}" normalized="${normalized}" matchId=${match?.id ?? 'none'}`);
        }

        if (!match) return null;

        try {
            if (match.type === 'ecr') {
                return await this.getEcrCredentials(match);
            }
            return { username: match.username, password: this.crypto.decrypt(match.secret) };
        } catch (e) {
            console.warn(`[RegistryService] Could not resolve auth for ${registryHost}: ${(e as Error).message}`);
            return null;
        }
    }

    // ─── ECR token fetch + cache ─────────────────────────────────────────────

    private async getEcrCredentials(reg: Registry): Promise<{ username: string; password: string }> {
        if (!reg.aws_region) {
            throw new Error(`ECR registry "${reg.name}" is missing aws_region. Re-save the registry with a region.`);
        }

        const now = Date.now();
        const cached = this.ecrCache.get(reg.id);
        if (cached && cached.expiresAt - ECR_CACHE_SAFETY_MS > now) {
            if (isDebugEnabled()) {
                const remainingMs = cached.expiresAt - now;
                console.debug(`[RegistryService][debug] ECR cache hit id=${reg.id} remaining=${Math.round(remainingMs / 1000)}s`);
            }
            return { username: cached.username, password: cached.password };
        }

        if (isDebugEnabled()) {
            console.debug(`[RegistryService][debug] ECR cache miss id=${reg.id}, fetching fresh token`);
        }

        const decryptedSecret = this.crypto.decrypt(reg.secret);
        const t0 = Date.now();
        const result = await this.fetchEcrToken(reg.username, decryptedSecret, reg.aws_region);
        const elapsed = Date.now() - t0;
        if (isDebugEnabled()) {
            console.debug(`[RegistryService][debug] ECR STS fetch id=${reg.id} took=${elapsed}ms expiresAt=${new Date(result.expiresAt).toISOString()}`);
        }

        this.ecrCache.set(reg.id, result);
        return { username: result.username, password: result.password };
    }

    private async fetchEcrToken(
        accessKeyId: string,
        secretAccessKey: string,
        region: string,
    ): Promise<EcrCacheEntry> {
        // @aws-sdk/client-ecr is declared as an optionalDependency: shipped
        // in the default install, but absent when the image was built with
        // `npm ci --omit=optional`. Surface a clear error rather than the
        // raw "Cannot find module" so operators know how to recover.
        let sdk: typeof import('@aws-sdk/client-ecr');
        try {
            sdk = await import('@aws-sdk/client-ecr');
        } catch (err) {
            throw new Error(
                'ECR registry support requires the @aws-sdk/client-ecr package. ' +
                'It is shipped by default; if you built this image with ' +
                '`npm ci --omit=optional`, reinstall without that flag to ' +
                'enable ECR.',
                { cause: err },
            );
        }
        const { ECRClient, GetAuthorizationTokenCommand } = sdk;
        const client = new ECRClient({
            region,
            credentials: { accessKeyId, secretAccessKey },
        });
        const response = await client.send(new GetAuthorizationTokenCommand({}));
        const authData = response.authorizationData?.[0];
        if (!authData?.authorizationToken) throw new Error('ECR returned no authorization token');

        const decoded = Buffer.from(authData.authorizationToken, 'base64').toString();
        const colonIdx = decoded.indexOf(':');
        if (colonIdx <= 0 || colonIdx === decoded.length - 1) {
            throw new Error('ECR returned a malformed authorization token');
        }
        const username = decoded.slice(0, colonIdx);
        const password = decoded.slice(colonIdx + 1);
        const expiresAt = authData.expiresAt instanceof Date
            ? authData.expiresAt.getTime()
            : Date.now() + ECR_DEFAULT_TTL_MS;

        return { username, password, expiresAt };
    }

    /** Exposed for tests and for admin-triggered cache busts. */
    public invalidateEcrCache(id?: number): void {
        if (id === undefined) this.ecrCache.clear();
        else this.ecrCache.delete(id);
    }
}
