import { Router, type Request, type Response } from 'express';
import { DatabaseService } from '../services/DatabaseService';
import { SSOService, type SSOProviderConfig } from '../services/SSOService';
import { requireAdmin, requireTierForSsoProvider } from '../middleware/tierGates';
import { rejectApiTokenScope } from '../middleware/apiTokenScope';
import { sanitizeForLog } from '../utils/safeLog';
import { wouldRemoveLastProvider } from '../helpers/authenticationMode';

const VALID_SSO_PROVIDERS = ['ldap', 'oidc_google', 'oidc_github', 'oidc_okta', 'oidc_custom'] as const;
const SSO_SCOPE_MESSAGE = 'API tokens cannot access SSO configuration.';

/** Reject unknown provider ids before any tier check so invalid inputs 400 rather than leaking a tier-specific 403. */
function rejectInvalidProvider(provider: string, res: Response): boolean {
  if ((VALID_SSO_PROVIDERS as readonly string[]).includes(provider)) return false;
  res.status(400).json({ error: 'Invalid SSO provider' });
  return true;
}

function stripSecrets<T extends object>(config: T): Partial<T> {
  const copy: Partial<T> = { ...config };
  delete (copy as { ldapBindPassword?: unknown }).ldapBindPassword;
  delete (copy as { oidcClientSecret?: unknown }).oidcClientSecret;
  return copy;
}

export const ssoConfigRouter = Router();

ssoConfigRouter.get('/', (req: Request, res: Response): void => {
  if (rejectApiTokenScope(req, res, SSO_SCOPE_MESSAGE)) return;
  if (!requireAdmin(req, res)) return;
  try {
    const configs = DatabaseService.getInstance().getSSOConfigs();
    const result = configs.map(c => {
      const parsed = JSON.parse(c.config_json);
      return { ...stripSecrets(parsed), provider: c.provider, enabled: c.enabled === 1 };
    });
    res.json(result);
  } catch (error) {
    console.error('[SSO] Failed to fetch SSO configs:', error);
    res.status(500).json({ error: 'Failed to fetch SSO configuration' });
  }
});

ssoConfigRouter.get('/role-sync', (req: Request, res: Response): void => {
  if (rejectApiTokenScope(req, res, SSO_SCOPE_MESSAGE)) return;
  if (!requireAdmin(req, res)) return;
  const enabled = DatabaseService.getInstance().getGlobalSettings()['sso_role_sync'] === '1';
  res.json({ enabled });
});

ssoConfigRouter.put('/role-sync', (req: Request, res: Response): void => {
  if (rejectApiTokenScope(req, res, SSO_SCOPE_MESSAGE)) return;
  if (!requireAdmin(req, res)) return;
  const enabled = req.body?.enabled;
  if (typeof enabled !== 'boolean') {
    res.status(400).json({ error: 'enabled must be a boolean' });
    return;
  }
  try {
    DatabaseService.getInstance().updateGlobalSetting('sso_role_sync', enabled ? '1' : '0');
    console.log(`[SSO] role-sync updated: ${enabled ? 'enabled' : 'disabled'}`);
    res.json({ success: true });
  } catch (error) {
    console.error('[SSO] Failed to update role-sync setting:', error);
    res.status(500).json({ error: 'Failed to update role-sync setting' });
  }
});

ssoConfigRouter.get('/:provider', (req: Request, res: Response): void => {
  if (rejectApiTokenScope(req, res, SSO_SCOPE_MESSAGE)) return;
  if (!requireAdmin(req, res)) return;
  const provider = String(req.params.provider);
  if (rejectInvalidProvider(provider, res)) return;
  if (!requireTierForSsoProvider(provider, req, res)) return;
  try {
    const config = SSOService.getInstance().getProviderConfig(provider);
    if (!config) {
      res.status(404).json({ error: 'Provider not configured' });
      return;
    }
    res.json(stripSecrets(config));
  } catch (error) {
    console.error('[SSO] Failed to fetch SSO config:', error);
    res.status(500).json({ error: 'Failed to fetch SSO configuration' });
  }
});

