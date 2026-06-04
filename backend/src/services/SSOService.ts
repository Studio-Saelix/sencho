import crypto from 'crypto';
import { Client as LdapClient } from 'ldapts';
import {
    Configuration,
    discovery,
    buildAuthorizationUrl,
    authorizationCodeGrant,
    fetchUserInfo,
    randomState,
    randomPKCECodeVerifier,
    calculatePKCECodeChallenge,
} from 'openid-client';
import { DatabaseService, User, AuthProvider } from './DatabaseService';
import { CryptoService } from './CryptoService';
import { CacheService } from './CacheService';
import { isDebugEnabled } from '../utils/debug';

// OIDC discovery metadata changes rarely; caching it eliminates the redundant
// HTTPS round-trip between getOIDCAuthorizationUrl and handleOIDCCallback in
// the same login flow, and across back-to-back logins.
const OIDC_CONFIG_TTL_MS = 5 * 60 * 1000;
const OIDC_CONFIG_NS = 'oidc-config';

export interface SSOProviderConfig {
    provider: string;
    enabled: boolean;
    displayName: string;
    // LDAP
    ldapUrl?: string;
    ldapBindDn?: string;
    ldapBindPassword?: string;
    ldapSearchBase?: string;
    ldapSearchFilter?: string;
    ldapAdminGroupDn?: string;
    ldapDefaultRole?: 'admin' | 'viewer';
    ldapTlsRejectUnauthorized?: boolean;
    // OIDC
    oidcIssuerUrl?: string;
    oidcClientId?: string;
    oidcClientSecret?: string;
    oidcScopes?: string;
    oidcAdminClaim?: string;
    oidcAdminClaimValue?: string;
    oidcDefaultRole?: 'admin' | 'viewer';
    // Custom OIDC claim mapping
    oidcIdClaim?: string;
    oidcUsernameClaim?: string;
    oidcEmailClaim?: string;
}

export interface SSOAuthResult {
    success: boolean;
    error?: string;
    user?: {
        providerId: string;
        preferredUsername: string;
        email?: string;
        role: 'admin' | 'viewer';
    };
}

const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
    ldap: 'LDAP',
    oidc_google: 'Google',
    oidc_github: 'GitHub',
    oidc_okta: 'Okta',
    oidc_custom: 'Custom OIDC',
};

const WELL_KNOWN_ISSUERS: Record<string, string> = {
    oidc_google: 'https://accounts.google.com',
    oidc_github: 'https://github.com',
};

const LDAP_USERNAME_REGEX = /^[a-zA-Z0-9_@.-]+$/;

export class SSOService {
    private static instance: SSOService;

    public static getInstance(): SSOService {
        if (!SSOService.instance) {
            SSOService.instance = new SSOService();
        }
        return SSOService.instance;
    }

    public seedFromEnv(): void {
        this.seedLdapFromEnv();
        this.seedOidcFromEnv('oidc_google', 'SSO_OIDC_GOOGLE');
        this.seedOidcFromEnv('oidc_github', 'SSO_OIDC_GITHUB');
        this.seedOidcFromEnv('oidc_okta', 'SSO_OIDC_OKTA');
        this.seedOidcFromEnv('oidc_custom', 'SSO_OIDC_CUSTOM');

        // Warn if OIDC providers are enabled but SSO_CALLBACK_URL is not set
        if (!process.env.SSO_CALLBACK_URL) {
            const enabled = DatabaseService.getInstance().getEnabledSSOConfigs();
            const hasOidc = enabled.some(c => c.provider !== 'ldap');
            if (hasOidc) {
                console.warn('[SSO] SSO_CALLBACK_URL is not set. OAuth callback URLs will be derived from the request Host header. Set SSO_CALLBACK_URL to your external URL for deployments behind a reverse proxy.');
            }
        }
    }

