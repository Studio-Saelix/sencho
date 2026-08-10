import { Router, type Request, type Response } from 'express';
import { DatabaseService, type AuthProvider } from '../services/DatabaseService';
import { SSOService } from '../services/SSOService';
import { CryptoService } from '../services/CryptoService';
import { issueSessionCookie, issueMfaPendingCookie } from '../middleware/auth';
import { authRateLimiter, ssoRateLimiter } from '../middleware/rateLimiters';
import { isSecureRequest } from '../helpers/cookies';
import { isDebugEnabled } from '../utils/debug';
import { getErrorMessage } from '../utils/errors';
import { sanitizeForLog } from '../utils/safeLog';

// Seed SSO config from environment variables on module load. One-shot side
// effect at startup; safe to repeat (upsert).
SSOService.getInstance().seedFromEnv();

/** Derive the OAuth callback base URL from SSO_CALLBACK_URL or the request
 *  Host header, with injection validation. */
function getSSOBaseUrl(req: Request, res: Response): string | null {
  const host = req.get('host') || '';
  if (!process.env.SSO_CALLBACK_URL && /[\s<>\r\n]/.test(host)) {
    console.error('[SSO] Rejected suspicious Host header');
    res.redirect('/?sso_error=Invalid+request');
    return null;
  }
  if (!process.env.SSO_CALLBACK_URL && isDebugEnabled()) {
    console.debug('[SSO:debug] SSO_CALLBACK_URL not set; using Host header for callback URL:', sanitizeForLog(host));
  }
  return process.env.SSO_CALLBACK_URL || `${req.protocol}://${host}`;
}

export const ssoRouter = Router();

ssoRouter.get('/providers', (_req: Request, res: Response): void => {
  try {
    const providers = SSOService.getInstance().getEnabledProviders();
    res.json(providers);
  } catch (e) {
    console.warn('[SSO] Failed to list enabled providers, returning empty list:', getErrorMessage(e, 'unknown'));
    res.json([]);
  }
});

ssoRouter.post('/ldap', authRateLimiter, async (req: Request, res: Response): Promise<void> => {
  try {
    const { username, password } = req.body;
    const remember = req.body.remember === true;
    if (!username || !password) {
      res.status(400).json({ error: 'Username and password are required' });
      return;
    }

    const result = await SSOService.getInstance().authenticateLDAP(username, password);
    if (!result.success || !result.user) {
      res.status(401).json({ error: result.error || 'Authentication failed' });
      return;
    }

    const user = SSOService.getInstance().provisionUser({
      authProvider: 'ldap',
      providerId: result.user.providerId,
      preferredUsername: result.user.preferredUsername,
      email: result.user.email,
      role: result.user.role,
    });

    const settings = DatabaseService.getInstance().getGlobalSettings();

    // If MFA is enabled AND the user has opted into SSO enforcement, route
    // through the TOTP challenge. Otherwise SSO bypasses MFA (default).
    const mfa = DatabaseService.getInstance().getUserMfa(user.id);
    if (isDebugEnabled()) {
      console.log('[MFA:diag] login: path=ldap user=', user.username, 'mfaEnabled=', !!mfa?.enabled, 'ssoEnforce=', mfa?.sso_enforce_mfa === 1);
    }
    if (mfa?.enabled && mfa.sso_enforce_mfa) {
      issueMfaPendingCookie(res, req, user, settings.auth_jwt_secret, { sso: true, remember });
      console.log(`[SSO] LDAP login password OK, MFA challenge pending: ${user.username}`);
      res.json({ success: true, mfaRequired: true });
      return;
    }

    issueSessionCookie(res, req, user, settings.auth_jwt_secret, remember);
    console.log(`[SSO] LDAP login successful: ${user.username}`);
    res.json({ success: true, message: 'Login successful' });
  } catch (error) {
    const msg = getErrorMessage(error, 'LDAP login failed');
    console.error('[SSO] LDAP login error:', msg);
    res.status(500).json({ error: msg });
  }
});

