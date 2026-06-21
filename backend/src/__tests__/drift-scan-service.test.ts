/**
 * DriftScanService: the opt-in background scanner that periodically reconciles
 * every local stack. These tests drive tick() directly (not the timer) and stub
 * reconcileNode, so they assert the gating and due-interval logic without touching
 * Docker: off => no scan, on+due => one reconcile per local node, and a second
 * tick inside the interval is skipped.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';

let tmpDir: string;
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;
let DriftLedgerService: typeof import('../services/DriftLedgerService').DriftLedgerService;
let DriftScanService: typeof import('../services/DriftScanService').DriftScanService;

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ DatabaseService } = await import('../services/DatabaseService'));
  ({ DriftLedgerService } = await import('../services/DriftLedgerService'));
  ({ DriftScanService } = await import('../services/DriftScanService'));
});

afterAll(() => cleanupTestDb(tmpDir));

function db() {
  return DatabaseService.getInstance();
}

function localNodeCount(): number {
  return db().getNodes().filter(n => n.type === 'local').length;
}

describe('DriftScanService', () => {
  beforeEach(() => {
    // Reset the singleton so each test starts with lastScanAt = 0 (a scan is due).
    (DriftScanService as unknown as { instance: unknown }).instance = null;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    db().updateGlobalSetting('drift_scan_enabled', '0');
    db().updateGlobalSetting('drift_scan_interval_minutes', '60');
  });

  it('does not scan when drift_scan_enabled is off', async () => {
    db().updateGlobalSetting('drift_scan_enabled', '0');
    const spy = vi.spyOn(DriftLedgerService.getInstance(), 'reconcileNode').mockResolvedValue({ stacks: 0, detected: 0, resolved: 0 });
    await DriftScanService.getInstance().tick();
    expect(spy).not.toHaveBeenCalled();
  });

  it('reconciles every local node when enabled and a scan is due', async () => {
    db().updateGlobalSetting('drift_scan_enabled', '1');
    db().updateGlobalSetting('drift_scan_interval_minutes', '60');
    const spy = vi.spyOn(DriftLedgerService.getInstance(), 'reconcileNode').mockResolvedValue({ stacks: 0, detected: 0, resolved: 0 });
    await DriftScanService.getInstance().tick();
    const locals = db().getNodes().filter(n => n.type === 'local');
    expect(locals.length).toBeGreaterThan(0);
    expect(spy).toHaveBeenCalledTimes(locals.length);
    for (const n of locals) expect(spy).toHaveBeenCalledWith(n.id);
  });

  it('reconciles local nodes only, never a remote node', async () => {
    db().updateGlobalSetting('drift_scan_enabled', '1');
    db().updateGlobalSetting('drift_scan_interval_minutes', '60');
    const remoteId = db().getDb().prepare(
      "INSERT INTO nodes (name, type, compose_dir, is_default, status, created_at) VALUES ('remote-scan-x', 'remote', '', 0, 'online', ?)"
    ).run(Date.now()).lastInsertRowid as number;
    const spy = vi.spyOn(DriftLedgerService.getInstance(), 'reconcileNode').mockResolvedValue({ stacks: 0, detected: 0, resolved: 0 });
    try {
      await DriftScanService.getInstance().tick();
      const localIds = db().getNodes().filter(n => n.type === 'local').map(n => n.id);
      expect(localIds.length).toBeGreaterThan(0);
      for (const id of localIds) expect(spy).toHaveBeenCalledWith(id);
      // A remote node runs its own Sencho instance and scans itself.
      expect(spy).not.toHaveBeenCalledWith(remoteId);
    } finally {
      db().getDb().prepare('DELETE FROM nodes WHERE id = ?').run(remoteId);
    }
  });

  it('skips a second tick that fires before the interval elapses', async () => {
    db().updateGlobalSetting('drift_scan_enabled', '1');
    db().updateGlobalSetting('drift_scan_interval_minutes', '60');
    const spy = vi.spyOn(DriftLedgerService.getInstance(), 'reconcileNode').mockResolvedValue({ stacks: 0, detected: 0, resolved: 0 });
    const svc = DriftScanService.getInstance();
    await svc.tick(); // due (lastScanAt = 0) => scans
    await svc.tick(); // within the 60-minute interval => skipped
    expect(spy).toHaveBeenCalledTimes(localNodeCount()); // not doubled
  });

  it('drops a tick that fires while a scan is already running', async () => {
    db().updateGlobalSetting('drift_scan_enabled', '1');
    db().updateGlobalSetting('drift_scan_interval_minutes', '60');
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const spy = vi.spyOn(DriftLedgerService.getInstance(), 'reconcileNode').mockImplementation(async () => {
      await gate; // hold the scan open so a second tick overlaps it
      return { stacks: 0, detected: 0, resolved: 0 };
    });
    const svc = DriftScanService.getInstance();
    const first = svc.tick();      // starts a scan and suspends on the gate (isScanning is now true)
    await Promise.resolve();
    await svc.tick();              // fires mid-scan => dropped by the isScanning guard
    release();
    await first;
    expect(spy).toHaveBeenCalledTimes(localNodeCount()); // only the first tick scanned
  });

  it('falls back to the default interval for an out-of-range or malformed stored value', () => {
    const svc = DriftScanService.getInstance() as unknown as { intervalMs(): number };
    const defaultMs = 60 * 60_000;
    db().updateGlobalSetting('drift_scan_interval_minutes', '99999'); // above the 1440 cap
    expect(svc.intervalMs()).toBe(defaultMs);
    db().updateGlobalSetting('drift_scan_interval_minutes', '5'); // below the 15 floor
    expect(svc.intervalMs()).toBe(defaultMs);
    db().updateGlobalSetting('drift_scan_interval_minutes', 'banana'); // not a number
    expect(svc.intervalMs()).toBe(defaultMs);
  });
});
