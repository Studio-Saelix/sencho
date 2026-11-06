import path from 'path';
import crypto from 'crypto';
import { CryptoService } from './CryptoService';
import { DatabaseService, SecretVersionConflictError, type BlueprintSelector, type Node, type SecretRow, type SecretVersionRow, type SecretPushStatus } from './DatabaseService';
import { FileSystemService } from './FileSystemService';
import { NodeLabelService } from './NodeLabelService';
import { NodeRegistry } from './NodeRegistry';
import { resolveAllEnvFilePaths } from '../routes/stacks';
import { getErrorMessage } from '../utils/errors';
import { formatNoTargetError } from '../utils/remoteTarget';
import { isDebugEnabled } from '../utils/debug';
import { safeRemoteFetch } from '../utils/outboundTarget';

export type SecretKv = Record<string, string>;
export type DiffStatus = 'added' | 'changed' | 'removed' | 'unchanged';

export interface SecretDiffEntry {
    key: string;
    status: DiffStatus;
    before?: string;
    after?: string;
}

export interface SecretSummary {
    id: number;
    name: string;
    description: string;
    currentVersion: number;
    keyCount: number;
    createdAt: number;
    createdBy: string;
    updatedAt: number;
}

export interface SecretVersionSummary {
    version: number;
    keyCount: number;
    createdAt: number;
    createdBy: string;
    note: string;
}

/**
 * The fixed stand-in a detail read sends for every value. It never encodes the
 * real value's length or shape, and the literal type stops a caller assigning
 * an actual value into the field.
 */
export const MASKED_VALUE = '••••••••';

export interface SecretKeyEntry {
    key: string;
    masked: typeof MASKED_VALUE;
}

/** Bundle detail with key names only: no current or historical value crosses this boundary. */
export interface SecretDetail extends SecretSummary {
    masked: true;
    keys: SecretKeyEntry[];
}

/**
 * Per-key edit applied on top of the current version, so a client that never
 * saw the other values cannot overwrite or erase them.
 */
export type SecretPatchOp =
    | { op: 'set'; key: string; value: string }
    | { op: 'remove'; key: string }
    | { op: 'rename'; from: string; to: string };

export interface RevealGrant {
    grantId: string;
    key: string;
    version: number;
    expiresAt: number;
}

export interface RevealedValue {
    key: string;
    version: number;
    value: string;
    expiresAt: number;
}

export type RevealGrantFailure = 'unknown' | 'expired' | 'mismatch';

/** A diff entry with the values stripped: the only shape a preview may carry. */
export interface SecretDiffClassEntry {
    key: string;
    status: DiffStatus;
}

export interface SecretImportPreview {
    added: number;
    changed: number;
    unchanged: number;
    /** Target keys the bundle does not have are not part of an import preview. */
    keys: Array<SecretDiffClassEntry & { status: Exclude<DiffStatus, 'removed'> }>;
    /** Digest of the source the preview read; the apply must present the same one. */
    fingerprint: string;
}

export interface SecretPushPlanEntry {
    nodeId: number;
    nodeName: string;
    stackName: string;
    envFileBasename: string;
    reachable: boolean;
    stackExists: boolean;
    error?: string;
    diff: SecretDiffClassEntry[];
    added: number;
    changed: number;
    unchanged: number;
    removedInformational: number;
}

export interface SecretPushResultEntry {
    nodeId: number;
    nodeName: string;
    stackName: string;
    envFileBasename: string;
    status: SecretPushStatus;
    error?: string;
    added: number;
    changed: number;
    unchanged: number;
}

const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const REQUEST_TIMEOUT_MS = 10_000;
/** How long a reveal grant stays exchangeable, and how long a revealed value may be shown. */
const REVEAL_GRANT_TTL_MS = 30_000;
const MAX_PENDING_REVEAL_GRANTS = 256;

interface PendingRevealGrant {
    secretId: number;
    version: number;
    key: string;
    /** The signed-in user's database id, so a recreated account cannot inherit a grant. */
    userId: number;
    expiresAt: number;
}

/** The requested key is not in the requested bundle version. */
export class RevealTargetError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'RevealTargetError';
    }
}

