/**
 * Tests for LicenseService: tier computation, lifetime detection, and
 * getLicenseInfo() output across all license states.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';

let tmpDir: string;
let svc: import('../services/LicenseService').LicenseService;
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;

beforeAll(async () => {
  tmpDir = await setupTestDb();
  const licMod = await import('../services/LicenseService');
  svc = licMod.LicenseService.getInstance();
  ({ DatabaseService } = await import('../services/DatabaseService'));
});

afterAll(() => {
  cleanupTestDb(tmpDir);
});

function setLicenseState(overrides: Record<string, string>) {
  const db = DatabaseService.getInstance();
  const keys = [
    'license_status', 'license_key', 'license_valid_until',
    'license_last_validated', 'license_customer_name',
    'license_product_name',
    'billing_portal_url', 'billing_portal_expires',
  ];
  for (const key of keys) {
    db.setSystemState(key, '');
  }
  for (const [key, value] of Object.entries(overrides)) {
    db.setSystemState(key, value);
  }
}

describe('LicenseService.getTier()', () => {
  it('returns "community" when no status is set', () => {
    setLicenseState({});
    DatabaseService.getInstance().setSystemState('license_status', '');
    expect(svc.getTier()).toBe('community');
  });

  it('returns "community" for community status', () => {
    setLicenseState({ license_status: 'community' });
    expect(svc.getTier()).toBe('community');
  });

  it('returns "community" for expired status', () => {
    setLicenseState({ license_status: 'expired' });
    expect(svc.getTier()).toBe('community');
  });

  it('returns "community" for disabled status', () => {
    setLicenseState({ license_status: 'disabled' });
    expect(svc.getTier()).toBe('community');
  });

  it('returns "paid" for active status with valid license', () => {
    setLicenseState({
      license_status: 'active',
      license_last_validated: Date.now().toString(),
    });
    expect(svc.getTier()).toBe('paid');
  });

  it('returns "paid" for active trial', () => {
    const future = new Date();
    future.setDate(future.getDate() + 7);
    setLicenseState({
      license_status: 'trial',
      license_valid_until: future.toISOString(),
    });
    expect(svc.getTier()).toBe('paid');
  });

  it('returns "community" for expired trial', () => {
    const past = new Date();
    past.setDate(past.getDate() - 1);
    setLicenseState({
      license_status: 'trial',
      license_valid_until: past.toISOString(),
    });
    expect(svc.getTier()).toBe('community');
  });

  it('returns "paid" for lifetime license (no expiry)', () => {
    setLicenseState({
      license_status: 'active',
      license_key: 'test-key-1234',
      license_last_validated: Date.now().toString(),
    });
    expect(svc.getTier()).toBe('paid');
  });
});

describe('LicenseService.getLicenseInfo() - isLifetime', () => {
  it('sets isLifetime=true for active license with key and no expiry', () => {
    setLicenseState({
      license_status: 'active',
      license_key: 'test-key-1234',
      license_last_validated: Date.now().toString(),
    });
    const info = svc.getLicenseInfo();
    expect(info.isLifetime).toBe(true);
    expect(info.trialDaysRemaining).toBeNull();
  });

  it('sets isLifetime=false for active subscription with expiry', () => {
    const future = new Date();
    future.setDate(future.getDate() + 30);
    setLicenseState({
      license_status: 'active',
      license_key: 'test-key-1234',
      license_valid_until: future.toISOString(),
      license_last_validated: Date.now().toString(),
    });
    const info = svc.getLicenseInfo();
    expect(info.isLifetime).toBe(false);
    expect(info.trialDaysRemaining).toBeNull();
  });

  it('sets isLifetime=false for trial licenses', () => {
    const future = new Date();
    future.setDate(future.getDate() + 14);
    setLicenseState({
      license_status: 'trial',
      license_valid_until: future.toISOString(),
    });
    const info = svc.getLicenseInfo();
    expect(info.isLifetime).toBe(false);
    expect(info.trialDaysRemaining).toBeGreaterThan(0);
  });

  it('sets isLifetime=false for community status', () => {
    setLicenseState({ license_status: 'community' });
    const info = svc.getLicenseInfo();
    expect(info.isLifetime).toBe(false);
    expect(info.trialDaysRemaining).toBeNull();
  });
});

describe('LicenseService.getLicenseInfo() - full scenarios', () => {
  it('returns correct info for a paid lifetime license', () => {
    setLicenseState({
      license_status: 'active',
      license_key: 'ABCD-EFGH-IJKL-MN5D',
      license_customer_name: 'Test User',
      license_product_name: 'Sencho Admiral',
      license_last_validated: Date.now().toString(),
    });
    const info = svc.getLicenseInfo();
    expect(info.tier).toBe('paid');
    expect(info.status).toBe('active');
    expect(info.isLifetime).toBe(true);
    expect(info.trialDaysRemaining).toBeNull();
    expect(info.customerName).toBe('Test User');
    expect(info.productName).toBe('Sencho Admiral');
    expect(info.maskedKey).toBe('****-****-****-MN5D');
  });

  it('returns correct info for a paid subscription', () => {
    const future = new Date();
    future.setDate(future.getDate() + 30);
    setLicenseState({
      license_status: 'active',
      license_key: 'ABCD-EFGH-IJKL-SK5D',
      license_customer_name: 'Another User',
      license_product_name: 'Sencho Admiral',
      license_valid_until: future.toISOString(),
      license_last_validated: Date.now().toString(),
    });
    const info = svc.getLicenseInfo();
    expect(info.tier).toBe('paid');
    expect(info.status).toBe('active');
    expect(info.isLifetime).toBe(false);
    expect(info.trialDaysRemaining).toBeNull();
    expect(info.customerName).toBe('Another User');
  });
});

describe('LicenseService.initialize()', () => {
  // initialize() starts a 72h validation interval; tear it down so vitest's worker
  // does not inherit the timer into sibling test files.
  afterAll(() => {
    svc.destroy();
  });

  it('does not auto-start a trial on first boot', () => {
    const db = DatabaseService.getInstance();
    db.setSystemState('instance_id', '');
    db.setSystemState('license_status', '');
    db.setSystemState('license_valid_until', '');

    svc.initialize();

    expect(db.getSystemState('instance_id')).toBeTruthy();
    expect(db.getSystemState('license_status')).toBe('');
    expect(db.getSystemState('license_valid_until')).toBe('');
    expect(svc.getTier()).toBe('community');
  });
});