    private seedLdapFromEnv(): void {
        if (!process.env.SSO_LDAP_ENABLED || process.env.SSO_LDAP_ENABLED !== 'true') return;
        const db = DatabaseService.getInstance();
        if (db.getSSOConfig('ldap')) return; // DB already has config, don't overwrite

        const cryptoSvc = CryptoService.getInstance();
        const config: SSOProviderConfig = {
            provider: 'ldap',
            enabled: true,
            displayName: process.env.SSO_LDAP_DISPLAY_NAME || 'LDAP',
            ldapUrl: process.env.SSO_LDAP_URL || '',
            ldapBindDn: process.env.SSO_LDAP_BIND_DN || '',
            ldapBindPassword: process.env.SSO_LDAP_BIND_PASSWORD || '',
            ldapSearchBase: process.env.SSO_LDAP_SEARCH_BASE || '',
            ldapSearchFilter: process.env.SSO_LDAP_SEARCH_FILTER || '(uid={{username}})',
            ldapAdminGroupDn: process.env.SSO_LDAP_ADMIN_GROUP_DN || '',
            ldapDefaultRole: (process.env.SSO_LDAP_DEFAULT_ROLE as 'admin' | 'viewer') || 'viewer',
            ldapTlsRejectUnauthorized: process.env.SSO_LDAP_TLS_REJECT_UNAUTHORIZED !== 'false',
        };

        const configForStorage = { ...config };
        if (configForStorage.ldapBindPassword) {
            configForStorage.ldapBindPassword = cryptoSvc.encrypt(configForStorage.ldapBindPassword);
        }
        db.upsertSSOConfig('ldap', true, JSON.stringify(configForStorage));
    }

    private seedOidcFromEnv(provider: string, envPrefix: string): void {
        if (!process.env[`${envPrefix}_ENABLED`] || process.env[`${envPrefix}_ENABLED`] !== 'true') return;
        const db = DatabaseService.getInstance();
        if (db.getSSOConfig(provider)) return;

        const cryptoSvc = CryptoService.getInstance();
        const config: SSOProviderConfig = {
            provider,
            enabled: true,
            displayName: process.env[`${envPrefix}_DISPLAY_NAME`] || PROVIDER_DISPLAY_NAMES[provider] || provider,
            oidcIssuerUrl: process.env[`${envPrefix}_ISSUER_URL`] || WELL_KNOWN_ISSUERS[provider] || '',
            oidcClientId: process.env[`${envPrefix}_CLIENT_ID`] || '',
            oidcClientSecret: process.env[`${envPrefix}_CLIENT_SECRET`] || '',
            oidcScopes: process.env[`${envPrefix}_SCOPES`] || 'openid email profile',
            oidcAdminClaim: process.env.SSO_OIDC_ADMIN_CLAIM || 'groups',
            oidcAdminClaimValue: process.env.SSO_OIDC_ADMIN_CLAIM_VALUE || 'sencho-admins',
            oidcDefaultRole: (process.env.SSO_DEFAULT_ROLE as 'admin' | 'viewer') || 'viewer',
            oidcIdClaim: process.env[`${envPrefix}_ID_CLAIM`] || undefined,
            oidcUsernameClaim: process.env[`${envPrefix}_USERNAME_CLAIM`] || undefined,
            oidcEmailClaim: process.env[`${envPrefix}_EMAIL_CLAIM`] || undefined,
        };

        const configForStorage = { ...config };
        if (configForStorage.oidcClientSecret) {
            configForStorage.oidcClientSecret = cryptoSvc.encrypt(configForStorage.oidcClientSecret);
        }
        db.upsertSSOConfig(provider, true, JSON.stringify(configForStorage));
        this.invalidateOIDCConfigCache(provider);
    }

    private invalidateOIDCConfigCache(provider: string): void {
        CacheService.getInstance().invalidate(`${OIDC_CONFIG_NS}:${provider}`);
    }

    // --- Config Management ---