/**
 * A stored version payload exists but cannot be decrypted or parsed. Never
 * treated as an empty bundle: the write paths merge onto the current payload,
 * so "unreadable" and "empty" must not be the same value.
 */
export class SecretPayloadError extends Error {
    constructor() {
        super('The stored bundle payload could not be read');
        this.name = 'SecretPayloadError';
    }
}

/** The import source (node or env file) does not exist. */
export class SecretSourceError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'SecretSourceError';
    }
}

/** The import source changed after the preview the operator reviewed. */
export class SecretSourceChangedError extends Error {
    constructor() {
        super('The env file changed since you previewed it. Preview again before importing.');
        this.name = 'SecretSourceChangedError';
    }
}

/** An edit operation cannot be applied to the current version. */
export class SecretOpError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'SecretOpError';
    }
}

function applyOp(kv: SecretKv, op: SecretPatchOp): void {
    if (op.op === 'set') {
        kv[op.key] = op.value;
        return;
    }
    if (op.op === 'remove') {
        if (!(op.key in kv)) throw new SecretOpError(`Key '${op.key}' is not in the current version`);
        delete kv[op.key];
        return;
    }
    if (!(op.from in kv)) throw new SecretOpError(`Key '${op.from}' is not in the current version`);
    if (op.to in kv && op.to !== op.from) throw new SecretOpError(`Key '${op.to}' already exists`);
    const value = kv[op.from];
    delete kv[op.from];
    kv[op.to] = value;
}

export function parseEnv(text: string): SecretKv {
    const out: SecretKv = {};
    if (!text) return out;
    const lines = text.split(/\r?\n/);
    for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) continue;
        const eq = line.indexOf('=');
        if (eq < 0) continue;
        const key = line.slice(0, eq).trim();
        if (!ENV_KEY_PATTERN.test(key)) {
            console.warn('[Secrets] Dropping invalid env key:', key);
            continue;
        }
        const rawValue = line.slice(eq + 1);
        // Strip optional surrounding quotes.
        if (rawValue.length >= 2) {
            const first = rawValue[0];
            const last = rawValue[rawValue.length - 1];
            if ((first === '"' && last === '"') || (first === '\'' && last === '\'')) {
                const inner = rawValue.slice(1, -1);
                if (first === '"') {
                    out[key] = inner
                        .replace(/\\n/g, '\n')
                        .replace(/\\r/g, '\r')
                        .replace(/\\t/g, '\t')
                        .replace(/\\"/g, '"')
                        .replace(/\\\\/g, '\\');
                } else {
                    out[key] = inner;
                }
                continue;
            }
        }
        // Bare value: strip trailing inline comment ` #...`
        const commentIdx = rawValue.search(/\s#/);
        const trimmed = (commentIdx >= 0 ? rawValue.slice(0, commentIdx) : rawValue).trim();
        out[key] = trimmed;
    }
    return out;
}

