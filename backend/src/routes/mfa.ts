import { Router, type Request, type Response } from 'express';
import jwt from 'jsonwebtoken';
import { DatabaseService, type UserMfa } from '../services/DatabaseService';
import { MfaService } from '../services/MfaService';
import { CryptoService } from '../services/CryptoService';
import {
  authMiddleware,
  issueSessionCookie,
  clearMfaPendingCookie,
  reissueSessionAfterTokenBump,
} from '../middleware/auth';
import { authRateLimiter } from '../middleware/rateLimiters';
import { rejectApiTokenScope } from '../middleware/apiTokenScope';
import {
  MFA_PENDING_COOKIE_NAME,
  MFA_PENDING_SCOPE,
} from '../helpers/constants';
import { isDebugEnabled } from '../utils/debug';
import { getErrorMessage } from '../utils/errors';

// Lockout: MFA_MAX_FAILED bad verifications in a row lock the account for
// MFA_LOCKOUT_MS. Used only in the login/mfa handler; other endpoints
// require a fresh TOTP/backup code but don't count toward the lockout.
const MFA_MAX_FAILED = 5;
const MFA_LOCKOUT_MS = 15 * 60 * 1000;

const MFA_SCOPE_MESSAGE = 'API tokens cannot manage MFA.';

/**
 * Gate an MFA management endpoint: require an authenticated user session
 * (not an API token) with MFA already enabled + a stored TOTP secret.
 * Writes the appropriate error response and returns null on any failure;
 * callers should early-return when null is returned.
 */
function requireEnrolledMfaUser(req: Request, res: Response): { userId: number; mfa: UserMfa } | null {
  if (!req.user) {
    res.status(401).json({ error: 'Authentication required' });
    return null;
  }
  if (rejectApiTokenScope(req, res, MFA_SCOPE_MESSAGE)) return null;
  const mfa = DatabaseService.getInstance().getUserMfa(req.user.userId);
  if (!mfa?.enabled || !mfa.totp_secret_encrypted) {
    res.status(400).json({ error: 'Two-factor authentication is not enabled' });
    return null;
  }
  return { userId: req.user.userId, mfa };
}

export const mfaRouter = Router();

/**
 * Complete the second factor of login. Consumes the short-lived
 * `sencho_mfa_pending` cookie and, on success, clears it and issues a full
 * session cookie. Accepts either a 6-digit TOTP or one of the user's backup
 * codes (single-use). Enforces per-user failure counter and lockout.
 */
