/**
 * Test DB helper - creates a temporary SQLite database, seeds it with a known
 * admin credential, and sets process.env so DatabaseService uses it.
 *
 * Call this at the top of every test file *before* importing the app,
 * because DatabaseService initialises its path on first getInstance() call.
 *
 * The baseline DB (schema + migrations + admin seed) is built once by
 * vitest globalSetup; this helper just copies it into the per-test temp
 * directory so each file pays a file-copy cost instead of a full
 * schema-init + bcrypt.hash + seed-insert.
 */
import os from 'os';
import path from 'path';
import fs from 'fs';
import {
  TEST_USERNAME,
  TEST_PASSWORD,
  TEST_JWT_SECRET,
  BASELINE_DB_PATH,
} from './testConstants';

export { TEST_USERNAME, TEST_PASSWORD, TEST_JWT_SECRET };

export async function setupTestDb(): Promise<string> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sencho-test-'));
  process.env.DATA_DIR = tmpDir;
  // Also point COMPOSE_DIR to a temp dir so FileSystemService doesn't fail on missing dir
  const composeDir = path.join(tmpDir, 'compose');
  fs.mkdirSync(composeDir, { recursive: true });
  process.env.COMPOSE_DIR = composeDir;

  if (!fs.existsSync(BASELINE_DB_PATH)) {
    throw new Error(
      `Baseline test DB not found at ${BASELINE_DB_PATH}. Vitest globalSetup ` +
      `(backend/src/__tests__/helpers/vitestGlobalSetup.ts) is responsible for ` +
      `building it; check that vitest.config.ts still wires globalSetup.`,
    );
  }
  fs.copyFileSync(BASELINE_DB_PATH, path.join(tmpDir, 'sencho.db'));

  // Initialise the DB singleton against the copied baseline. The constructor
  // re-runs initSchema() (CREATE TABLE IF NOT EXISTS no-ops) and every
  // migrate*() (idempotent per CLAUDE.md), so opening an already-migrated
  // copy is fast.
  const { DatabaseService } = await import('../../services/DatabaseService');
  const db = DatabaseService.getInstance();

  // The baseline's local node row was seeded with whatever COMPOSE_DIR was
  // at globalSetup time (undefined, so fell back to /app/compose). Each
  // test file resolves stack paths against process.env.COMPOSE_DIR via
  // FileSystemService; routes that look up the node's stored compose_dir
  // need it to match the per-file temp dir, otherwise they 400 on
  // path-traversal or 404 on missing files. Realign here.
  db.getDb().prepare('UPDATE nodes SET compose_dir = ? WHERE is_default = 1').run(composeDir);

  // Force the LicenseService singleton to materialize on the test DB. In
  // production this is wired by `bootstrap/startup.ts`; tests bypass that
  // path by importing modules directly. Without this prime, the first
  // tier check in a test runs `LicenseService.getInstance()` against a
  // singleton whose lazy-init never ran. The mocking pattern many tests
  // use (`vi.spyOn(LicenseService.getInstance(), 'getTier')`) continues
  // to work against the same singleton.
  const { LicenseService } = await import('../../services/LicenseService');
  LicenseService.getInstance();

  return tmpDir;
}

/**
 * Log in as the seeded test admin and return the session cookie string.
 * Requires `app` to be the Express instance from `index.ts`.
 */
export async function loginAsTestAdmin(app: import('express').Express): Promise<string> {
  const supertest = (await import('supertest')).default;
  const res = await supertest(app)
    .post('/api/auth/login')
    .send({ username: TEST_USERNAME, password: TEST_PASSWORD });
  const cookies = res.headers['set-cookie'] as string | string[];
  return Array.isArray(cookies) ? cookies[0] : cookies;
}

export function cleanupTestDb(tmpDir: string): void {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
}

/**
 * Seed a user with MFA enrolled. Returns the raw TOTP secret (for generating
 * valid codes in tests) and the cleartext backup codes. Callers are expected
 * to have already called `setupTestDb`.
 */
export async function seedMfaUser(
  username: string,
  password: string,
  opts: { role?: 'admin' | 'viewer' | 'deployer' | 'node-admin' | 'auditor'; ssoEnforce?: boolean } = {},
): Promise<{ userId: number; secret: string; backupCodes: string[] }> {
  const bcryptMod = (await import('bcrypt')).default;
  const { DatabaseService } = await import('../../services/DatabaseService');
  const { CryptoService } = await import('../../services/CryptoService');
  const { MfaService } = await import('../../services/MfaService');

  const db = DatabaseService.getInstance();
  const passwordHash = await bcryptMod.hash(password, 1);
  const userId = db.addUser({ username, password_hash: passwordHash, role: opts.role ?? 'viewer' });

  const secret = MfaService.generateSecret();
  const backupCodes = MfaService.generateBackupCodes();
  const hashes = await MfaService.hashBackupCodes(backupCodes);
  db.upsertUserMfa(userId, {
    enabled: true,
    totp_secret_encrypted: CryptoService.getInstance().encrypt(secret),
    backup_codes_json: JSON.stringify(hashes),
    sso_enforce_mfa: opts.ssoEnforce === true,
    failed_attempts: 0,
    locked_until: null,
  });

  return { userId, secret, backupCodes };
}

/**
 * Seed a user with MFA enrolled and return a session JWT signed with the
 * user's current token_version so tests can verify that an operation that
 * bumps it (MFA reset, password change) invalidates pre-existing sessions.
 */
export async function seedMfaUserWithToken(
  username: string,
  password: string,
): Promise<{ userId: number; secret: string; backupCodes: string[]; token: string }> {
  const { userId, secret, backupCodes } = await seedMfaUser(username, password);
  const { DatabaseService } = await import('../../services/DatabaseService');
  const jwtLib = (await import('jsonwebtoken')).default;
  const user = DatabaseService.getInstance().getUser(userId)!;
  const token = jwtLib.sign(
    { username, role: user.role, tv: user.token_version },
    TEST_JWT_SECRET,
    { expiresIn: '1m' },
  );
  return { userId, secret, backupCodes, token };
}
