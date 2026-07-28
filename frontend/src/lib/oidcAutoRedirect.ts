/** Authorize URL when SSO-only has exactly one OIDC provider and no LDAP; otherwise null. */
export function oidcAutoRedirectUrl(opts: {
  localLoginEnabled: boolean;
  providers: Array<{ provider: string; type: string }>;
  hadSsoError: boolean;
}): string | null {
  if (opts.localLoginEnabled || opts.hadSsoError) return null;
  if (opts.providers.some((p) => p.type === 'ldap')) return null;
  const oidc = opts.providers.filter((p) => p.type === 'oidc');
  if (oidc.length !== 1) return null;
  return `/api/auth/sso/oidc/${oidc[0].provider}/authorize`;
}