ssoConfigRouter.put('/:provider', (req: Request, res: Response): void => {
  if (rejectApiTokenScope(req, res, SSO_SCOPE_MESSAGE)) return;
  if (!requireAdmin(req, res)) return;
  const provider = String(req.params.provider);
  if (rejectInvalidProvider(provider, res)) return;
  if (!requireTierForSsoProvider(provider, req, res)) return;
  try {
    const config = { ...req.body, provider } as SSOProviderConfig;

    if (config.enabled) {
      const missing: string[] = [];
      if (provider === 'ldap') {
        if (!config.ldapUrl?.trim()) missing.push('Server URL');
        if (!config.ldapSearchBase?.trim()) missing.push('Search Base');
      } else {
        if (!config.oidcClientId?.trim()) missing.push('Client ID');
        if ((provider === 'oidc_okta' || provider === 'oidc_custom') && !config.oidcIssuerUrl?.trim()) {
          missing.push('Issuer URL');
        }
      }
      if (missing.length > 0) {
        res.status(400).json({ error: `Missing required fields: ${missing.join(', ')}` });
        return;
      }
    }

    const existing = DatabaseService.getInstance().getSSOConfig(provider);
    const wasEnabled = existing?.enabled === 1;
    if (!config.enabled && wouldRemoveLastProvider(provider, wasEnabled)) {
      res.status(400).json({
        error: 'Cannot disable the last SSO provider while SSO-only mode is active. Switch to Local and SSO first, or use the emergency CLI.',
      });
      return;
    }

    SSOService.getInstance().saveProviderConfig(config);
    console.log(`[SSO] Config updated: ${sanitizeForLog(provider)} ${config.enabled ? 'enabled' : 'disabled'}`);
    res.json({ success: true, message: 'SSO configuration saved' });
  } catch (error) {
    console.error('[SSO] Failed to save SSO config:', error);
    res.status(500).json({ error: 'Failed to save SSO configuration' });
  }
});

ssoConfigRouter.delete('/:provider', (req: Request, res: Response): void => {
  if (rejectApiTokenScope(req, res, SSO_SCOPE_MESSAGE)) return;
  if (!requireAdmin(req, res)) return;
  const provider = String(req.params.provider);
  if (rejectInvalidProvider(provider, res)) return;
  if (!requireTierForSsoProvider(provider, req, res)) return;
  try {
    const existing = DatabaseService.getInstance().getSSOConfig(provider);
    const wasEnabled = existing?.enabled === 1;
    if (wouldRemoveLastProvider(provider, wasEnabled)) {
      res.status(400).json({
        error: 'Cannot delete the last SSO provider while SSO-only mode is active. Switch to Local and SSO first, or use the emergency CLI.',
      });
      return;
    }

    SSOService.getInstance().deleteProviderConfig(provider);
    console.log(`[SSO] Config deleted: ${sanitizeForLog(provider)}`);
    res.json({ success: true, message: 'SSO configuration deleted' });
  } catch (error) {
    console.error('[SSO] Failed to delete SSO config:', error);
    res.status(500).json({ error: 'Failed to delete SSO configuration' });
  }
});

ssoConfigRouter.post('/:provider/test', async (req: Request, res: Response): Promise<void> => {
  if (rejectApiTokenScope(req, res, SSO_SCOPE_MESSAGE)) return;
  if (!requireAdmin(req, res)) return;
  const provider = String(req.params.provider);
  if (rejectInvalidProvider(provider, res)) return;
  if (!requireTierForSsoProvider(provider, req, res)) return;
  try {
    if (provider === 'ldap') {
      const result = await SSOService.getInstance().testLdapConnection();
      res.json(result);
    } else {
      const result = await SSOService.getInstance().testOidcDiscovery(provider);
      res.json(result);
    }
  } catch (error) {
    console.error('[SSO] Connection test failed:', error);
    res.status(500).json({ success: false, error: 'Connection test failed' });
  }
});