ssoRouter.get('/oidc/:provider/authorize', ssoRateLimiter, async (req: Request, res: Response): Promise<void> => {
  try {
    const provider = String(req.params.provider);
    const validProviders = ['oidc_google', 'oidc_github', 'oidc_okta', 'oidc_custom'];
    if (!validProviders.includes(provider)) {
      res.status(400).json({ error: 'Invalid SSO provider' });
      return;
    }

    const baseUrl = getSSOBaseUrl(req, res);
    if (!baseUrl) return;
    const callbackUrl = `${baseUrl}/api/auth/sso/oidc/${provider}/callback`;

    const { url, state, codeVerifier } = await SSOService.getInstance().getOIDCAuthorizationUrl(provider, callbackUrl);

    // Store state + codeVerifier in an encrypted short-lived cookie.
    const cryptoSvc = CryptoService.getInstance();
    const statePayload = JSON.stringify({ state, codeVerifier, provider });
    res.cookie('sencho_sso_state', cryptoSvc.encrypt(statePayload), {
      httpOnly: true,
      secure: isSecureRequest(req),
      sameSite: 'lax', // Must be lax for cross-site IdP redirect
      maxAge: 5 * 60 * 1000, // 5 minutes
    });

    res.redirect(url);
  } catch (error) {
    const msg = getErrorMessage(error, 'SSO initialization failed');
    console.error('[SSO] OIDC authorize error:', msg);
    res.redirect(`/?sso_error=${encodeURIComponent(msg)}`);
  }
});

ssoRouter.get('/oidc/:provider/callback', ssoRateLimiter, async (req: Request, res: Response): Promise<void> => {
  try {
    const provider = String(req.params.provider);
    const code = String(req.query.code || '');
    const state = String(req.query.state || '');
    const iss = req.query.iss ? String(req.query.iss) : undefined;
    const oidcError = req.query.error ? String(req.query.error) : '';
    const error_description = req.query.error_description ? String(req.query.error_description) : '';

    if (oidcError) {
      res.redirect(`/?sso_error=${encodeURIComponent(error_description || oidcError)}`);
      return;
    }

    if (!code || !state) {
      res.redirect('/?sso_error=Missing+authorization+code');
      return;
    }

    const stateCookie = req.cookies?.sencho_sso_state;
    // Always clear the one-time state cookie, regardless of outcome.
    res.clearCookie('sencho_sso_state', { httpOnly: true, secure: isSecureRequest(req), sameSite: 'lax' });
    if (!stateCookie) {
      res.redirect('/?sso_error=SSO+session+expired.+Please+try+again.');
      return;
    }

    const cryptoSvc = CryptoService.getInstance();
    let statePayload: { state: string; codeVerifier: string; provider: string };
    try {
      statePayload = JSON.parse(cryptoSvc.decrypt(stateCookie));
    } catch (e) {
      console.error('[SSO] Failed to decrypt SSO state cookie:', getErrorMessage(e, 'unknown'));
      res.redirect('/?sso_error=Invalid+SSO+session');
      return;
    }

    if (statePayload.provider !== provider) {
      res.redirect(`/?sso_error=${encodeURIComponent(`Provider mismatch: expected ${statePayload.provider}, got ${provider}`)}`);
      return;
    }

    const baseUrl = getSSOBaseUrl(req, res);
    if (!baseUrl) return;
    const callbackUrl = `${baseUrl}/api/auth/sso/oidc/${provider}/callback`;

    const result = await SSOService.getInstance().handleOIDCCallback(
      provider, callbackUrl,
      { code, state, iss },
      statePayload.state,
      statePayload.codeVerifier,
    );

    if (!result.success || !result.user) {
      res.redirect(`/?sso_error=${encodeURIComponent(result.error || 'Authentication failed')}`);
      return;
    }

    const user = SSOService.getInstance().provisionUser({
      authProvider: provider as AuthProvider,
      providerId: result.user.providerId,
      preferredUsername: result.user.preferredUsername,
      email: result.user.email,
      role: result.user.role,
    });

    const settings = DatabaseService.getInstance().getGlobalSettings();

    // If MFA is enabled AND the user has opted into SSO enforcement, set only
    // the partial-auth cookie. The frontend surfaces the challenge screen
    // based on `/api/auth/status` after the redirect lands.
    const mfa = DatabaseService.getInstance().getUserMfa(user.id);
    if (isDebugEnabled()) {
      console.log('[MFA:diag] login: path=oidc provider=', provider, 'user=', user.username, 'mfaEnabled=', !!mfa?.enabled, 'ssoEnforce=', mfa?.sso_enforce_mfa === 1);
    }
    if (mfa?.enabled && mfa.sso_enforce_mfa) {
      issueMfaPendingCookie(res, req, user, settings.auth_jwt_secret, { sso: true });
      console.log(`[SSO] OIDC login password OK, MFA challenge pending: ${user.username} via ${provider}`);
      res.redirect('/');
      return;
    }

    issueSessionCookie(res, req, user, settings.auth_jwt_secret);
    console.log(`[SSO] OIDC login successful: ${user.username} via ${provider}`);

    res.redirect('/');
  } catch (error) {
    const msg = getErrorMessage(error, 'SSO callback failed');
    console.error('[SSO] OIDC callback error:', msg);
    res.redirect(`/?sso_error=${encodeURIComponent(msg)}`);
  }
});
