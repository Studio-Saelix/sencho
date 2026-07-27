import { Router, type Request, type Response } from 'express';
import { DatabaseService } from '../services/DatabaseService';
import { SSOService } from '../services/SSOService';
import { requireAdmin, requirePaid } from '../middleware/tierGates';
import { rejectApiTokenScope } from '../middleware/apiTokenScope';
import {
  getAuthenticationMode,
  isAuthenticationMode,
  setAuthenticationMode,
  type AuthenticationMode,
} from '../helpers/authenticationMode';

const SCOPE_MESSAGE = 'API tokens cannot change authentication mode.';

export const authModeRouter = Router();

authModeRouter.get('/', (req: Request, res: Response): void => {
  if (rejectApiTokenScope(req, res, SCOPE_MESSAGE)) return;
  if (!requireAdmin(req, res)) return;
  try {
    const mode = getAuthenticationMode();
    res.json({
      authenticationMode: mode,
      localLoginEnabled: mode !== 'sso_only',
    });
  } catch (error) {
    console.error('[AuthMode] Failed to read authentication mode:', error);
    res.status(500).json({ error: 'Failed to read authentication mode' });
  }
});

authModeRouter.put('/', async (req: Request, res: Response): Promise<void> => {
  if (rejectApiTokenScope(req, res, SCOPE_MESSAGE)) return;
  if (!requireAdmin(req, res)) return;

  const mode = req.body?.mode as unknown;
  if (!isAuthenticationMode(mode)) {
    res.status(400).json({ error: 'mode must be local_and_sso or sso_only' });
    return;
  }

  try {
    if (mode === 'local_and_sso') {
      setAuthenticationMode('local_and_sso');
      console.log('[AuthMode] Authentication mode set to local_and_sso');
      res.json({
        success: true,
        authenticationMode: 'local_and_sso' satisfies AuthenticationMode,
        localLoginEnabled: true,
      });
      return;
    }

    // Entering sso_only: Admiral + safety gates.
    if (!requirePaid(req, res)) return;

    if (req.body?.confirm !== true) {
      res.status(400).json({ error: 'confirm must be true to enable SSO-only mode' });
      return;
    }

    const db = DatabaseService.getInstance();
    const admin = db.getUser(req.user!.userId);
    if (!admin || admin.role !== 'admin') {
      res.status(403).json({ error: 'Administrator access required' });
      return;
    }
    if (admin.auth_provider === 'local') {
      res.status(400).json({
        error: 'Sign in with SSO as an administrator before enabling SSO-only mode',
      });
      return;
    }

    const enabled = db.getEnabledSSOConfigs();
    if (enabled.length === 0) {
      res.status(400).json({ error: 'Enable at least one SSO provider before SSO-only mode' });
      return;
    }

    const sso = SSOService.getInstance();
    let anyTestPassed = false;
    const failures: string[] = [];
    for (const config of enabled) {
      const result =
        config.provider === 'ldap'
          ? await sso.testLdapConnection()
          : await sso.testOidcDiscovery(config.provider);
      if (result.success) {
        anyTestPassed = true;
        break;
      }
      failures.push(`${config.provider}: ${result.error ?? 'connection test failed'}`);
    }
    if (!anyTestPassed) {
      res.status(400).json({
        error: 'At least one enabled SSO provider must pass a connection test',
        details: failures,
      });
      return;
    }

    setAuthenticationMode('sso_only');
    console.log('[AuthMode] Authentication mode set to sso_only');
    res.json({
      success: true,
      authenticationMode: 'sso_only' satisfies AuthenticationMode,
      localLoginEnabled: false,
    });
  } catch (error) {
    console.error('[AuthMode] Failed to update authentication mode:', error);
    res.status(500).json({ error: 'Failed to update authentication mode' });
  }
});