export function serializeEnv(kv: SecretKv): string {
    const keys = Object.keys(kv).sort();
    const lines: string[] = [];
    for (const k of keys) {
        const v = kv[k];
        if (/[\s#=\\"']/.test(v) || v === '') {
            const escaped = v.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
            lines.push(`${k}="${escaped}"`);
        } else {
            lines.push(`${k}=${v}`);
        }
    }
    return lines.length === 0 ? '' : `${lines.join('\n')}\n`;
}

// Bundle wins for keys it defines; keys missing from the overlay are preserved.
export function applyOverlay(existing: SecretKv, overlay: SecretKv): SecretKv {
    return { ...existing, ...overlay };
}

export function computeDiff(existing: SecretKv, overlay: SecretKv): SecretDiffEntry[] {
    const keys = new Set<string>([...Object.keys(existing), ...Object.keys(overlay)]);
    const result: SecretDiffEntry[] = [];
    for (const key of [...keys].sort()) {
        const inE = key in existing;
        const inO = key in overlay;
        if (inO && !inE) {
            result.push({ key, status: 'added', after: overlay[key] });
        } else if (!inO && inE) {
            result.push({ key, status: 'removed', before: existing[key] });
        } else if (inO && inE && overlay[key] !== existing[key]) {
            result.push({ key, status: 'changed', before: existing[key], after: overlay[key] });
        } else {
            result.push({ key, status: 'unchanged' });
        }
    }
    return result;
}

/** Digest of the raw env file the preview read, so an apply can prove it reviewed the same source. */
function fingerprintSource(text: string): string {
    return crypto.createHash('sha256').update(text, 'utf-8').digest('hex');
}

function aggregateDiff(diff: SecretDiffEntry[]): { added: number; changed: number; unchanged: number; removedInformational: number } {
    const r = { added: 0, changed: 0, unchanged: 0, removedInformational: 0 };
    for (const e of diff) {
        if (e.status === 'added') r.added += 1;
        else if (e.status === 'changed') r.changed += 1;
        else if (e.status === 'unchanged') r.unchanged += 1;
        else r.removedInformational += 1;
    }
    return r;
}

/** Strip before/after values so a preview can only ever carry key names and change classes. */
function maskDiff(diff: SecretDiffEntry[]): SecretDiffClassEntry[] {
    return diff.map(({ key, status }) => ({ key, status }));
}

function isLocalNode(node: Node): boolean {
    return node.type === 'local';
}

function encryptKv(kv: SecretKv): string {
    return CryptoService.getInstance().encrypt(JSON.stringify(kv));
}

/**
 * Decrypt a stored version. An absent payload is an empty bundle; anything
 * else that does not decrypt to a JSON object of strings throws, so a corrupt
 * version can never be reported (or written over) as an empty one.
 */
function decryptKv(payload: string): SecretKv {
    // A version row always holds ciphertext, even for an empty bundle, so an
    // empty payload is corruption rather than an empty bundle.
    if (!payload || !CryptoService.getInstance().isEncrypted(payload)) throw new SecretPayloadError();
    let plaintext: string;
    try {
        plaintext = CryptoService.getInstance().decrypt(payload);
    } catch {
        // Auth-tag or key mismatch: the payload is unreadable, not empty.
        throw new SecretPayloadError();
    }
    if (!plaintext) throw new SecretPayloadError();
    try {
        const parsed: unknown = JSON.parse(plaintext);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new SecretPayloadError();
        const out: SecretKv = {};
        for (const [k, v] of Object.entries(parsed)) {
            if (typeof v !== 'string') throw new SecretPayloadError();
            out[k] = v;
        }
        return out;
    } catch (err) {
        if (err instanceof SecretPayloadError) throw err;
        // A JSON.parse failure message can quote a fragment of its input, which
        // here is decrypted plaintext. Nothing about the payload is logged.
        throw new SecretPayloadError();
    }
}

function validateKv(kv: SecretKv): { ok: true } | { ok: false; error: string } {
    for (const key of Object.keys(kv)) {
        if (!ENV_KEY_PATTERN.test(key)) {
            return { ok: false, error: `Invalid env key: ${key}` };
        }
        if (typeof kv[key] !== 'string') {
            return { ok: false, error: `Value for ${key} must be a string` };
        }
    }
    return { ok: true };
}

interface ResolvedEnvFile { absolutePath: string }

async function resolveEnvFileLocal(nodeId: number, stackName: string, basename: string): Promise<ResolvedEnvFile | null> {
    const paths = await resolveAllEnvFilePaths(nodeId, stackName);
    if (paths.length === 0) {
        if (basename === '.env') {
            const baseDir = FileSystemService.getInstance(nodeId).getBaseDir();
            return { absolutePath: path.join(baseDir, stackName, '.env') };
        }
        return null;
    }
    const match = paths.find(p => path.basename(p) === basename);
    return match ? { absolutePath: match } : null;
}

async function resolveEnvFileRemote(node: Node, stackName: string, basename: string): Promise<ResolvedEnvFile | null> {
    // Throw on a null target so previewPushDiff / executePush surface the
    // tunnel-disconnected (or proxy-not-configured) reason on the right
    // axis. Returning null here would flow up through readExistingEnv as
    // "env file not found", which is wrong: we know the env exists, we
    // just cannot reach the node.
    const target = NodeRegistry.getInstance().getProxyTarget(node.id);
    if (!target) throw new Error(formatNoTargetError(node));
    const baseUrl = target.apiUrl.replace(/\/$/, '');
    const headers: Record<string, string> = {};
    if (target.apiToken) headers.Authorization = `Bearer ${target.apiToken}`;
    const res = await safeRemoteFetch(`${baseUrl}/api/stacks/${encodeURIComponent(stackName)}/envs`, {
        headers,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }, target.trustedLoopback);
    if (!res.ok) {
        if (res.status === 404 && basename === '.env') {
            return { absolutePath: '.env' };
        }
        throw new Error(`failed to list env files (HTTP ${res.status})`);
    }
    const body = await res.json() as { envFiles?: string[] };
    const paths = Array.isArray(body.envFiles) ? body.envFiles : [];
    if (paths.length === 0 && basename === '.env') {
        return { absolutePath: '.env' };
    }
    const match = paths.find(p => path.basename(p) === basename);
    return match ? { absolutePath: match } : null;
}

/**
 * Read an env file. A push treats a missing file as empty so the overlay still
 * writes it; an import must not, or a typo in the stack name reads as "nothing
 * to import".
 */
async function readEnvLocal(nodeId: number, absolutePath: string, missingAsEmpty: boolean): Promise<string> {
    const fsService = FileSystemService.getInstance(nodeId);
    try {
        return await fsService.readFile(absolutePath, 'utf-8');
    } catch (err) {
        const code = (err as NodeJS.ErrnoException)?.code;
        if (code === 'ENOENT') {
            if (missingAsEmpty) return '';
            throw new SecretSourceError(`${absolutePath} does not exist on this node`);
        }
        throw err;
    }
}

async function writeEnvLocal(nodeId: number, absolutePath: string, content: string): Promise<void> {
    const fsService = FileSystemService.getInstance(nodeId);
    await fsService.writeFile(absolutePath, content, 'utf-8');
}

async function readEnvRemote(node: Node, stackName: string, absolutePath: string, missingAsEmpty: boolean): Promise<string> {
    const target = NodeRegistry.getInstance().getProxyTarget(node.id);
    if (!target) throw new Error(formatNoTargetError(node));
    const baseUrl = target.apiUrl.replace(/\/$/, '');
    const headers: Record<string, string> = {};
    if (target.apiToken) headers.Authorization = `Bearer ${target.apiToken}`;
    const url = new URL(`${baseUrl}/api/stacks/${encodeURIComponent(stackName)}/env`);
    if (absolutePath !== '.env') url.searchParams.set('file', absolutePath);
    const res = await safeRemoteFetch(url.toString(), {
        headers,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }, target.trustedLoopback);
    if (res.status === 404) {
        if (missingAsEmpty) return '';
        throw new SecretSourceError(`env file '${path.basename(absolutePath)}' does not exist in stack '${stackName}' on node ${node.name}`);
    }
    if (!res.ok) throw new Error(`failed to read env (HTTP ${res.status})`);
    // A node answers 200 with an empty body and this header when the stack has
    // no env file at all. An import must not read that as an empty source.
    if (!missingAsEmpty && res.headers.get('X-Env-Exists') === 'false') {
        throw new SecretSourceError(`stack '${stackName}' has no env file on node ${node.name}`);
    }
    return await res.text();
}

async function writeEnvRemote(node: Node, stackName: string, absolutePath: string, content: string): Promise<void> {
    const target = NodeRegistry.getInstance().getProxyTarget(node.id);
    if (!target) throw new Error(formatNoTargetError(node));
    const baseUrl = target.apiUrl.replace(/\/$/, '');
    const headers: Record<string, string> = {
        'Content-Type': 'application/json',
    };
    if (target.apiToken) headers.Authorization = `Bearer ${target.apiToken}`;
    const url = new URL(`${baseUrl}/api/stacks/${encodeURIComponent(stackName)}/env`);
    if (absolutePath !== '.env') url.searchParams.set('file', absolutePath);
    const res = await safeRemoteFetch(url.toString(), {
        method: 'PUT',
        headers,
        body: JSON.stringify({ content }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }, target.trustedLoopback);
    if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`failed to write env (HTTP ${res.status}${body ? ': ' + body.slice(0, 200) : ''})`);
    }
}