    public getEnabledProviders(): Array<{ provider: string; displayName: string; type: 'ldap' | 'oidc' }> {
        const configs = DatabaseService.getInstance().getEnabledSSOConfigs();
        return configs.map(c => {
            const parsed = JSON.parse(c.config_json) as SSOProviderConfig;
            return {
                provider: c.provider,
                displayName: parsed.displayName || PROVIDER_DISPLAY_NAMES[c.provider] || c.provider,
                type: c.provider === 'ldap' ? 'ldap' as const : 'oidc' as const,
            };
        });
    }

    public getProviderConfig(provider: string): SSOProviderConfig | null {
        const row = DatabaseService.getInstance().getSSOConfig(provider);
        if (!row) return null;
        const config = JSON.parse(row.config_json) as SSOProviderConfig;
        config.enabled = row.enabled === 1;
        config.provider = row.provider;
        return config;
    }

    public getProviderConfigDecrypted(provider: string): SSOProviderConfig | null {
        const config = this.getProviderConfig(provider);
        if (!config) return null;
        const cryptoSvc = CryptoService.getInstance();
        if (config.ldapBindPassword && cryptoSvc.isEncrypted(config.ldapBindPassword)) {
            config.ldapBindPassword = cryptoSvc.decrypt(config.ldapBindPassword);
        }
        if (config.oidcClientSecret && cryptoSvc.isEncrypted(config.oidcClientSecret)) {
            config.oidcClientSecret = cryptoSvc.decrypt(config.oidcClientSecret);
        }
        return config;
    }

    public saveProviderConfig(config: SSOProviderConfig): void {
        const cryptoSvc = CryptoService.getInstance();
        const configForStorage = { ...config };
        if (configForStorage.ldapBindPassword && !cryptoSvc.isEncrypted(configForStorage.ldapBindPassword)) {
            configForStorage.ldapBindPassword = cryptoSvc.encrypt(configForStorage.ldapBindPassword);
        }
        if (configForStorage.oidcClientSecret && !cryptoSvc.isEncrypted(configForStorage.oidcClientSecret)) {
            configForStorage.oidcClientSecret = cryptoSvc.encrypt(configForStorage.oidcClientSecret);
        }
        DatabaseService.getInstance().upsertSSOConfig(
            config.provider,
            config.enabled,
            JSON.stringify(configForStorage)
        );
        // Client ID, secret, or issuer URL may have changed, so drop the cached Configuration.
        this.invalidateOIDCConfigCache(config.provider);
    }

    public deleteProviderConfig(provider: string): void {
        DatabaseService.getInstance().deleteSSOConfig(provider);
        this.invalidateOIDCConfigCache(provider);
    }

    // --- LDAP Authentication ---

