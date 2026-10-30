/**
 * Recovery at boot, with the real DatabaseService: a database written by a
 * newer build (downgrade) or with an unreadable recovery version still boots
 * Sencho, leaves recovery closed, and reports why; the boot-time reconcile runs
 * before the HTTP bind and never takes startup down.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';
import { BASELINE_DB_PATH } from './helpers/testConstants';
import { RECOVERY_SCHEMA_STATE_KEY, RECOVERY_SCHEMA_VERSION } from '../services/recovery/schema';

let tmpDir: string;
const bootDirs: string[] = [];

beforeAll(async () => {
  tmpDir = await setupTestDb();
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(() => {
  for (const dir of bootDirs) fs.rmSync(dir, { recursive: true, force: true });
  cleanupTestDb(tmpDir);
});

/** Boot a fresh module graph on a copy of the baseline database with the recovery version set to `value`. */
async function bootWithRecoveryVersion(value: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sencho-recovery-boot-'));
  bootDirs.push(dir);
  const file = path.join(dir, 'sencho.db');
  fs.copyFileSync(BASELINE_DB_PATH, file);
  const raw = new Database(file);
  raw.prepare('INSERT OR REPLACE INTO system_state (key, value) VALUES (?, ?)').run(RECOVERY_SCHEMA_STATE_KEY, value);
  raw.close();
  process.env.DATA_DIR = dir;
  vi.resetModules();
  const { DatabaseService } = await import('../services/DatabaseService');
  const capability = await import('../services/recovery/capability');
  const { recoveryDb } = await import('../services/recovery/recoveryDb');
  const startup = await import('../bootstrap/startup');
  const { RecoveryOperationStore } = await import('../services/recovery/operations');
  return { db: DatabaseService.getInstance(), capability, recoveryDb, startup, RecoveryOperationStore };
}

describe('booting on a recovery schema this build cannot use', () => {
  it('boots on a newer build\'s records, leaves them alone and reports schema_newer_than_build', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const booted = await bootWithRecoveryVersion(String(RECOVERY_SCHEMA_VERSION + 1));
    expect(booted.db.getRecoverySchemaOutcome()).toEqual({ kind: 'newer', storedVersion: RECOVERY_SCHEMA_VERSION + 1 });
    expect(booted.db.getDefaultNode()).toBeTruthy();
    expect(booted.db.getSystemState(RECOVERY_SCHEMA_STATE_KEY)).toBe(String(RECOVERY_SCHEMA_VERSION + 1));
    expect(() => booted.recoveryDb()).toThrow(expect.objectContaining({ errorClass: 'schema_unsupported' }));
    expect(booted.capability.buildLocalRecoveryNodeDescriptor().volumeProtection)
      .toMatchObject({ state: 'unavailable', reason: 'schema_newer_than_build' });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('newer build'), RECOVERY_SCHEMA_VERSION + 1);

    const reconcile = vi.spyOn(booted.RecoveryOperationStore.prototype, 'reconcileAtStartup');
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    booted.startup.runRecoveryReconcile();
    expect(reconcile).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it('boots on an unreadable recovery version, logs it and reports the store unavailable', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const booted = await bootWithRecoveryVersion('1abc');
    expect(booted.db.getRecoverySchemaOutcome()).toEqual({ kind: 'failed' });
    expect(booted.db.getDefaultNode()).toBeTruthy();
    expect(error).toHaveBeenCalledWith(expect.stringContaining('Recovery schema migration failed'), expect.any(Error));
    expect(() => booted.recoveryDb()).toThrow(expect.objectContaining({ errorClass: 'schema_unsupported' }));
    expect(booted.capability.getLocalVolumeProtectionStatus())
      .toMatchObject({ state: 'unavailable', reason: 'recovery_store_unavailable' });
    const reconcile = vi.spyOn(booted.RecoveryOperationStore.prototype, 'reconcileAtStartup');
    booted.startup.runRecoveryReconcile();
    expect(reconcile).not.toHaveBeenCalled();
  });
});

describe('runRecoveryReconcile', () => {
  it('settles the previous process\'s work on a usable schema', async () => {
    const booted = await bootWithRecoveryVersion(String(RECOVERY_SCHEMA_VERSION));
    expect(booted.db.getRecoverySchemaOutcome().kind).toBe('current');
    booted.db.getDb().prepare(`
      INSERT INTO recovery_operations
        (id, idempotency_key, kind, actor, transport, state, process_epoch, created_at, updated_at)
      VALUES ('dead-op', 'dead-key', 'restore', 'admin', 'local', 'running', 'dead-epoch', 1, 1)
    `).run();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    booted.startup.runRecoveryReconcile();
    expect(booted.RecoveryOperationStore.getInstance().get('dead-op'))
      .toMatchObject({ state: 'completion_unknown', errorClass: 'interrupted' });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Recovery reconcile'), 1, 0, 0);
  });

  it('logs a failed reconcile and lets startup continue', async () => {
    const booted = await bootWithRecoveryVersion(String(RECOVERY_SCHEMA_VERSION));
    vi.spyOn(booted.RecoveryOperationStore.prototype, 'reconcileAtStartup').mockImplementation(() => {
      throw new Error('SQLITE_BUSY: database is locked');
    });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => booted.startup.runRecoveryReconcile()).not.toThrow();
    expect(error).toHaveBeenCalledWith('[Startup] Recovery reconcile failed:', expect.any(Error));
  });

  it('runs inside startServer before the HTTP bind', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'bootstrap', 'startup.ts'), 'utf8');
    const body = source.slice(source.indexOf('export async function startServer'));
    const call = body.indexOf('runRecoveryReconcile();');
    expect(call).toBeGreaterThan(0);
    expect(call).toBeLessThan(body.indexOf('server.listen('));
  });
});