mfaRouter.post('/login/mfa', authRateLimiter, async (req: Request, res: Response): Promise<void> => {
  const startedAt = Date.now();
  try {
    const db = DatabaseService.getInstance();
    const settings = db.getGlobalSettings();
    const jwtSecret = settings.auth_jwt_secret;
    if (!jwtSecret) {
      res.status(500).json({ error: 'Server is not configured' });
      return;
    }

    const pendingCookie = req.cookies?.[MFA_PENDING_COOKIE_NAME];
    if (!pendingCookie) {
      if (isDebugEnabled()) console.log('[MFA:diag] login/mfa: no pending cookie');
      res.status(401).json({ error: 'No pending two-factor challenge. Please sign in again.' });
      return;
    }

    let decoded: { scope?: string; user_id?: number; username?: string; sso?: boolean };
    try {
      decoded = jwt.verify(pendingCookie, jwtSecret) as typeof decoded;
    } catch {
      clearMfaPendingCookie(res, req);
      if (isDebugEnabled()) console.log('[MFA:diag] login/mfa: pending cookie expired or invalid');
      res.status(401).json({ error: 'Two-factor challenge expired. Please sign in again.' });
      return;
    }

    if (decoded.scope !== MFA_PENDING_SCOPE || typeof decoded.user_id !== 'number') {
      clearMfaPendingCookie(res, req);
      if (isDebugEnabled()) console.log('[MFA:diag] login/mfa: bad cookie scope=', decoded.scope, 'userId=', decoded.user_id);
      res.status(401).json({ error: 'Invalid two-factor challenge' });
      return;
    }

    const user = db.getUserById(decoded.user_id);
    const mfa = db.getUserMfa(decoded.user_id);
    if (!user || !mfa?.enabled || !mfa.totp_secret_encrypted) {
      clearMfaPendingCookie(res, req);
      if (isDebugEnabled()) console.log('[MFA:diag] login/mfa: mfa not configured for userId=', decoded.user_id);
      res.status(401).json({ error: 'Two-factor authentication is not configured' });
      return;
    }

    if (isDebugEnabled()) {
      console.log('[MFA:diag] login/mfa: entry user=', user.username, 'sso=', !!decoded.sso, 'failedAttempts=', mfa.failed_attempts, 'lockedUntil=', mfa.locked_until ?? null, 'lockedRemainingMs=', mfa.locked_until ? Math.max(0, mfa.locked_until - Date.now()) : 0);
    }

    if (mfa.locked_until && mfa.locked_until > Date.now()) {
      const retryAfter = Math.ceil((mfa.locked_until - Date.now()) / 1000);
      res.setHeader('Retry-After', String(retryAfter));
      if (isDebugEnabled()) console.log('[MFA:diag] login/mfa: rejected (locked) user=', user.username, 'retryAfter=', retryAfter);
      res.status(423).json({ error: 'Too many failed attempts. Try again later.', retryAfter });
      return;
    }

    const rawCode = typeof req.body?.code === 'string' ? req.body.code : '';
    const isBackup = req.body?.isBackupCode === true;
    if (!rawCode) {
      res.status(400).json({ error: 'A verification code is required' });
      return;
    }

    const cryptoSvc = CryptoService.getInstance();
    const secret = cryptoSvc.decrypt(mfa.totp_secret_encrypted);
    let verified = false;

    if (isBackup) {
      const hashes: string[] = mfa.backup_codes_json ? JSON.parse(mfa.backup_codes_json) : [];
      const bcryptStart = Date.now();
      const result = await MfaService.verifyBackupCode(hashes, rawCode);
      const bcryptMs = Date.now() - bcryptStart;
      if (isDebugEnabled()) console.log('[MFA:diag] login/mfa: branch=backup user=', user.username, 'matched=', result.matched, 'bcryptMs=', bcryptMs, 'hashesChecked=', hashes.length);
      if (bcryptMs > 500) console.warn('[MFA] Slow backup-code verify for user=', user.username, 'durationMs=', bcryptMs);
      if (result.matched) {
        // Consume the matched hash atomically. A concurrent request carrying
        // the same code that already consumed it makes this return false, so
        // exactly one login wins: single-use is enforced at the write, not from
        // the in-memory snapshot read above.
        if (db.consumeBackupCodeHash(decoded.user_id, result.matchedHash)) {
          verified = true;
        } else if (isDebugEnabled()) {
          console.log('[MFA:diag] login/mfa: backup code already consumed (concurrent use) user=', user.username);
        }
      }
    } else {
      const trimmed = rawCode.trim().replace(/\s+/g, '');
      const totpOk = MfaService.verifyTotp(secret, trimmed);
      const window = MfaService.currentWindow();
      if (isDebugEnabled()) console.log('[MFA:diag] login/mfa: branch=totp user=', user.username, 'formatOk=', /^\d{6}$/.test(trimmed), 'totpOk=', totpOk, 'window=', window);
      if (totpOk) {
        if (db.isMfaCodeUsed(decoded.user_id, trimmed, window)) {
          db.recordMfaFailure(decoded.user_id);
          if (isDebugEnabled()) console.log('[MFA:diag] login/mfa: replay rejected user=', user.username, 'window=', window);
          res.status(401).json({ error: 'This code was already used. Please wait for the next one.', code: 'OTP_REPLAY' });
          return;
        }
        db.markMfaCodeUsed(decoded.user_id, trimmed, window);
        verified = true;
      }
    }

    if (!verified) {
      const failedCount = db.recordMfaFailure(decoded.user_id);
      if (isDebugEnabled()) console.log('[MFA:diag] login/mfa: verify failed user=', user.username, 'failedCount=', failedCount, 'lockoutThreshold=', MFA_MAX_FAILED);
      if (failedCount >= MFA_MAX_FAILED) {
        const lockedUntil = Date.now() + MFA_LOCKOUT_MS;
        db.lockMfa(decoded.user_id, lockedUntil);
        res.setHeader('Retry-After', String(Math.ceil(MFA_LOCKOUT_MS / 1000)));
        console.warn('[MFA] Lockout engaged: user=', user.username, 'lockedUntil=', new Date(lockedUntil).toISOString());
        res.status(423).json({ error: 'Too many failed attempts. Try again later.', retryAfter: Math.ceil(MFA_LOCKOUT_MS / 1000) });
        return;
      }
      res.status(401).json({ error: 'Invalid verification code' });
      return;
    }

    db.clearMfaFailures(decoded.user_id);
    clearMfaPendingCookie(res, req);
    issueSessionCookie(res, req, user, jwtSecret);
    console.log('[Auth] MFA challenge cleared:', user.username);
    if (isDebugEnabled()) console.log('[MFA:diag] login/mfa: success user=', user.username, 'durationMs=', Date.now() - startedAt);
    res.json({ success: true });
  } catch (error) {
    console.error('[Auth] MFA verification error:', getErrorMessage(error, 'unknown'));
    res.status(500).json({ error: 'Two-factor verification failed' });
  }
});