    public async authenticateLDAP(username: string, password: string): Promise<SSOAuthResult> {
        if (!LDAP_USERNAME_REGEX.test(username)) {
            return { success: false, error: 'Invalid username format' };
        }
        if (!password) {
            return { success: false, error: 'Password is required' };
        }

        const config = this.getProviderConfigDecrypted('ldap');
        if (!config || !config.enabled) {
            return { success: false, error: 'LDAP authentication is not configured' };
        }
        if (!config.ldapUrl || !config.ldapSearchBase) {
            return { success: false, error: 'LDAP configuration is incomplete' };
        }

        const debug = isDebugEnabled();
        if (debug) console.debug('[SSO:debug] LDAP auth attempt', { username, hasBindDn: !!config.ldapBindDn, url: config.ldapUrl });

        const client = new LdapClient({
            url: config.ldapUrl,
            connectTimeout: 10000,
            tlsOptions: {
                rejectUnauthorized: config.ldapTlsRejectUnauthorized !== false,
            },
        });

        try {
            // Step 1: Bind with service account to search for the user
            if (config.ldapBindDn && config.ldapBindPassword) {
                await client.bind(config.ldapBindDn, config.ldapBindPassword);
            } else if (config.ldapBindDn && !config.ldapBindPassword) {
                console.warn('[SSO] LDAP bind DN configured but bind password is empty; anonymous bind will be used');
            }

            // Step 2: Search for the user
            const filter = (config.ldapSearchFilter || '(uid={{username}})').replace('{{username}}', this.escapeLdapFilter(username));
            const { searchEntries } = await client.search(config.ldapSearchBase, {
                scope: 'sub',
                filter,
                attributes: ['dn', 'uid', 'sAMAccountName', 'mail', 'email', 'cn', 'memberOf'],
            });

            if (searchEntries.length === 0) {
                return { success: false, error: 'Invalid credentials' };
            }

            if (searchEntries.length > 1) {
                console.warn(`[SSO] LDAP search returned ${searchEntries.length} entries for username "${username}"; using first match. Consider narrowing your search filter.`);
            }

            const userEntry = searchEntries[0];
            const userDn = userEntry.dn;
            if (debug) console.debug('[SSO:debug] LDAP user found', { dn: userDn, hasEmail: !!(userEntry['mail'] || userEntry['email']) });

            // Step 3: Bind as the user to verify their password
            await client.unbind();
            const userClient = new LdapClient({
                url: config.ldapUrl,
                connectTimeout: 10000,
                tlsOptions: {
                    rejectUnauthorized: config.ldapTlsRejectUnauthorized !== false,
                },
            });

            try {
                await userClient.bind(userDn, password);
            } catch {
                return { success: false, error: 'Invalid credentials' };
            } finally {
                try { await userClient.unbind(); } catch (e) { if (debug) console.debug('[SSO:debug] LDAP user unbind error (non-critical):', (e as Error).message); }
            }

            // Step 4: Determine role from group membership
            const role = this.resolveRoleFromLdap(userEntry, config);
            if (debug) console.debug('[SSO:debug] LDAP role resolved', { username, role });

            // Extract user info
            const preferredUsername = String(
                userEntry['sAMAccountName'] || userEntry['uid'] || userEntry['cn'] || username
            );
            const email = String(userEntry['mail'] || userEntry['email'] || '');

            return {
                success: true,
                user: {
                    providerId: userDn,
                    preferredUsername,
                    email: email || undefined,
                    role,
                },
            };
        } catch (err) {
            const message = err instanceof Error ? err.message : 'LDAP connection failed';
            console.error('[SSO] LDAP authentication error:', message);
            return { success: false, error: 'LDAP authentication failed. Check server connectivity.' };
        } finally {
            try { await client.unbind(); } catch (e) { if (debug) console.debug('[SSO:debug] LDAP service unbind error (non-critical):', (e as Error).message); }
        }
    }

    private resolveRoleFromLdap(
        userEntry: Record<string, string | string[] | Buffer | Buffer[]>,
        config: SSOProviderConfig
    ): 'admin' | 'viewer' {
        if (!config.ldapAdminGroupDn) {
            return config.ldapDefaultRole || 'viewer';
        }

        const memberOf = userEntry['memberOf'];
        if (!memberOf) return config.ldapDefaultRole || 'viewer';

        const groups = Array.isArray(memberOf)
            ? memberOf.map(g => String(g).toLowerCase())
            : [String(memberOf).toLowerCase()];

        if (groups.includes(config.ldapAdminGroupDn.toLowerCase())) {
            return 'admin';
        }
        return config.ldapDefaultRole || 'viewer';
    }

    private escapeLdapFilter(value: string): string {
        return value
            .replace(/\\/g, '\\5c')
            .replace(/\*/g, '\\2a')
            .replace(/\(/g, '\\28')
            .replace(/\)/g, '\\29')
            .replace(/\0/g, '\\00');
    }

    // --- OIDC Authentication ---

