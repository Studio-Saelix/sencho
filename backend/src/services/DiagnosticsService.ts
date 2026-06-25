/**
 * Read-only recovery diagnostics shared by the admin Recovery settings tab
 * (GET /api/diagnostics) and the `diagnostics` / `validate-db` emergency CLI
 * commands. It answers the first questions an operator asks when the dashboard
 * is misbehaving: is the database intact, is the encryption key present, is
 * Docker reachable, and is at least one admin able to sign in.
 *
 * The report carries no secrets. The `config` block is built from an allowlist
 * of non-sensitive global settings, so tokens, password hashes, OIDC client
 * secrets, and cloud-backup credentials can never leak into an exported bundle.
 */
import fs from 'fs';
import path from 'path';
import { DatabaseService } from './DatabaseService';
import { CryptoService } from './CryptoService';
import { getSenchoVersion } from './CapabilityRegistry';

// Tables the app cannot function without. A missing one means the schema did
// not initialize and the database should be treated as broken.
const CORE_TABLES = ['users', 'global_settings', 'sso_config', 'audit_log'] as const;

// Allowlist of global_settings keys safe to surface. Anything not listed here
// (auth_jwt_secret, auth_password_hash, cloud_backup_secret_key, OIDC/LDAP
// secrets, etc.) is omitted by construction rather than filtered out.
const SAFE_SETTING_KEYS = [
    'host_cpu_limit',
    'host_ram_limit',
    'host_disk_limit',
    'host_alerts_enabled',
    'host_alert_suppression_mins',
    'docker_janitor_gb',
    'global_crash',
    'developer_mode',
    'template_registry_url',
    'metrics_retention_hours',
    'log_retention_days',
    'audit_retention_days',
    'mesh_auto_recreate',
    'scan_history_per_image_limit',
    'cloud_backup_provider',
] as const;

export interface DiagnosticsReport {
    version: string | null;
    database: {
        ok: boolean;
        integrity: string;
        path: string;
        missingTables: string[];
    };
    encryptionKey: { present: boolean; valid: boolean };
    docker: { reachable: boolean; error?: string };
    auth: {
        adminCount: number;
        userCount: number;
        mfaEnrolledCount: number;
        ssoProviders: Array<{ provider: string; enabled: boolean }>;
    };
    config: Record<string, string>;
}

export interface CollectDiagnosticsOptions {
    /**
     * Optional Docker reachability probe. The HTTP route passes a bounded
     * `docker.ping()`; the CLI omits it because it runs without a Docker
     * connection and reports `reachable: false`.
     */
    checkDocker?: () => Promise<boolean>;
}

function dataDir(): string {
    return process.env.DATA_DIR || path.join(process.cwd(), 'data');
}

/**
 * Confirm the encryption key is on disk and actually usable: present, a 32-byte
 * hex value, and able to round-trip through CryptoService. A present-but-corrupt
 * key reads as `{ present: true, valid: false }` so the operator knows a restore
 * is needed rather than a fresh key generation.
 */
function checkEncryptionKey(): { present: boolean; valid: boolean } {
    const keyPath = path.join(dataDir(), 'encryption.key');
    if (!fs.existsSync(keyPath)) return { present: false, valid: false };
    try {
        const raw = fs.readFileSync(keyPath, 'utf-8').trim();
        if (Buffer.from(raw, 'hex').length !== 32) return { present: true, valid: false };
        const crypto = CryptoService.getInstance();
        const probe = crypto.encrypt('diagnostics-probe');
        return { present: true, valid: crypto.decrypt(probe) === 'diagnostics-probe' };
    } catch (err) {
        // The UI verdict is binary, but log the cause so an unreadable key file
        // (permissions) can be told apart from a corrupt one when debugging.
        console.warn(`[diagnostics] encryption key check failed: ${(err as Error).message}`);
        return { present: true, valid: false };
    }
}

export async function collectDiagnostics(opts: CollectDiagnosticsOptions = {}): Promise<DiagnosticsReport> {
    const db = DatabaseService.getInstance();
    const handle = db.getDb();

    // A read that may throw if its table is missing or corrupt degrades to
    // `fallback` instead of failing the whole report, and records that a read
    // failed so `database.ok` reflects it. This keeps the surface usable on the
    // broken database it exists to diagnose, without reporting a degraded `0`
    // (e.g. adminCount) as if the database were healthy.
    let readFailed = false;
    const safe = <T>(read: () => T, fallback: T, label: string): T => {
        try {
            return read();
        } catch (err) {
            readFailed = true;
            console.warn(`[diagnostics] ${label} failed: ${String((err as Error)?.message ?? err)}`);
            return fallback;
        }
    };

    let integrity: string;
    let missingTables: string[];
    let integrityOk = false;
    try {
        integrity = String(handle.pragma('integrity_check', { simple: true }));
        const present = new Set(
            (handle.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>)
                .map(row => row.name),
        );
        missingTables = CORE_TABLES.filter(table => !present.has(table));
        integrityOk = integrity === 'ok';
    } catch (err) {
        integrity = `error: ${(err as Error).message}`;
        missingTables = [];
    }

    const config = safe(() => {
        const settings = db.getGlobalSettings();
        const out: Record<string, string> = {};
        for (const key of SAFE_SETTING_KEYS) {
            if (settings[key] !== undefined) out[key] = settings[key];
        }
        return out;
    }, {}, 'global_settings read');

    const auth = {
        adminCount: safe(() => db.getAdminCount(), 0, 'getAdminCount'),
        userCount: safe(() => db.getUserCount(), 0, 'getUserCount'),
        mfaEnrolledCount: safe(() => db.getMfaEnrolledCount(), 0, 'getMfaEnrolledCount'),
        ssoProviders: safe(
            () => db.getSSOConfigs().map(c => ({ provider: c.provider, enabled: c.enabled === 1 })),
            [] as Array<{ provider: string; enabled: boolean }>,
            'getSSOConfigs',
        ),
    };

    // Reads run before this so a present-but-unreadable table (which the
    // integrity check may still call "ok") also marks the database not-ok.
    const dbOk = integrityOk && missingTables.length === 0 && !readFailed;

    let docker: DiagnosticsReport['docker'] = { reachable: false };
    if (opts.checkDocker) {
        try {
            docker = { reachable: await opts.checkDocker() };
        } catch (err) {
            docker = { reachable: false, error: (err as Error).message };
        }
    }

    return {
        version: getSenchoVersion(),
        database: { ok: dbOk, integrity, path: handle.name, missingTables },
        encryptionKey: checkEncryptionKey(),
        docker,
        auth,
        config,
    };
}