/** Report the current user's MFA state. Used by the Account settings UI. */
mfaRouter.get('/mfa/status', authMiddleware, (req: Request, res: Response): void => {
  try {
    if (!req.user) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    const db = DatabaseService.getInstance();
    const mfa = db.getUserMfa(req.user.userId);
    const hashes: string[] = mfa?.backup_codes_json ? JSON.parse(mfa.backup_codes_json) : [];
    res.json({
      enabled: mfa?.enabled === 1,
      backupCodesRemaining: hashes.length,
      sso_enforce_mfa: mfa?.sso_enforce_mfa === 1,
    });
  } catch (error) {
    console.error('[MFA] status error:', getErrorMessage(error, 'unknown'));
    res.status(500).json({ error: 'Failed to load MFA status' });
  }
});

/**
 * Begin enrolment: generate a fresh TOTP secret, store it encrypted with
 * `enabled=0`, and return the otpauth URI plus the raw base32 secret so the
 * frontend can render a QR code and the manual-entry fallback.
 */
mfaRouter.post('/mfa/enroll/start', authMiddleware, (req: Request, res: Response): void => {
  try {
    if (!req.user) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    if (rejectApiTokenScope(req, res, MFA_SCOPE_MESSAGE)) return;
    const db = DatabaseService.getInstance();
    const existing = db.getUserMfa(req.user.userId);
    if (existing?.enabled) {
      res.status(409).json({ error: 'Two-factor authentication is already enabled' });
      return;
    }
    if (isDebugEnabled()) {
      console.log('[MFA:diag] enroll/start user=', req.user.username, 'hadPendingSecret=', Boolean(existing?.totp_secret_encrypted));
    }

    const secret = MfaService.generateSecret();
    const cryptoSvc = CryptoService.getInstance();
    db.upsertUserMfa(req.user.userId, {
      enabled: false,
      totp_secret_encrypted: cryptoSvc.encrypt(secret),
      backup_codes_json: null,
      failed_attempts: 0,
      locked_until: null,
    });

    const otpauthUri = MfaService.buildOtpauthUri(secret, req.user.username);
    res.json({ otpauthUri, secret });
  } catch (error) {
    console.error('[MFA] enroll start error:', getErrorMessage(error, 'unknown'));
    res.status(500).json({ error: 'Failed to start enrolment' });
  }
});

/**
 * Finalise enrolment: verify the user's first TOTP against the pending
 * secret, flip `enabled=1`, generate + hash + return the backup codes ONCE,
 * and bump `token_version` so any other sessions re-authenticate.
 */
mfaRouter.post('/mfa/enroll/confirm', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  try {
    if (!req.user) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    if (rejectApiTokenScope(req, res, MFA_SCOPE_MESSAGE)) return;
    const code = typeof req.body?.code === 'string' ? req.body.code : '';
    if (!code) {
      res.status(400).json({ error: 'A verification code is required' });
      return;
    }

    const db = DatabaseService.getInstance();
    const mfa = db.getUserMfa(req.user.userId);
    if (!mfa?.totp_secret_encrypted) {
      res.status(400).json({ error: 'No enrolment in progress. Start enrolment first.' });
      return;
    }
    if (mfa.enabled) {
      res.status(409).json({ error: 'Two-factor authentication is already enabled' });
      return;
    }

    const cryptoSvc = CryptoService.getInstance();
    const secret = cryptoSvc.decrypt(mfa.totp_secret_encrypted);
    if (!MfaService.verifyTotp(secret, code)) {
      res.status(401).json({ error: 'Invalid verification code' });
      return;
    }

    const backupCodes = MfaService.generateBackupCodes();
    const hashes = await MfaService.hashBackupCodes(backupCodes);
    db.upsertUserMfa(req.user.userId, {
      enabled: true,
      backup_codes_json: JSON.stringify(hashes),
      failed_attempts: 0,
      locked_until: null,
    });
    db.bumpTokenVersion(req.user.userId);
    // The bump invalidates the caller's cookie; they just proved TOTP
    // possession so they can be resealed under the new token_version.
    reissueSessionAfterTokenBump(req, res, req.user.userId);

    console.log('[MFA] Enrolment completed:', req.user.username);
    if (isDebugEnabled()) {
      console.log('[MFA:diag] enroll/confirm backupCodesIssued=', backupCodes.length, 'user=', req.user.username);
    }
    res.json({ backupCodes: backupCodes.map((c) => MfaService.formatBackupCodeForDisplay(c)) });
  } catch (error) {
    console.error('[MFA] enroll confirm error:', getErrorMessage(error, 'unknown'));
    res.status(500).json({ error: 'Failed to confirm enrolment' });
  }
});