interface ResolvedRead { absolutePath: string; text: string }

async function readExistingEnv(node: Node, stackName: string, basename: string, missingAsEmpty = true): Promise<ResolvedRead | null> {
    if (isLocalNode(node)) {
        const resolved = await resolveEnvFileLocal(node.id, stackName, basename);
        if (!resolved) return null;
        const text = await readEnvLocal(node.id, resolved.absolutePath, missingAsEmpty);
        return { absolutePath: resolved.absolutePath, text };
    }
    const resolved = await resolveEnvFileRemote(node, stackName, basename);
    if (!resolved) return null;
    const text = await readEnvRemote(node, stackName, resolved.absolutePath, missingAsEmpty);
    return { absolutePath: resolved.absolutePath, text };
}

async function writeEnvForNode(node: Node, stackName: string, absolutePath: string, content: string): Promise<void> {
    if (isLocalNode(node)) {
        await writeEnvLocal(node.id, absolutePath, content);
    } else {
        await writeEnvRemote(node, stackName, absolutePath, content);
    }
}

function toSummary(secret: SecretRow, version: SecretVersionRow | undefined): SecretSummary {
    return {
        id: secret.id,
        name: secret.name,
        description: secret.description,
        currentVersion: secret.current_version,
        keyCount: version?.key_count ?? 0,
        createdAt: secret.created_at,
        createdBy: secret.created_by,
        updatedAt: secret.updated_at,
    };
}

