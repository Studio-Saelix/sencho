/**
 * SSO-only single-OIDC auto-redirect decision matrix.
 *
 * Under SSO-only with exactly one OIDC provider (and no LDAP), Login should
 * send the browser to that provider's authorize URL. Local+SSO mode, LDAP,
 * multiple OIDC providers, and a returning sso_error must not auto-redirect.
 */
import { describe, it, expect } from 'vitest';
import { oidcAutoRedirectUrl } from '../Login';

const github = { provider: 'oidc_github', type: 'oidc' };
const google = { provider: 'oidc_google', type: 'oidc' };
const ldap = { provider: 'ldap', type: 'ldap' };

describe('oidcAutoRedirectUrl', () => {
  it('returns the authorize URL for SSO-only with a single OIDC provider', () => {
    expect(
      oidcAutoRedirectUrl({
        localLoginEnabled: false,
        providers: [github],
        hadSsoError: false,
      }),
    ).toBe('/api/auth/sso/oidc/oidc_github/authorize');
  });

  it('returns null when local password login is still enabled', () => {
    expect(
      oidcAutoRedirectUrl({
        localLoginEnabled: true,
        providers: [github],
        hadSsoError: false,
      }),
    ).toBeNull();
  });

  it('returns null when more than one OIDC provider is configured', () => {
    expect(
      oidcAutoRedirectUrl({
        localLoginEnabled: false,
        providers: [github, google],
        hadSsoError: false,
      }),
    ).toBeNull();
  });

  it('returns null when LDAP is present alongside a single OIDC provider', () => {
    expect(
      oidcAutoRedirectUrl({
        localLoginEnabled: false,
        providers: [github, ldap],
        hadSsoError: false,
      }),
    ).toBeNull();
  });

  it('returns null for LDAP-only SSO-only (no authorization endpoint)', () => {
    expect(
      oidcAutoRedirectUrl({
        localLoginEnabled: false,
        providers: [ldap],
        hadSsoError: false,
      }),
    ).toBeNull();
  });

  it('returns null after an SSO error so the login page can show the message', () => {
    expect(
      oidcAutoRedirectUrl({
        localLoginEnabled: false,
        providers: [github],
        hadSsoError: true,
      }),
    ).toBeNull();
  });

  it('returns null when no providers are configured', () => {
    expect(
      oidcAutoRedirectUrl({
        localLoginEnabled: false,
        providers: [],
        hadSsoError: false,
      }),
    ).toBeNull();
  });
});
