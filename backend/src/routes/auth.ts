import { Router, type Request, type Response } from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import crypto from 'crypto';
import { DatabaseService } from '../services/DatabaseService';
import {
  authMiddleware,
  issueSessionCookie,
  issueMfaPendingCookie,
  clearMfaPendingCookie,
  reissueSessionAfterTokenBump,
} from '../middleware/auth';
import { authRateLimiter, loginAccountRateLimiter } from '../middleware/rateLimiters';
import { requireAdmin } from '../middleware/tierGates';
import { rejectApiTokenScope } from '../middleware/apiTokenScope';
import { sanitizeForLog } from '../utils/safeLog';
import {
  BCRYPT_SALT_ROUNDS,
  COOKIE_NAME,
  MFA_PENDING_COOKIE_NAME,
  MFA_PENDING_SCOPE,
  MIN_PASSWORD_LENGTH,
} from '../helpers/constants';
import { isSecureRequest } from '../helpers/cookies';
import { isDebugEnabled } from '../utils/debug';
import { getErrorMessage } from '../utils/errors';
import { getAuthenticationMode, isLocalLoginEnabled } from '../helpers/authenticationMode';

export const authRouter = Router();

// Check if setup is needed, and whether the caller currently holds a valid
// `mfa_pending` partial-auth cookie (so the frontend can route to the
// challenge screen on a page reload mid-flow, e.g. after an OIDC redirect).
authRouter.get('/status', async (req: Request, res: Response): Promise<void> => {
  try {
    const settings = DatabaseService.getInstance().getGlobalSettings();
    const needsSetup = !settings.auth_username || !settings.auth_password_hash || !settings.auth_jwt_secret;
    const authenticationMode = getAuthenticationMode();
    const localLoginEnabled = authenticationMode !== 'sso_only';

    let mfaPending = false;
    const mfaCookie = req.cookies?.[MFA_PENDING_COOKIE_NAME];
    if (mfaCookie && settings.auth_jwt_secret) {
      try {
        const decoded = jwt.verify(mfaCookie, settings.auth_jwt_secret) as { scope?: string };
        mfaPending = decoded.scope === MFA_PENDING_SCOPE;
      } catch {
        // Expired or invalid cookie; treat as no pending challenge.
      }
    }

    res.json({ needsSetup, mfaPending, localLoginEnabled, authenticationMode });
  } catch (error) {
    console.error('Error checking setup status:', error);
    res.json({ needsSetup: true, mfaPending: false, localLoginEnabled: true, authenticationMode: 'local_and_sso' });
  }
});