const activePushes = new Set<number>();

export class SecretsService {
    private static instance: SecretsService | null = null;

    /** Single-use reveal grants, in memory only: never persisted, never logged. */
    private readonly revealGrants = new Map<string, PendingRevealGrant>();

    static getInstance(): SecretsService {
        if (!SecretsService.instance) {
            SecretsService.instance = new SecretsService();
        }
        return SecretsService.instance;
    }

    private constructor() { /* singleton */ }

    list(): SecretSummary[] {
        const db = DatabaseService.getInstance();
        const rows = db.listSecrets();
        return rows.map(row => {
            const v = db.getCurrentSecretVersion(row.id);
            return toSummary(row, v);
        });
    }

    getCurrent(id: number): SecretSummary | null {
        const db = DatabaseService.getInstance();
        const row = db.getSecret(id);
        if (!row) return null;
        const v = db.getCurrentSecretVersion(id);
        return toSummary(row, v);
    }

    listVersions(id: number): SecretVersionSummary[] {
        const db = DatabaseService.getInstance();
        return db.listSecretVersions(id).map(v => ({
            version: v.version,
            keyCount: v.key_count,
            createdAt: v.created_at,
            createdBy: v.created_by,
            note: v.note,
        }));
    }

    create(input: { name: string; description?: string; kv: SecretKv; user: string; note?: string }): { id: number; version: number } {
        const validation = validateKv(input.kv);
        if (!validation.ok) throw new Error(validation.error);
        const db = DatabaseService.getInstance();
        return db.createSecretWithVersion({
            name: input.name,
            description: input.description ?? '',
            encryptedPayload: encryptKv(input.kv),
            keyCount: Object.keys(input.kv).length,
            createdBy: input.user,
            note: input.note ?? '',
        });
    }

    /** Bundle detail: metadata plus key names. Never a value, current or historical. */
    getDetail(id: number): SecretDetail | null {
        const summary = this.getCurrent(id);
        if (!summary) return null;
        const kv = this.getDecryptedKv(id);
        return {
            ...summary,
            masked: true,
            keys: Object.keys(kv).sort().map((key) => ({ key, masked: MASKED_VALUE })),
        };
    }

    delete(id: number): boolean {
        return DatabaseService.getInstance().deleteSecret(id);
    }