    public async getOIDCAuthorizationUrl(
        provider: string,
        callbackUrl: string
    ): Promise<{ url: string; state: string; codeVerifier: string }> {
        const config = this.getProviderConfigDecrypted(provider);
        if (!config || !config.enabled) {
            throw new Error(`SSO provider ${provider} is not configured`);
        }
        if (!config.oidcClientId) {
            throw new Error(`SSO provider ${provider} is missing client ID`);
        }

        const oidcConfig = await this.getOIDCConfig(provider, config);
        const state = randomState();
        const codeVerifier = randomPKCECodeVerifier();
        const codeChallenge = await calculatePKCECodeChallenge(codeVerifier);

        const scopes = config.oidcScopes || 'openid email profile';
        if (isDebugEnabled()) console.debug('[SSO:debug] OIDC auth URL', { provider, scopes });

        const url = buildAuthorizationUrl(oidcConfig, {
            redirect_uri: callbackUrl,
            scope: scopes,
            state,
            code_challenge: codeChallenge,
            code_challenge_method: 'S256',
        });

        return { url: url.href, state, codeVerifier };
    }

    public async handleOIDCCallback(
        provider: string,
        callbackUrl: string,
        params: { code: string; state: string },
        expectedState: string,
        codeVerifier: string
    ): Promise<SSOAuthResult> {
        const config = this.getProviderConfigDecrypted(provider);
        if (!config || !config.enabled) {
            return { success: false, error: `SSO provider ${provider} is not configured` };
        }

        try {
            const oidcConfig = await this.getOIDCConfig(provider, config);

            const currentUrl = new URL(callbackUrl);
            currentUrl.searchParams.set('code', params.code);
            currentUrl.searchParams.set('state', params.state);

            const tokens = await authorizationCodeGrant(oidcConfig, currentUrl, {
                pkceCodeVerifier: codeVerifier,
                expectedState,
            });

            let userInfo: Record<string, unknown>;

            if (provider === 'oidc_github') {
                // GitHub doesn't support standard OIDC userinfo; use their API
                userInfo = await this.fetchGitHubUserInfo(tokens.access_token);
            } else {
                const claims = tokens.claims();
                if (!claims) {
                    return { success: false, error: 'OIDC provider did not return an ID token' };
                }
                // Pass claims.sub so v6 rejects userinfo/id_token subject mismatches.
                try {
                    const info = await fetchUserInfo(oidcConfig, tokens.access_token, String(claims.sub));
                    userInfo = { ...claims, ...info };
                } catch (err) {
                    // Log so a subject-mismatch rejection is not silently hidden.
                    const message = err instanceof Error ? err.message : String(err);
                    console.warn(`[SSO] fetchUserInfo failed, falling back to id_token claims: ${message}`);
                    userInfo = { ...claims };
                }
            }

            // Use configurable claim names for custom providers, with standard OIDC fallbacks
            const idClaimName = config.oidcIdClaim || 'sub';
            const usernameClaimName = config.oidcUsernameClaim || 'preferred_username';
            const emailClaimName = config.oidcEmailClaim || 'email';

            if (isDebugEnabled()) {
                if (config.oidcIdClaim && !(config.oidcIdClaim in userInfo)) {
                    console.debug(`[SSO:debug] Custom ID claim '${config.oidcIdClaim}' not found in token; falling back to 'sub'`);
                }
                if (config.oidcUsernameClaim && !(config.oidcUsernameClaim in userInfo)) {
                    console.debug(`[SSO:debug] Custom username claim '${config.oidcUsernameClaim}' not found in token; falling back to standard claims`);
                }
                if (config.oidcEmailClaim && !(config.oidcEmailClaim in userInfo)) {
                    console.debug(`[SSO:debug] Custom email claim '${config.oidcEmailClaim}' not found in token; falling back to 'email'`);
                }
            }

            const sub = String(userInfo[idClaimName] ?? userInfo.sub ?? userInfo.id ?? '');
            if (!sub) {
                return { success: false, error: 'Could not determine user identity from provider' };
            }

            const email = String(userInfo[emailClaimName] ?? userInfo.email ?? '');
            const name = String(
                userInfo[usernameClaimName] ?? userInfo.name ?? userInfo.preferred_username ?? userInfo.login ?? email.split('@')[0] ?? `sso_${sub.substring(0, 8)}`
            );
            const role = this.resolveRoleFromOidc(userInfo, config);
            if (isDebugEnabled()) console.debug('[SSO:debug] OIDC userInfo resolved', { provider, sub, email: email || '(none)', name, role });

            return {
                success: true,
                user: {
                    providerId: sub,
                    preferredUsername: name,
                    email: email || undefined,
                    role,
                },
            };
        } catch (err) {
            const message = err instanceof Error ? err.message : 'OIDC authentication failed';
            console.error('[SSO] OIDC callback error:', message);
            return { success: false, error: 'Authentication failed. Please try again.' };
        }
    }