// Initial setup endpoint
authRouter.post('/setup', authRateLimiter, async (req: Request, res: Response): Promise<void> => {
  try {
    const dbSvc = DatabaseService.getInstance();
    const settings = dbSvc.getGlobalSettings();
    const needsSetup = !settings.auth_username || !settings.auth_password_hash || !settings.auth_jwt_secret;
    if (!needsSetup) {
      res.status(400).json({ error: 'Setup has already been completed' });
      return;
    }

    const { username, password, confirmPassword } = req.body;

    if (!username || !password || !confirmPassword) {
      res.status(400).json({ error: 'All fields are required' });
      return;
    }

    if (username.length < 3) {
      res.status(400).json({ error: 'Username must be at least 3 characters' });
      return;
    }

    if (password.length < MIN_PASSWORD_LENGTH) {
      res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` });
      return;
    }

    if (password !== confirmPassword) {
      res.status(400).json({ error: 'Passwords do not match' });
      return;
    }

    const passwordHash = await bcrypt.hash(password, BCRYPT_SALT_ROUNDS);
    const jwtSecret = crypto.randomBytes(64).toString('hex');
    dbSvc.updateGlobalSetting('auth_username', username);
    dbSvc.updateGlobalSetting('auth_password_hash', passwordHash);
    dbSvc.updateGlobalSetting('auth_jwt_secret', jwtSecret);

    // Create admin user in users table
    dbSvc.addUser({ username, password_hash: passwordHash, role: 'admin' });

    issueSessionCookie(res, req, { username, role: 'admin', token_version: 1 }, jwtSecret);
    res.json({ success: true, message: 'Setup completed successfully' });
  } catch (error) {
    console.error('Setup error:', error);
    res.status(500).json({ error: 'Failed to complete setup' });
  }
});

// Login endpoint
authRouter.post('/login', authRateLimiter, loginAccountRateLimiter, async (req: Request, res: Response): Promise<void> => {
  const { username, password } = req.body;
  const remember = req.body.remember === true;

  if (!username || !password) {
    res.status(400).json({ error: 'Username and password are required' });
    return;
  }

  try {
    if (!isLocalLoginEnabled()) {
      res.status(403).json({
        error: 'Local password authentication is disabled. Sign in using SSO.',
      });
      return;
    }

    const db = DatabaseService.getInstance();
    const user = db.getUserByUsername(username);

    if (user) {
      const isValid = await bcrypt.compare(password, user.password_hash);
      if (isValid) {
        const settings = db.getGlobalSettings();
        const jwtSecret = settings.auth_jwt_secret;
        if (!jwtSecret) throw new Error('JWT secret missing from DB');

        // If MFA is enabled for this user, issue only the partial-auth cookie
        // and signal the client to complete the TOTP challenge. No session
        // cookie is set until the second factor is verified.
        const mfa = db.getUserMfa(user.id);
        if (isDebugEnabled()) {
          console.log('[MFA:diag] login: path=local user=', user.username, 'mfaEnabled=', !!mfa?.enabled, 'failedAttempts=', mfa?.failed_attempts ?? 0, 'lockedUntil=', mfa?.locked_until ?? null);
        }
        if (mfa?.enabled) {
          issueMfaPendingCookie(res, req, user, jwtSecret, { remember });
          console.log('[Auth] Login password OK, MFA challenge pending:', user.username);
          res.json({ success: true, mfaRequired: true });
          return;
        }

        issueSessionCookie(res, req, user, jwtSecret, remember);
        console.log('[Auth] Login successful:', user.username);
        res.json({ success: true, message: 'Login successful' });
        return;
      }
    }

    console.warn('[Auth] Login failed for username:', sanitizeForLog(username));
    res.status(401).json({ error: 'Invalid credentials' });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Login failed' });
  }
});

// Any authenticated user can change their own password.
authRouter.put('/password', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  if (rejectApiTokenScope(req, res, 'API tokens cannot change passwords.')) return;
  try {
    const { oldPassword, newPassword } = req.body;
    if (!oldPassword || !newPassword) {
      res.status(400).json({ error: 'Old password and new password are required' });
      return;
    }
    if (newPassword.length < MIN_PASSWORD_LENGTH) {
      res.status(400).json({ error: `New password must be at least ${MIN_PASSWORD_LENGTH} characters` });
      return;
    }

    const dbSvc = DatabaseService.getInstance();
    const user = dbSvc.getUserByUsername(req.user!.username);

    if (!user) {
      res.status(400).json({ error: 'User not found' });
      return;
    }

    const isValid = await bcrypt.compare(oldPassword, user.password_hash);
    if (!isValid) {
      res.status(401).json({ error: 'Invalid old password' });
      return;
    }

    const newHash = await bcrypt.hash(newPassword, BCRYPT_SALT_ROUNDS);
    dbSvc.updateUser(user.id, { password_hash: newHash });
    // Keep global_settings in sync for backward compat.
    dbSvc.updateGlobalSetting('auth_password_hash', newHash);
    // Invalidate all other sessions for this user, then re-issue the caller's
    // cookie so the current session survives the token-version bump.
    dbSvc.bumpTokenVersion(user.id);
    reissueSessionAfterTokenBump(req, res, user.id);
    console.log('[Auth] Password changed by:', req.user!.username);
    res.json({ success: true, message: 'Password updated successfully' });
  } catch (error) {
    console.error('[Auth] Password update error:', error);
    res.status(500).json({ error: 'Failed to update password' });
  }
});

authRouter.post('/logout', (req: Request, res: Response): void => {
  res.clearCookie(COOKIE_NAME, {
    httpOnly: true,
    secure: isSecureRequest(req),
    sameSite: 'strict',
  });
  // Clear any partial-auth cookie so a user aborting the MFA challenge is
  // returned to a fully unauthenticated state.
  clearMfaPendingCookie(res, req);
  res.json({ success: true, message: 'Logged out successfully' });
});

authRouter.get('/check', authMiddleware, (req: Request, res: Response): void => {
  res.json({ authenticated: true, user: req.user });
});

// Generate a long-lived node proxy token for Sencho-to-Sencho authentication.
authRouter.post('/generate-node-token', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  if (!requireAdmin(req, res)) return;
  if (rejectApiTokenScope(req, res, 'API tokens cannot generate node tokens.')) return;
  try {
    const settings = DatabaseService.getInstance().getGlobalSettings();
    const jwtSecret = settings.auth_jwt_secret;
    if (!jwtSecret) {
      res.status(500).json({ error: 'No JWT secret configured on this instance.' });
      return;
    }
    // Default 1-year expiry; admin should rotate tokens periodically.
    const token = jwt.sign({ scope: 'node_proxy' }, jwtSecret, { expiresIn: '365d' });
    res.json({ token });
  } catch (error) {
    res.status(500).json({ error: getErrorMessage(error, 'Failed to generate node token') });
  }
});
