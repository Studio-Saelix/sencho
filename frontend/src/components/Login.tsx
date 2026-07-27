import { useEffect, useState } from 'react';
import { useAuth } from '@/context/AuthContext';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ArrowRight, KeyRound, Loader2 } from 'lucide-react';
import { AuthCanvas } from '@/components/auth/AuthCanvas';
import { AuthStepHeader } from '@/components/auth/AuthStepHeader';
import { ErrorRail } from '@/components/auth/ErrorRail';

interface SSOProvider {
  provider: string;
  displayName: string;
  type: 'ldap' | 'oidc';
}

const INPUT_CLASS =
  'h-11 bg-background/60 border-card-border font-sans text-base shadow-[inset_0_2px_4px_0_oklch(0_0_0/0.25)] placeholder:text-stat-subtitle/60 focus-visible:border-brand/60 focus-visible:ring-2 focus-visible:ring-brand/40 focus-visible:ring-offset-0';

function getProviderIcon(provider: string) {
  switch (provider) {
    case 'oidc_google':
      return (
        <svg className="h-4 w-4" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
          <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" />
          <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
          <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" />
          <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
        </svg>
      );
    case 'oidc_github':
      return (
        <svg className="h-4 w-4" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
          <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z" />
        </svg>
      );
    case 'oidc_okta':
      return (
        <svg className="h-4 w-4" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
          <path d="M12 0C5.389 0 0 5.389 0 12s5.389 12 12 12 12-5.389 12-12S18.611 0 12 0zm0 18c-3.314 0-6-2.686-6-6s2.686-6 6-6 6 2.686 6 6-2.686 6-6 6z" />
        </svg>
      );
    case 'oidc_custom':
    default:
      return <KeyRound className="h-4 w-4" strokeWidth={1.5} aria-hidden />;
  }
}