    private async fetchGitHubUserInfo(accessToken: string): Promise<Record<string, unknown>> {
        const [userRes, emailRes] = await Promise.all([
            fetch('https://api.github.com/user', {
                headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
            }),
            fetch('https://api.github.com/user/emails', {
                headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
            }),
        ]);

        if (!userRes.ok) {
            throw new Error(`GitHub user API returned ${userRes.status}`);
        }
        const user = await userRes.json() as Record<string, unknown>;
        let primaryEmail = '';
        try {
            const emails = await emailRes.json() as Array<{ email: string; primary: boolean }>;
            primaryEmail = emails.find(e => e.primary)?.email || emails[0]?.email || '';
        } catch { /* email fetch is best-effort */ }

        return {
            sub: String(user.id),
            id: user.id,
            login: user.login,
            name: user.name || user.login,
            email: primaryEmail || user.email,
            preferred_username: user.login,
        };
    }

    private async getOIDCConfig(
        provider: string,
        config: SSOProviderConfig,
    ): Promise<Configuration> {
        const clientId = config.oidcClientId || '';
        const clientSecret = config.oidcClientSecret || undefined;

        if (provider === 'oidc_github') {
            // GitHub is not a standard OIDC provider. Construct Configuration
            // directly from known endpoints instead of going through discovery.
            return new Configuration(
                {
                    issuer: 'https://github.com',
                    authorization_endpoint: 'https://github.com/login/oauth/authorize',
                    token_endpoint: 'https://github.com/login/oauth/access_token',
                    userinfo_endpoint: 'https://api.github.com/user',
                },
                clientId,
                clientSecret,
            );
        }

        const issuerUrl = config.oidcIssuerUrl || WELL_KNOWN_ISSUERS[provider];
        if (!issuerUrl) {
            throw new Error(`Issuer URL not configured for ${provider}`);
        }
        return CacheService.getInstance().getOrFetch(
            `${OIDC_CONFIG_NS}:${provider}`,
            OIDC_CONFIG_TTL_MS,
            () => discovery(new URL(issuerUrl), clientId, clientSecret),
        );
    }

    private resolveRoleFromOidc(userInfo: Record<string, unknown>, config: SSOProviderConfig): 'admin' | 'viewer' {
        const claimName = config.oidcAdminClaim || 'groups';
        const claimValue = config.oidcAdminClaimValue || 'sencho-admins';

        if (!claimValue) return config.oidcDefaultRole || 'viewer';

        const claim = userInfo[claimName];
        if (!claim) return config.oidcDefaultRole || 'viewer';

        if (Array.isArray(claim)) {
            if (claim.map(String).includes(claimValue)) return 'admin';
        } else if (String(claim) === claimValue) {
            return 'admin';
        }

        return config.oidcDefaultRole || 'viewer';
    }

    // --- User Provisioning ---

