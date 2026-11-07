import path from 'path';
import crypto from 'crypto';
import { CryptoService } from './CryptoService';
import { DatabaseService, SecretVersionConflictError, type BlueprintSelector, type Node, type SecretRow, type SecretVersionRow, type SecretPushStatus } from './DatabaseService';
import { FileSystemService } from './FileSystemService';
import { NodeLabelService } from './NodeLabelService';
import { NodeRegistry } from './NodeRegistry';
import { resolveAllEnvFilePaths } from '../routes/stacks';
import { getErrorMessage } from '../utils/errors';
import { isPathWithinBase } from '../utils/validation';
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
    /** Digest of the previewed stack, env file and contents, or null when it could not be read. */
    fingerprint: string | null;
}

/**
 * A previewed push: the bundle version and per-target proofs the apply must
 * present. Every previewed target is listed with its digest, or null when the
 * preview could not read it; the apply refuses any target set that no longer
 * matches or any target whose stack, env file, or contents moved, including
 * one the preview could not read that is readable now.
 */
export interface SecretPushPreview {
    version: number;
    targets: SecretPushPlanEntry[];
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

/**
 * The import source exists but the request asked for a path the compose root
 * does not own (a symlink escape or an invalid path). This is a refusal, not a
 * missing source and not a server fault, so it must reach the client as a 400.
 */
export class SecretSourceRefusedError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'SecretSourceRefusedError';
    }
}

/** The import source changed after the preview the operator reviewed. */
export class SecretSourceChangedError extends Error {
    constructor() {
        super('The env file changed since you previewed it. Preview again before importing.');
        this.name = 'SecretSourceChangedError';
    }
}

/**
 * A previewed target env file moved, disappeared, became unreadable, or became
 * readable where the preview could not read it. Thrown before any target is
 * written; the preview is the only review an operator gets over masked values,
 * so a push whose targets no longer match it writes nothing. A change detected
 * during the write loop fails that node instead, because earlier targets may
 * already be written.
 */
export class PushTargetChangedError extends Error {
    constructor() {
        super('A target env file changed since you previewed the push. Preview again before pushing.');
        this.name = 'PushTargetChangedError';
    }
}

/**
 * `__proto__` is refused whenever a write introduces the name, even though
 * edits run on a Map and the stored shape is rebuilt with `Object.fromEntries`:
 * the name means a prototype slot to any plain-object consumer downstream.
 * Create, replace, and import all enforce it, and a remove or a rename-from
 * never does, so a bundle that already stores one can still be cleaned up.
 * `constructor` and `prototype` are ordinary own keys on a Map, so refusing
 * them would only block a bundle that already stores one.
 */
const RESERVED_KV_KEYS = new Set(['__proto__']);

/** An edit operation cannot be applied to the current version. */
export class SecretOpError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'SecretOpError';
    }
}

/** Refuse a new payload that names a reserved key. Removal and rename-from are not new names. */
function assertNoReservedKeys(kv: SecretKv): void {
    for (const key of Object.keys(kv)) {
        if (RESERVED_KV_KEYS.has(key)) throw new SecretOpError(`Reserved key: ${key}`);
    }
}

/**
 * Apply one edit against a Map, never against a plain object: the key comes
 * from the request, and a Map has no prototype slot to fall into.
 */
function applyOp(kv: Map<string, string>, op: SecretPatchOp): void {
    // Only a write that introduces the name is refused. A remove and a
    // rename-from must be able to get an already stored `__proto__` out.
    if (op.op === 'set' && RESERVED_KV_KEYS.has(op.key)) throw new SecretOpError(`Reserved key: ${op.key}`);
    if (op.op === 'rename' && RESERVED_KV_KEYS.has(op.to)) throw new SecretOpError(`Reserved key: ${op.to}`);
    if (op.op === 'set') {
        kv.set(op.key, op.value);
        return;
    }
    if (op.op === 'remove') {
        if (!kv.has(op.key)) throw new SecretOpError(`Key '${op.key}' is not in the current version`);
        kv.delete(op.key);
        return;
    }
    if (!kv.has(op.from)) throw new SecretOpError(`Key '${op.from}' is not in the current version`);
    if (kv.has(op.to) && op.to !== op.from) throw new SecretOpError(`Key '${op.to}' already exists`);
    const value = kv.get(op.from) ?? '';
    kv.delete(op.from);
    kv.set(op.to, value);
}