    getDecryptedKv(id: number): SecretKv {
        const db = DatabaseService.getInstance();
        const v = db.getCurrentSecretVersion(id);
        if (!v) return {};
        return decryptKv(v.encrypted_payload);
    }

    private versionRow(secretId: number, version: number): SecretVersionRow | undefined {
        const db = DatabaseService.getInstance();
        const current = db.getCurrentSecretVersion(secretId);
        if (current && current.version === version) return current;
        return db.getSecretVersion(secretId, version);
    }

    /**
     * Mint a single-use, short-lived grant for exactly one bundle version and
     * key. The grant carries no value; the client exchanges it once below.
     */
    createRevealGrant(id: number, key: string, userId: number, version?: number): RevealGrant {
        const db = DatabaseService.getInstance();
        const secret = db.getSecret(id);
        if (!secret) throw new RevealTargetError('Secret not found');
        const target = version === undefined ? db.getCurrentSecretVersion(id) : this.versionRow(id, version);
        if (!target) throw new RevealTargetError(`Version ${version} not found`);
        if (!(key in decryptKv(target.encrypted_payload))) {
            throw new RevealTargetError(`Key '${key}' is not in version ${target.version}`);
        }
        this.purgeExpiredGrants();
        if (this.revealGrants.size >= MAX_PENDING_REVEAL_GRANTS) {
            // Bound the store: drop the oldest pending grant rather than grow without limit.
            const oldest = this.revealGrants.keys().next();
            if (!oldest.done) this.revealGrants.delete(oldest.value);
        }
        const grantId = crypto.randomBytes(24).toString('base64url');
        const expiresAt = Date.now() + REVEAL_GRANT_TTL_MS;
        this.revealGrants.set(grantId, { secretId: id, version: target.version, key, userId, expiresAt });
        return { grantId, key, version: target.version, expiresAt };
    }

    /**
     * Exchange a grant for one value. The grant is consumed before the value is
     * read, so a replay finds nothing, and it only answers for the bundle, user,
     * version and key it was minted for.
     */
    consumeRevealGrant(id: number, grantId: string, userId: number):
        { ok: true; revealed: RevealedValue } | { ok: false; reason: RevealGrantFailure } {
        const grant = this.revealGrants.get(grantId);
        if (!grant) return { ok: false, reason: 'unknown' };
        this.revealGrants.delete(grantId);
        if (grant.expiresAt <= Date.now()) return { ok: false, reason: 'expired' };
        if (grant.secretId !== id || grant.userId !== userId) return { ok: false, reason: 'mismatch' };
        const row = this.versionRow(id, grant.version);
        if (!row) return { ok: false, reason: 'unknown' };
        const kv = decryptKv(row.encrypted_payload);
        if (!(grant.key in kv)) return { ok: false, reason: 'unknown' };
        return {
            ok: true,
            revealed: { key: grant.key, version: grant.version, value: kv[grant.key], expiresAt: grant.expiresAt },
        };
    }

    /** Test seam: drop every pending grant. */
    clearRevealGrants(): void {
        this.revealGrants.clear();
    }

    private purgeExpiredGrants(): void {
        const now = Date.now();
        for (const [grantId, grant] of this.revealGrants) {
            if (grant.expiresAt <= now) this.revealGrants.delete(grantId);
        }
    }

    /**
     * Apply per-key operations onto the current version. Untouched keys keep the
     * value already stored server-side, and a stale `expectedVersion` is refused
     * instead of overwriting values the caller never saw.
     */
    applyPatch(id: number, input: {
        expectedVersion: number;
        ops: SecretPatchOp[];
        description?: string;
        user: string;
        note?: string;
    }): { version: number } {
        const db = DatabaseService.getInstance();
        const current = db.getCurrentSecretVersion(id);
        if (!current) throw new Error('Secret not found');
        if (current.version !== input.expectedVersion) {
            throw new SecretVersionConflictError(current.version);
        }
        if (input.ops.length === 0) {
            // Metadata-only edit: no value is touched, so no version is minted.
            // The caller must name the new description rather than have an
            // omitted field silently clear the stored one.
            if (input.description === undefined) {
                throw new SecretOpError('Send at least one operation, or a description to change');
            }
            return db.updateSecretDescription({
                secretId: id,
                description: input.description,
                expectedVersion: input.expectedVersion,
            });
        }
        const kv = decryptKv(current.encrypted_payload);
        for (const op of input.ops) applyOp(kv, op);
        const validation = validateKv(kv);
        if (!validation.ok) throw new Error(validation.error);
        return db.updateSecretWithVersion({
            secretId: id,
            description: input.description === undefined ? null : input.description,
            encryptedPayload: encryptKv(kv),
            keyCount: Object.keys(kv).length,
            createdBy: input.user,
            note: input.note ?? '',
            expectedVersion: input.expectedVersion,
        });
    }