    public provisionUser(params: {
        authProvider: AuthProvider;
        providerId: string;
        preferredUsername: string;
        email?: string;
        role: 'admin' | 'viewer';
    }): User {
        const db = DatabaseService.getInstance();
        const debug = isDebugEnabled();
        if (debug) console.debug('[SSO:debug] provisionUser', { authProvider: params.authProvider, providerId: params.providerId, preferredUsername: params.preferredUsername, role: params.role });

        // Check if user already exists by provider identity
        const existing = db.getUserByProviderIdentity(params.authProvider, params.providerId);
        if (existing) {
            const updates: Partial<{ email: string; role: string }> = {};

            // Update email if changed
            if (params.email && params.email !== existing.email) {
                if (debug) console.debug('[SSO:debug] Email changed on re-login', {
                    userId: existing.id, username: existing.username,
                    oldEmail: existing.email || '(none)', newEmail: params.email,
                });
                updates.email = params.email;
            }

            // Sync role from identity provider on every login
            if (params.role !== existing.role) {
                updates.role = params.role;
            }

            if (Object.keys(updates).length > 0) {
                if (debug) console.debug('[SSO:debug] Updating existing user', { userId: existing.id, username: existing.username, updates });
                db.updateUser(existing.id, updates);
            }
            return db.getUser(existing.id) || existing;
        }

        const { role } = params;

        // Generate unique username
        let username = params.preferredUsername.replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 50);
        if (!username) username = 'sso_user';
        if (db.getUserByUsername(username)) {
            const suffix = params.authProvider.replace('oidc_', '');
            username = `${username}_${suffix}`;
            let counter = 2;
            const base = username;
            while (db.getUserByUsername(username)) {
                username = `${base}_${counter++}`;
            }
        }

        // Create user with unusable password hash
        const randomHash = `$sso$${crypto.randomBytes(32).toString('hex')}`;
        const id = db.addUser({
            username,
            password_hash: randomHash,
            role,
            auth_provider: params.authProvider,
            provider_id: params.providerId,
            email: params.email ?? null,
        });

        const user = db.getUser(id);
        if (!user) throw new Error('Failed to create SSO user');
        if (debug) console.debug('[SSO:debug] New user provisioned', { userId: user.id, username, role });
        return user;
    }

    // --- Test Connection ---

    public async testLdapConnection(): Promise<{ success: boolean; error?: string }> {
        const config = this.getProviderConfigDecrypted('ldap');
        if (!config || !config.ldapUrl) {
            return { success: false, error: 'LDAP not configured' };
        }

        const debug = isDebugEnabled();
        const client = new LdapClient({
            url: config.ldapUrl,
            tlsOptions: { rejectUnauthorized: config.ldapTlsRejectUnauthorized !== false },
            connectTimeout: 5000,
        });

        try {
            if (config.ldapBindDn && config.ldapBindPassword) {
                await client.bind(config.ldapBindDn, config.ldapBindPassword);
            }
            return { success: true };
        } catch (err) {
            const message = err instanceof Error ? err.message : 'Connection failed';
            return { success: false, error: message };
        } finally {
            try { await client.unbind(); } catch (e) { if (debug) console.debug('[SSO:debug] LDAP test unbind error (non-critical):', (e as Error).message); }
        }
    }

    public async testOidcDiscovery(provider: string): Promise<{ success: boolean; error?: string; issuer?: string }> {
        const config = this.getProviderConfigDecrypted(provider);
        if (!config) {
            return { success: false, error: `Provider ${provider} not configured` };
        }
        if (provider === 'oidc_github') {
            return { success: true, issuer: 'https://github.com (OAuth2, non-standard OIDC)' };
        }
        const issuerUrl = config.oidcIssuerUrl || WELL_KNOWN_ISSUERS[provider];
        if (!issuerUrl) {
            return { success: false, error: 'Issuer URL not configured' };
        }
        if (!config.oidcClientId) {
            return { success: false, error: 'Client ID is required to test discovery' };
        }

        try {
            const oidcConfig = await discovery(
                new URL(issuerUrl),
                config.oidcClientId,
                config.oidcClientSecret || undefined,
            );
            return { success: true, issuer: oidcConfig.serverMetadata().issuer };
        } catch (err) {
            const message = err instanceof Error ? err.message : 'Discovery failed';
            return { success: false, error: message };
        }
    }
}