export function parseEnv(text: string): SecretKv {
    if (!text) return {};
    const entries: Array<[string, string]> = [];
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
                    entries.push([key, inner
                        .replace(/\\n/g, '\n')
                        .replace(/\\r/g, '\r')
                        .replace(/\\t/g, '\t')
                        .replace(/\\"/g, '"')
                        .replace(/\\\\/g, '\\')]);
                } else {
                    entries.push([key, inner]);
                }
                continue;
            }
        }
        // Bare value: strip trailing inline comment ` #...`
        const commentIdx = rawValue.search(/\s#/);
        const trimmed = (commentIdx >= 0 ? rawValue.slice(0, commentIdx) : rawValue).trim();
        entries.push([key, trimmed]);
    }
    return Object.fromEntries(entries);
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
        // Own properties only: a bundle has no `constructor` key just because
        // the object it arrives in inherits one.
        const inE = Object.prototype.hasOwnProperty.call(existing, key);
        const inO = Object.prototype.hasOwnProperty.call(overlay, key);
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

/** Digest of the raw env file the preview read, so an import can prove it reviewed the same source. */
function fingerprintSource(text: string): string {
    return crypto.createHash('sha256').update(text, 'utf-8').digest('hex');
}

/**
 * Digest of a push target's identity (stack and env file) plus the bytes the
 * preview read. A push to a different stack or env file cannot reuse a digest
 * even when the new file happens to hold identical contents, so the apply
 * cannot bind a preview to a different target. The digest narrows, but cannot
 * eliminate, a concurrent write between the check and the write.
 */
function fingerprintTarget(stackName: string, envFileBasename: string, text: string): string {
    return crypto.createHash('sha256')
        .update(`${stackName}\0${envFileBasename}\0${text}`, 'utf-8')
        .digest('hex');
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
        // fromEntries creates own data properties, so a stored key that looks
        // like a prototype slot stays a plain key.
        const entries: Array<[string, string]> = [];
        for (const [k, v] of Object.entries(parsed)) {
            if (typeof v !== 'string') throw new SecretPayloadError();
            entries.push([k, v]);
        }
        return Object.fromEntries(entries);
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

/** Resolve a path inside the node's compose root, or null when it escapes it. */
function confineToComposeRoot(nodeId: number, candidate: string): string | null {
    const baseDir = path.resolve(FileSystemService.getInstance(nodeId).getBaseDir());
    const resolved = path.resolve(candidate);
    return isPathWithinBase(resolved, baseDir) ? resolved : null;
}

async function resolveEnvFileLocal(nodeId: number, stackName: string, basename: string): Promise<ResolvedEnvFile | null> {
    const paths = await resolveAllEnvFilePaths(nodeId, stackName);
    if (paths.length === 0) {
        if (basename === '.env') {
            const baseDir = FileSystemService.getInstance(nodeId).getBaseDir();
            const fallback = confineToComposeRoot(nodeId, path.join(baseDir, stackName, '.env'));
            if (!fallback) throw new SecretSourceError('Invalid stack path');
            return { absolutePath: fallback };
        }
        return null;
    }
    const match = paths.find(p => path.basename(p) === basename);
    if (!match) return null;
    // A compose `env_file:` entry is authored content, not a trusted path.
    const safe = confineToComposeRoot(nodeId, match);
    if (!safe) throw new SecretSourceError('Invalid env file path');
    return { absolutePath: safe };
}

/**
 * Resolve an env file on a remote node. Containment is enforced there: the
 * remote `/env` endpoint only serves a path that appears in its own resolved
 * env-file list, and this path comes from that same list.
 */
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
    const resolved = confineToComposeRoot(nodeId, absolutePath);
    if (!resolved) throw new SecretSourceError('Invalid env file path');
    try {
        return await fsService.readFile(resolved, 'utf-8');
    } catch (err) {
        const code = (err as NodeJS.ErrnoException)?.code;
        if (code === 'ENOENT') {
            if (missingAsEmpty) return '';
            throw new SecretSourceError(`${absolutePath} does not exist on this node`);
        }
        // A symlink or path that leaves the compose root is the request's
        // fault, not a server fault: answer a client error, never a bare 500.
        if (code === 'INVALID_PATH' || code === 'SYMLINK_ESCAPE') {
            throw new SecretSourceRefusedError('The env file resolves outside the compose directory');
        }
        throw err;
    }
}