/**
 * Disable MFA for the current user. Requires a valid TOTP or backup code to
 * prove possession, so a stolen session cookie alone cannot turn off the
 * second factor. Bumps `token_version` on success.
 */
mfaRouter.post('/mfa/disable', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  try {
    const gate = requireEnrolledMfaUser(req, res);
    if (!gate) return;
    const { userId, mfa } = gate;

    const code = typeof req.body?.code === 'string' ? req.body.code : '';
    const isBackup = req.body?.isBackupCode === true;
    if (!code) {
      res.status(400).json({ error: 'A verification code is required to disable two-factor authentication' });
      return;
    }

    let ok = false;
    if (isBackup) {
      const hashes: string[] = mfa.backup_codes_json ? JSON.parse(mfa.backup_codes_json) : [];
      ok = (await MfaService.verifyBackupCode(hashes, code)).matched;
    } else {
      const cryptoSvc = CryptoService.getInstance();
      ok = MfaService.verifyTotp(cryptoSvc.decrypt(mfa.totp_secret_encrypted!), code);
    }

    if (isDebugEnabled()) {
      console.log('[MFA:diag] disable user=', req.user!.username, 'codeType=', isBackup ? 'backup' : 'totp', 'verified=', ok);
    }

    if (!ok) {
      res.status(401).json({ error: 'Invalid verification code' });
      return;
    }

    const db = DatabaseService.getInstance();
    db.deleteUserMfa(userId);
    db.bumpTokenVersion(userId);
    // The user just proved possession of a current factor, so reseal their
    // cookie under the new token_version to avoid a surprising forced re-login.
    reissueSessionAfterTokenBump(req, res, userId);

    console.log('[MFA] Disabled by user:', req.user!.username);
    res.json({ success: true });
  } catch (error) {
    console.error('[MFA] disable error:', getErrorMessage(error, 'unknown'));
    res.status(500).json({ error: 'Failed to disable two-factor authentication' });
  }
});

/**
 * Regenerate backup codes. Requires a valid TOTP so a stolen session alone
 * cannot print new codes. The old set is invalidated immediately; the new
 * set is returned in cleartext ONCE.
 */
mfaRouter.post('/mfa/backup-codes/regenerate', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  try {
    const gate = requireEnrolledMfaUser(req, res);
    if (!gate) return;
    const { userId, mfa } = gate;

    const code = typeof req.body?.code === 'string' ? req.body.code : '';
    if (!code) {
      res.status(400).json({ error: 'A verification code is required' });
      return;
    }

    const cryptoSvc = CryptoService.getInstance();
    if (!MfaService.verifyTotp(cryptoSvc.decrypt(mfa.totp_secret_encrypted!), code)) {
      res.status(401).json({ error: 'Invalid verification code' });
      return;
    }

    const backupCodes = MfaService.generateBackupCodes();
    const hashes = await MfaService.hashBackupCodes(backupCodes);
    DatabaseService.getInstance().upsertUserMfa(userId, { backup_codes_json: JSON.stringify(hashes) });
    console.log('[MFA] Backup codes regenerated:', req.user!.username);
    if (isDebugEnabled()) {
      console.log('[MFA:diag] backup-codes/regenerate user=', req.user!.username, 'codesIssued=', backupCodes.length);
    }
    res.json({ backupCodes: backupCodes.map((c) => MfaService.formatBackupCodeForDisplay(c)) });
  } catch (error) {
    console.error('[MFA] regenerate backup codes error:', getErrorMessage(error, 'unknown'));
    res.status(500).json({ error: 'Failed to regenerate backup codes' });
  }
});

/** Toggle whether SSO logins must also complete the TOTP challenge. */
mfaRouter.put('/mfa/sso-bypass', authMiddleware, (req: Request, res: Response): void => {
  try {
    const gate = requireEnrolledMfaUser(req, res);
    if (!gate) return;
    const { userId, mfa } = gate;

    const enforce = req.body?.enforce === true;
    if ((mfa.sso_enforce_mfa === 1) !== enforce) {
      DatabaseService.getInstance().upsertUserMfa(userId, { sso_enforce_mfa: enforce });
      console.log('[MFA] SSO bypass toggled:', req.user!.username, 'enforce=', enforce);
    }
    res.json({ success: true, sso_enforce_mfa: enforce });
  } catch (error) {
    console.error('[MFA] sso-bypass error:', getErrorMessage(error, 'unknown'));
    res.status(500).json({ error: 'Failed to update SSO enforcement' });
  }
});