    async readImportOverlay(nodeId: number, stackName: string, envFileBasename = '.env'): Promise<{ kv: SecretKv; fingerprint: string }> {
        const node = DatabaseService.getInstance().getNodes().find(n => n.id === nodeId);
        if (!node) throw new SecretSourceError(`Node ${nodeId} is not in this fleet`);
        const read = await readExistingEnv(node, stackName, envFileBasename, false);
        if (!read) throw new SecretSourceError(`env file '${envFileBasename}' not found on node ${node.name}`);
        return { kv: parseEnv(read.text), fingerprint: fingerprintSource(read.text) };
    }

    /**
     * Names and change classes only: the env file's values stay server-side.
     * Target keys the bundle does not have are dropped from the list, so every
     * entry a preview shows is a key the import would add or change.
     */
    async previewImport(id: number, nodeId: number, stackName: string, envFileBasename = '.env'): Promise<SecretImportPreview> {
        const { kv: overlay, fingerprint } = await this.readImportOverlay(nodeId, stackName, envFileBasename);
        const diff = computeDiff(this.getDecryptedKv(id), overlay);
        const agg = aggregateDiff(diff);
        return {
            added: agg.added,
            changed: agg.changed,
            unchanged: agg.unchanged,
            fingerprint,
            keys: maskDiff(diff).filter(
                (entry): entry is SecretDiffClassEntry & { status: Exclude<DiffStatus, 'removed'> } => entry.status !== 'removed',
            ),
        };
    }

    async applyImport(id: number, input: {
        nodeId: number;
        stackName: string;
        envFileBasename?: string;
        expectedVersion: number;
        /** Digest the preview answered with; a changed source is refused. */
        expectedFingerprint: string;
        user: string;
        note?: string;
    }): Promise<{ version: number; added: number; changed: number; unchanged: number }> {
        const basename = input.envFileBasename ?? '.env';
        const { kv: overlay, fingerprint } = await this.readImportOverlay(input.nodeId, input.stackName, basename);
        if (fingerprint !== input.expectedFingerprint) throw new SecretSourceChangedError();
        const db = DatabaseService.getInstance();
        const current = db.getCurrentSecretVersion(id);
        if (!current) throw new Error('Secret not found');
        if (current.version !== input.expectedVersion) {
            throw new SecretVersionConflictError(current.version);
        }
        const existing = decryptKv(current.encrypted_payload);
        const agg = aggregateDiff(computeDiff(existing, overlay));
        const merged = applyOverlay(existing, overlay);
        const { version } = db.updateSecretWithVersion({
            secretId: id,
            description: null,
            encryptedPayload: encryptKv(merged),
            keyCount: Object.keys(merged).length,
            createdBy: input.user,
            note: input.note ?? '',
            expectedVersion: input.expectedVersion,
        });
        return { version, added: agg.added, changed: agg.changed, unchanged: agg.unchanged };
    }