async function writeEnvLocal(nodeId: number, absolutePath: string, content: string): Promise<void> {
    const fsService = FileSystemService.getInstance(nodeId);
    if (!isPathWithinBase(path.resolve(absolutePath), fsService.getBaseDir())) {
        throw new SecretSourceError('Invalid env file path');
    }
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
        // An invalid env key is a client error, so every caller can answer 400
        // instead of falling through to the generic 500.
        if (!validation.ok) throw new SecretOpError(validation.error);
        assertNoReservedKeys(input.kv);
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
        // A bundle row with no current version is a broken bundle, not an empty one.
        if (!v) throw new SecretPayloadError();
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
        if (!Object.prototype.hasOwnProperty.call(decryptKv(target.encrypted_payload), key)) {
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
        if (!Object.prototype.hasOwnProperty.call(kv, grant.key)) return { ok: false, reason: 'unknown' };
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
        const work = new Map(Object.entries(decryptKv(current.encrypted_payload)));
        for (const op of input.ops) applyOp(work, op);
        const kv: SecretKv = Object.fromEntries(work);
        const validation = validateKv(kv);
        if (!validation.ok) throw new SecretOpError(validation.error);
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

    /**
     * Recover a bundle whose current version cannot be decrypted: write a
     * complete replacement payload without reading the old one. The version
     * check still applies, and a readable bundle is refused so this never
     * becomes a second, unversioned write path behind the per-key editor.
     */
    replaceUnreadablePayload(id: number, input: {
        expectedVersion: number;
        kv: SecretKv;
        description?: string;
        user: string;
        note?: string;
    }): { version: number } {
        const db = DatabaseService.getInstance();
        const secret = db.getSecret(id);
        if (!secret) throw new Error('Secret not found');
        const current = db.getCurrentSecretVersion(id);
        // A bundle row with no current version row is unreadable too; its
        // current_version is still the guard the caller must present.
        const currentVersion = current?.version ?? secret.current_version;
        if (currentVersion !== input.expectedVersion) {
            throw new SecretVersionConflictError(currentVersion);
        }
        let unreadable = current === undefined;
        if (current) {
            try {
                decryptKv(current.encrypted_payload);
            } catch (err) {
                if (!(err instanceof SecretPayloadError)) throw err;
                unreadable = true;
            }
        }
        if (!unreadable) throw new SecretOpError('The stored payload is readable; edit individual keys instead');
        const validation = validateKv(input.kv);
        if (!validation.ok) throw new SecretOpError(validation.error);
        assertNoReservedKeys(input.kv);
        return db.updateSecretWithVersion({
            secretId: id,
            description: input.description === undefined ? null : input.description,
            encryptedPayload: encryptKv(input.kv),
            keyCount: Object.keys(input.kv).length,
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
        const kv = parseEnv(read.text);
        // An env file is a write path too: refuse a reserved name before the
        // preview shows a key the apply would then reject.
        assertNoReservedKeys(kv);
        return { kv, fingerprint: fingerprintSource(read.text) };
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

    async previewPushDiff(id: number, selector: BlueprintSelector, stackName: string, envFileBasename: string): Promise<SecretPushPreview> {
        const db = DatabaseService.getInstance();
        // Read the version row once so the version the client must present and
        // the overlay the diff was computed from are the same version.
        const versionRow = db.getCurrentSecretVersion(id);
        if (!versionRow) throw new SecretPayloadError();
        const overlay = decryptKv(versionRow.encrypted_payload);
        const matched = NodeLabelService.getInstance().matchSelector(selector, db.getNodes());
        if (isDebugEnabled()) console.log(`[Secrets:diag] preview id=${id} targets=${matched.length}`);

        // Preview is read-only and per-node; fan out in parallel for snappier wizard UX.
        const targets = await Promise.all(matched.map(async (node): Promise<SecretPushPlanEntry> => {
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
                fingerprint: null,
            };
            try {
                const read = await readExistingEnv(node, stackName, envFileBasename);
                if (!read) {
                    entry.stackExists = false;
                    entry.error = `env file '${envFileBasename}' not found`;
                    return entry;
                }
                entry.fingerprint = fingerprintTarget(stackName, envFileBasename, read.text);
                const diff = computeDiff(parseEnv(read.text), overlay);
                entry.diff = maskDiff(diff);
                Object.assign(entry, aggregateDiff(diff));
            } catch (err) {
                entry.reachable = false;
                entry.error = getErrorMessage(err, 'preview failed');
            }
            return entry;
        }));
        return { version: versionRow.version, targets };
    }

    async executePush(id: number, input: {
        selector: BlueprintSelector;
        stackName: string;
        envFileBasename: string;
        /** The bundle version the preview computed its diff from. */
        expectedVersion: number;
        /** Every target the preview resolved, with the digest of its stack, env file and contents (or null). */
        expectedTargets: Array<{ nodeId: number; fingerprint: string | null }>;
        user: string;
    }): Promise<{ pushId: string; results: SecretPushResultEntry[] }> {
        const { selector, stackName, envFileBasename, expectedVersion, expectedTargets, user } = input;
        if (activePushes.has(id)) {
            throw new PushBusyError(id);
        }
        const db = DatabaseService.getInstance();
        const secret = db.getSecret(id);
        if (!secret) throw new Error('Secret not found');
        const versionRow = db.getCurrentSecretVersion(id);
        if (!versionRow) throw new Error('Secret has no current version');
        // The bundle is the source of every value this push writes. Refuse a
        // version the operator did not preview before reading or writing a target.
        if (versionRow.version !== expectedVersion) {
            throw new SecretVersionConflictError(versionRow.version);
        }
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
            // The apply must target exactly the nodes the preview resolved. A
            // node that dropped out or appeared would make the reviewed diff
            // wrong even if every surviving file is unchanged.
            const expectedById = new Map(expectedTargets.map(target => [target.nodeId, target.fingerprint]));
            // Length plus size rejects duplicates even for a direct service caller
            // that skipped the route's own duplicate check.
            if (expectedTargets.length !== matched.length || expectedById.size !== matched.length) {
                throw new PushTargetChangedError();
            }
            for (const node of matched) {
                if (!expectedById.has(node.id)) throw new PushTargetChangedError();
            }

            // Read every target before writing any, so a stale preview refuses the
            // whole push instead of leaving some nodes on unreviewed values.
            type TargetRead = { ok: true; read: ResolvedRead | null } | { ok: false; error: unknown };
            const reads = new Map<number, TargetRead>();
            for (const node of matched) {
                try {
                    reads.set(node.id, { ok: true, read: await readExistingEnv(node, stackName, envFileBasename) });
                } catch (err) {
                    reads.set(node.id, { ok: false, error: err });
                }
            }
            for (const node of matched) {
                const state = reads.get(node.id)!;
                const expected = expectedById.get(node.id);
                // The preview read this target and it cannot be read now: its
                // contents are unverified, so refuse the whole push rather than
                // write the nodes that happen to be reachable.
                if (!state.ok) {
                    if (expected !== null) throw new PushTargetChangedError();
                    // It was unreadable at preview too, so there is nothing the
                    // operator reviewed to protect; report it per node below.
                    continue;
                }
                if (!state.read) {
                    // The preview resolved this target and it no longer resolves.
                    if (expected !== null) throw new PushTargetChangedError();
                    continue;
                }
                // A readable target the preview could not read was never
                // reviewed; a different digest means the stack, env file, or
                // contents changed after the preview.
                if (expected === null || expected === undefined || fingerprintTarget(stackName, envFileBasename, state.read.text) !== expected) {
                    throw new PushTargetChangedError();
                }
            }

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
                const state = reads.get(node.id)!;
                if (!state.ok) {
                    // The preview could not read this node either, so there is no
                    // reviewed file to protect; keep it a per-node failure.
                    result.status = 'failed';
                    result.error = getErrorMessage(state.error, 'push failed');
                } else {
                    // Re-read and re-check immediately before writing so a target
                    // that moved while earlier targets were written is not written
                    // from the preflight snapshot. A change detected here fails only
                    // this node; a stale preview is already refused before the write
                    // loop starts. The check and the write are still separate
                    // operations, so a change landing between them can race the write.
                    let read: ResolvedRead | null = null;
                    let readError: string | null = null;
                    try {
                        read = await readExistingEnv(node, stackName, envFileBasename);
                    } catch {
                        readError = 'A target env file could not be read during the push. Preview again before pushing.';
                    }
                    const expected = expectedById.get(node.id);
                    if (readError) {
                        result.status = 'failed';
                        result.error = readError;
                    } else if (!read) {
                        if (expected !== null) {
                            result.status = 'failed';
                            result.error = 'A target env file changed during the push. Preview again before pushing.';
                        } else {
                            // Still unresolved, exactly as at preview: a per-node
                            // failure, because there is no reviewed file to protect.
                            result.status = 'failed';
                            result.error = `env file '${envFileBasename}' not found`;
                        }
                    } else if (expected === null || expected === undefined
                        || fingerprintTarget(stackName, envFileBasename, read.text) !== expected) {
                        result.status = 'failed';
                        result.error = 'A target env file changed during the push. Preview again before pushing.';
                    } else {
                        try {
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
                    }
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