export function Login({ className, ...props }: React.ComponentPropsWithoutRef<'div'>) {
  const { login, ssoLdapLogin } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(() => {
    const params = new URLSearchParams(window.location.search);
    const ssoError = params.get('sso_error');
    if (ssoError) {
      window.history.replaceState({}, '', window.location.pathname);
      return ssoError;
    }
    return '';
  });
  const [isLoading, setIsLoading] = useState(false);
  const [loginMode, setLoginMode] = useState<'local' | 'ldap'>('local');
  const [ssoProviders, setSsoProviders] = useState<SSOProvider[]>([]);
  const [localLoginEnabled, setLocalLoginEnabled] = useState(true);
  const [discoveryError, setDiscoveryError] = useState('');
  const [discoveryReady, setDiscoveryReady] = useState(false);
  const [capsLock, setCapsLock] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [statusRes, providersRes] = await Promise.all([
          fetch('/api/auth/status', { credentials: 'include' }),
          fetch('/api/auth/sso/providers', { credentials: 'include' }),
        ]);
        if (cancelled) return;

        if (!statusRes.ok) {
          setDiscoveryError('Could not load authentication status. Refresh the page and try again.');
          setDiscoveryReady(true);
          return;
        }
        const status = await statusRes.json() as { localLoginEnabled?: boolean };
        const enabled = status.localLoginEnabled !== false;
        setLocalLoginEnabled(enabled);

        if (!providersRes.ok) {
          if (!enabled) {
            setDiscoveryError('Could not load identity providers. Refresh the page and try again.');
          }
          setSsoProviders([]);
          setDiscoveryReady(true);
          return;
        }
        const providers = await providersRes.json() as SSOProvider[];
        const list = Array.isArray(providers) ? providers : [];
        setSsoProviders(list);
        if (!enabled && list.some((p) => p.type === 'ldap')) {
          setLoginMode('ldap');
        }
        if (!enabled && list.length === 0) {
          setDiscoveryError('No identity providers are available. Contact your administrator.');
        }
        setDiscoveryReady(true);
      } catch (e) {
        console.warn('[Login] Auth discovery failed:', e);
        if (!cancelled) {
          setDiscoveryError('Could not load authentication options. Refresh the page and try again.');
          setDiscoveryReady(true);
        }
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const hasLdap = ssoProviders.some((p) => p.type === 'ldap');
  const oidcProviders = ssoProviders.filter((p) => p.type === 'oidc');
  const showPasswordForm = localLoginEnabled || (hasLdap && loginMode === 'ldap');
  const showLocalLdapToggle = localLoginEnabled && hasLdap;
  // Fail closed: under SSO-only, never show the local form after a discovery error.
  const blockLocalFallback = !localLoginEnabled && !!discoveryError;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!localLoginEnabled && loginMode !== 'ldap') return;
    setError('');
    setIsLoading(true);
    const result =
      loginMode === 'ldap' && ssoLdapLogin
        ? await ssoLdapLogin(username, password)
        : await login(username, password);
    if (!result.success) setError(result.error || 'Login failed');
    setIsLoading(false);
  };

  const handlePasswordKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (typeof e.getModifierState === 'function') {
      setCapsLock(e.getModifierState('CapsLock'));
    }
  };

  const footerLabel = !localLoginEnabled
    ? 'Console · SSO'
    : loginMode === 'ldap'
      ? 'Console · LDAP'
      : 'Console · Local';

  return (
    <div className={cn('relative', className)} {...props}>
      <AuthCanvas
        footer={
          <div className="flex items-center justify-between">
            <span>{footerLabel}</span>
            <span className="text-stat-subtitle/70">Secure by default</span>
          </div>
        }
      >
        <div className="flex flex-col gap-7">
          <div className="flex items-start justify-between gap-4">
            <AuthStepHeader
              kicker="AUTHENTICATE"
              hero="Sign in"
              caption={
                !localLoginEnabled
                  ? 'Sign in with your identity provider.'
                  : loginMode === 'ldap'
                    ? 'Federated via your directory service.'
                    : 'Self-hosted fleet console.'
              }
            />
            {showLocalLdapToggle && (
              <div className="mt-1 flex overflow-hidden rounded-md border border-card-border">
                <ModePill
                  active={loginMode === 'local'}
                  label="Local"
                  onClick={() => setLoginMode('local')}
                />
                <ModePill
                  active={loginMode === 'ldap'}
                  label="LDAP"
                  onClick={() => setLoginMode('ldap')}
                />
              </div>
            )}
          </div>

          {discoveryReady && blockLocalFallback && (
            <ErrorRail>{discoveryError}</ErrorRail>
          )}

          {discoveryReady && !blockLocalFallback && showPasswordForm && (
            <form onSubmit={handleSubmit} className="flex flex-col gap-5">
              <div className="flex flex-col gap-1.5">
                <label
                  htmlFor="username"
                  className="font-mono text-[10px] uppercase tracking-[0.18em] text-stat-subtitle"
                >
                  Username
                </label>
                <Input
                  id="username"
                  type="text"
                  placeholder="admin"
                  required
                  autoComplete="username"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  className={INPUT_CLASS}
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <div className="flex items-center justify-between">
                  <label
                    htmlFor="password"
                    className="font-mono text-[10px] uppercase tracking-[0.18em] text-stat-subtitle"
                  >
                    Password
                  </label>
                  {capsLock && (
                    <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-warning">
                      Caps Lock On
                    </span>
                  )}
                </div>
                <Input
                  id="password"
                  type="password"
                  required
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  onKeyDown={handlePasswordKey}
                  onKeyUp={handlePasswordKey}
                  className={INPUT_CLASS}
                />
              </div>

              {error && <ErrorRail>{error}</ErrorRail>}

              <Button
                type="submit"
                disabled={isLoading}
                className="h-11 w-full bg-brand text-brand-foreground shadow-btn-glow hover:bg-brand/90"
              >
                {isLoading ? (
                  <>
                    <Loader2 className="animate-spin" strokeWidth={1.5} />
                    Signing in
                  </>
                ) : (
                  <>
                    {loginMode === 'ldap' ? 'Sign in with LDAP' : 'Sign in'}
                    <ArrowRight strokeWidth={1.5} />
                  </>
                )}
              </Button>
            </form>
          )}

          {discoveryReady && !blockLocalFallback && oidcProviders.length > 0 && (
            <div className="flex flex-col gap-3">
              {showPasswordForm && (
                <div className="flex items-center gap-3">
                  <div className="h-px flex-1 bg-card-border" />
                  <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-stat-subtitle">
                    Or continue with
                  </span>
                  <div className="h-px flex-1 bg-card-border" />
                </div>
              )}
              <div className="grid grid-cols-2 gap-2">
                {oidcProviders.map((p) => (
                  <Button
                    key={p.provider}
                    type="button"
                    variant="outline"
                    className="h-10 justify-center gap-2 font-sans"
                    onClick={() => {
                      window.location.href = `/api/auth/sso/oidc/${p.provider}/authorize`;
                    }}
                  >
                    {getProviderIcon(p.provider)}
                    <span className="truncate">{p.displayName}</span>
                  </Button>
                ))}
              </div>
            </div>
          )}

          {discoveryReady && !blockLocalFallback && !showPasswordForm && oidcProviders.length === 0 && !discoveryError && (
            <ErrorRail>No identity providers are available. Contact your administrator.</ErrorRail>
          )}
        </div>
      </AuthCanvas>
    </div>
  );
}

function ModePill({ active, label, onClick }: { active: boolean; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'px-3 py-1 font-mono text-[10px] uppercase tracking-[0.18em] transition-colors',
        active ? 'bg-brand/15 text-brand' : 'text-stat-subtitle hover:text-stat-value',
      )}
    >
      {label}
    </button>
  );
}