    async previewPushDiff(id: number, selector: BlueprintSelector, stackName: string, envFileBasename: string): Promise<SecretPushPlanEntry[]> {
        const db = DatabaseService.getInstance();
        const overlay = this.getDecryptedKv(id);
        const matched = NodeLabelService.getInstance().matchSelector(selector, db.getNodes());
        if (isDebugEnabled()) console.log(`[Secrets:diag] preview id=${id} targets=${matched.length}`);

        // Preview is read-only and per-node; fan out in parallel for snappier wizard UX.
        return Promise.all(matched.map(async (node): Promise<SecretPushPlanEntry> => {
            const entry: SecretPushPlanEntry = {
                nodeId: node.id,
                nodeName: node.name,
                stackName,
                envFileBasename,
                reachable: true,
                stackExists: true,
                diff: [],
                added: 0,
                changed: 0,
                unchanged: 0,
                removedInformational: 0,
            };
            try {
                const read = await readExistingEnv(node, stackName, envFileBasename);
                if (!read) {
                    entry.stackExists = false;
                    entry.error = `env file '${envFileBasename}' not found`;
                    return entry;
                }
                const diff = computeDiff(parseEnv(read.text), overlay);
                entry.diff = maskDiff(diff);
                Object.assign(entry, aggregateDiff(diff));
            } catch (err) {
                entry.reachable = false;
                entry.error = getErrorMessage(err, 'preview failed');
            }
            return entry;
        }));
    }

    async executePush(id: number, selector: BlueprintSelector, stackName: string, envFileBasename: string, user: string): Promise<{ pushId: string; results: SecretPushResultEntry[] }> {
        if (activePushes.has(id)) {
            throw new PushBusyError(id);
        }
        const db = DatabaseService.getInstance();
        const secret = db.getSecret(id);
        if (!secret) throw new Error('Secret not found');
        const versionRow = db.getCurrentSecretVersion(id);
        if (!versionRow) throw new Error('Secret has no current version');
        const overlay = decryptKv(versionRow.encrypted_payload);
        const matched = NodeLabelService.getInstance().matchSelector(selector, db.getNodes());
        const pushId = crypto.randomUUID();
        if (isDebugEnabled()) console.log(`[Secrets:diag] push id=${id} v${versionRow.version} targets=${matched.length}`);
        const results: SecretPushResultEntry[] = [];
        const rows: Array<Parameters<typeof db.insertSecretPushes>[0][number]> = [];
        const pushedAt = Date.now();

        // Sequential write order keeps audit-row ordering deterministic and avoids
        // stampeding any single remote that's targeted by multiple labels.
        activePushes.add(id);
        try {
            for (const node of matched) {
                const result: SecretPushResultEntry = {
                    nodeId: node.id,
                    nodeName: node.name,
                    stackName,
                    envFileBasename,
                    status: 'ok',
                    added: 0,
                    changed: 0,
                    unchanged: 0,
                };
                try {
                    const read = await readExistingEnv(node, stackName, envFileBasename);
                    if (!read) throw new Error(`env file '${envFileBasename}' not found`);
                    const existing = parseEnv(read.text);
                    const agg = aggregateDiff(computeDiff(existing, overlay));
                    const newText = serializeEnv(applyOverlay(existing, overlay));
                    await writeEnvForNode(node, stackName, read.absolutePath, newText);
                    result.added = agg.added;
                    result.changed = agg.changed;
                    result.unchanged = agg.unchanged;
                } catch (err) {
                    result.status = 'failed';
                    result.error = getErrorMessage(err, 'push failed');
                }
                results.push(result);
                rows.push({
                    secret_id: id,
                    version: versionRow.version,
                    push_id: pushId,
                    node_id: node.id,
                    stack_name: stackName,
                    env_file_basename: envFileBasename,
                    status: result.status,
                    error: result.error ?? '',
                    added_count: result.added,
                    changed_count: result.changed,
                    unchanged_count: result.unchanged,
                    pushed_by: user,
                    pushed_at: pushedAt,
                });
            }
            db.insertSecretPushes(rows);
        } finally {
            activePushes.delete(id);
        }
        if (isDebugEnabled()) {
            const okCount = results.filter(r => r.status === 'ok').length;
            console.log(`[Secrets:diag] push id=${id} done in ${Date.now() - pushedAt}ms ok=${okCount} failed=${results.length - okCount}`);
        }
        return { pushId, results };
    }
}

export class PushBusyError extends Error {
    constructor(public readonly secretId: number) {
        super(`Push already running for secret ${secretId}`);
        this.name = 'PushBusyError';
    }
}
