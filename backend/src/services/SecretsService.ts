import path from 'path';
import crypto from 'crypto';
import { CryptoService } from './CryptoService';
import { DatabaseService, type BlueprintSelector, type Node, type SecretRow, type SecretVersionRow, type SecretPushStatus } from './DatabaseService';
import { FileSystemService } from './FileSystemService';
import { NodeLabelService } from './NodeLabelService';
import { NodeRegistry } from './NodeRegistry';
import { resolveAllEnvFilePaths } from '../routes/stacks';
import { getErrorMessage } from '../utils/errors';
import { formatNoTargetError } from '../utils/remoteTarget';

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

export interface SecretPushPlanEntry {
    nodeId: number;
    nodeName: string;
    stackName: string;
    envFileBasename: string;
    reachable: boolean;
    stackExists: boolean;
    error?: string;
    diff: SecretDiffEntry[];
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

function isLocalNode(node: Node): boolean {
    return node.type === 'local';
}

function encryptKv(kv: SecretKv): string {
    return CryptoService.getInstance().encrypt(JSON.stringify(kv));
}

function decryptKv(payload: string): SecretKv {
    if (!payload) return {};
    const plaintext = CryptoService.getInstance().decrypt(payload);
    if (!plaintext) return {};
    try {
        const parsed: unknown = JSON.parse(plaintext);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
        const out: SecretKv = {};
        for (const [k, v] of Object.entries(parsed)) {
            if (typeof v === 'string') out[k] = v;
        }
        return out;
    } catch (err) {
        console.error('[Secrets] Failed to parse decrypted payload:', err);
        return {};
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
    const target = NodeRegistry.getInstance().getProxyTarget(node.id);
    if (!target) return null;
    const baseUrl = target.apiUrl.replace(/\/$/, '');
    const headers: Record<string, string> = {};
    if (target.apiToken) headers.Authorization = `Bearer ${target.apiToken}`;
    const res = await fetch(`${baseUrl}/api/stacks/${encodeURIComponent(stackName)}/envs`, {
        headers,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
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

async function readEnvLocal(nodeId: number, absolutePath: string): Promise<string> {
    const fsService = FileSystemService.getInstance(nodeId);
    try {
        return await fsService.readFile(absolutePath, 'utf-8');
    } catch (err) {
        const code = (err as NodeJS.ErrnoException)?.code;
        if (code === 'ENOENT') return '';
        throw err;
    }
}

async function writeEnvLocal(nodeId: number, absolutePath: string, content: string): Promise<void> {
    const fsService = FileSystemService.getInstance(nodeId);
    await fsService.writeFile(absolutePath, content, 'utf-8');
}

async function readEnvRemote(node: Node, stackName: string, absolutePath: string): Promise<string> {
    const target = NodeRegistry.getInstance().getProxyTarget(node.id);
    if (!target) throw new Error(formatNoTargetError(node));
    const baseUrl = target.apiUrl.replace(/\/$/, '');
    const headers: Record<string, string> = {};
    if (target.apiToken) headers.Authorization = `Bearer ${target.apiToken}`;
    const url = new URL(`${baseUrl}/api/stacks/${encodeURIComponent(stackName)}/env`);
    if (absolutePath !== '.env') url.searchParams.set('file', absolutePath);
    const res = await fetch(url.toString(), {
        headers,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (res.status === 404) return '';
    if (!res.ok) throw new Error(`failed to read env (HTTP ${res.status})`);
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
    const res = await fetch(url.toString(), {
        method: 'PUT',
        headers,
        body: JSON.stringify({ content }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`failed to write env (HTTP ${res.status}${body ? ': ' + body.slice(0, 200) : ''})`);
    }
}

interface ResolvedRead { absolutePath: string; text: string }

async function readExistingEnv(node: Node, stackName: string, basename: string): Promise<ResolvedRead | null> {
    if (isLocalNode(node)) {
        const resolved = await resolveEnvFileLocal(node.id, stackName, basename);
        if (!resolved) return null;
        const text = await readEnvLocal(node.id, resolved.absolutePath);
        return { absolutePath: resolved.absolutePath, text };
    }
    const resolved = await resolveEnvFileRemote(node, stackName, basename);
    if (!resolved) return null;
    const text = await readEnvRemote(node, stackName, resolved.absolutePath);
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

    update(id: number, input: { description?: string; kv: SecretKv; user: string; note?: string }): { version: number } {
        const validation = validateKv(input.kv);
        if (!validation.ok) throw new Error(validation.error);
        const db = DatabaseService.getInstance();
        return db.updateSecretWithVersion({
            secretId: id,
            description: input.description === undefined ? null : input.description,
            encryptedPayload: encryptKv(input.kv),
            keyCount: Object.keys(input.kv).length,
            createdBy: input.user,
            note: input.note ?? '',
        });
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

    async importFromStack(nodeId: number, stackName: string, envFileBasename = '.env'): Promise<SecretKv> {
        const node = DatabaseService.getInstance().getNodes().find(n => n.id === nodeId);
        if (!node) throw new Error('Node not found');
        const read = await readExistingEnv(node, stackName, envFileBasename);
        if (!read) throw new Error(`env file '${envFileBasename}' not found on node ${node.name}`);
        return parseEnv(read.text);
    }

    async previewPushDiff(id: number, selector: BlueprintSelector, stackName: string, envFileBasename: string): Promise<SecretPushPlanEntry[]> {
        const db = DatabaseService.getInstance();
        const overlay = this.getDecryptedKv(id);
        const matched = NodeLabelService.getInstance().matchSelector(selector, db.getNodes());

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
                entry.diff = computeDiff(parseEnv(read.text), overlay);
                Object.assign(entry, aggregateDiff(entry.diff));
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
        return { pushId, results };
    }
}

export class PushBusyError extends Error {
    constructor(public readonly secretId: number) {
        super(`Push already running for secret ${secretId}`);
        this.name = 'PushBusyError';
    }
}
