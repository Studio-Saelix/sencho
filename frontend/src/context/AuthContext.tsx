import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from 'react';

type AppStatus = 'loading' | 'needsSetup' | 'notAuthenticated' | 'mfaChallenge' | 'authenticated';

export type UserRole = 'admin' | 'viewer' | 'deployer' | 'node-admin' | 'auditor';

export type PermissionAction =
  | 'stack:read' | 'stack:edit' | 'stack:deploy' | 'stack:create' | 'stack:delete'
  | 'node:read' | 'node:manage'
  | 'system:settings' | 'system:users' | 'system:license' | 'system:webhooks'
  | 'system:tokens' | 'system:console' | 'system:audit' | 'system:registries';

interface UserInfo {
  username: string;
  role: UserRole;
}

interface PermissionsData {
  globalRole: UserRole;
  globalPermissions: PermissionAction[];
  scopedPermissions: Record<string, PermissionAction[]>;
}

interface AuthContextType {
  appStatus: AppStatus;
  isAuthenticated: boolean;
  needsSetup: boolean;
  user: UserInfo | null;
  isAdmin: boolean;
  permissions: PermissionsData | null;
  can: (action: PermissionAction, resourceType?: string, resourceId?: string) => boolean;
  login: (username: string, password: string) => Promise<{ success: boolean; error?: string; mfaRequired?: boolean }>;
  ssoLdapLogin: (username: string, password: string) => Promise<{ success: boolean; error?: string; mfaRequired?: boolean }>;
  submitMfa: (code: string, opts?: { isBackupCode?: boolean }) => Promise<{ success: boolean; error?: string; retryAfter?: number }>;
  cancelMfa: () => Promise<void>;
  logout: () => Promise<void>;
  completeSetup: () => void;
  checkAuth: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [appStatus, setAppStatus] = useState<AppStatus>('loading');
  const [user, setUser] = useState<UserInfo | null>(null);
  const [permissions, setPermissions] = useState<PermissionsData | null>(null);

  const checkAuth = async () => {
    try {
      // First check if setup is needed
      const statusResponse = await fetch('/api/auth/status', {
        credentials: 'include',
      });
      const statusData = await statusResponse.json();

      if (statusData.needsSetup) {
        setAppStatus('needsSetup');
        setUser(null);
        setPermissions(null);
        return;
      }

      // If a partial-auth (mfa_pending) cookie is active, route to the
      // challenge screen. This handles reloads in the middle of the flow,
      // including post-OIDC redirects.
      if (statusData.mfaPending) {
        setUser(null);
        setPermissions(null);
        setAppStatus('mfaChallenge');
        return;
      }

      // Auth check and permissions fetch are independent for an authenticated
      // session, so fire both on the wire at the same time. Await only the
      // auth check before committing app state — otherwise a slow
      // /permissions/me delays setAppStatus('authenticated') and races
      // post-reload UI that expects the dashboard to commit promptly. The
      // permissions promise updates state in the background when it resolves.
      const authPromise = fetch('/api/auth/check', { credentials: 'include' });
      const permsPromise = fetch('/api/permissions/me', { credentials: 'include' }).catch(() => null);

      const authResponse = await authPromise;
      if (authResponse.ok) {
        const data = await authResponse.json();
        setUser(data.user ?? null);
        setAppStatus('authenticated');

        void permsPromise.then(async (res) => {
          if (res?.ok) {
            try {
              setPermissions(await res.json());
            } catch {
              // Permissions fetch is non-critical — fallback to global role only
            }
          }
        });
      } else {
        setUser(null);
        setPermissions(null);
        setAppStatus('notAuthenticated');
      }
    } catch {
      setUser(null);
      setPermissions(null);
      setAppStatus('notAuthenticated');
    }
  };

  useEffect(() => {
    checkAuth();
    const handleUnauthorized = () => setAppStatus('notAuthenticated');
    window.addEventListener('sencho-unauthorized', handleUnauthorized);
    return () => window.removeEventListener('sencho-unauthorized', handleUnauthorized);
  }, []);

  const can = useCallback((action: PermissionAction, resourceType?: string, resourceId?: string): boolean => {
    if (!permissions) return false;

    // Admins always have full access
    if (permissions.globalRole === 'admin') return true;

    // Check global role permissions
    if (permissions.globalPermissions.includes(action)) return true;

    // Check scoped permissions
    if (resourceType && resourceId) {
      const key = `${resourceType}:${resourceId}`;
      return permissions.scopedPermissions[key]?.includes(action) ?? false;
    }

    return false;
  }, [permissions]);

  const login = async (username: string, password: string): Promise<{ success: boolean; error?: string; mfaRequired?: boolean }> => {
    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        credentials: 'include',
        body: JSON.stringify({ username, password }),
      });

      const data = await response.json();

      if (response.ok && data.success) {
        if (data.mfaRequired) {
          // Password was accepted but a second factor is required. Pull the
          // updated /auth/status so the app routes to the challenge screen.
          await checkAuth();
          return { success: true, mfaRequired: true };
        }
        setAppStatus('authenticated');
        // Fetch user info (role, username) so isAdmin is correct immediately
        await checkAuth();
        return { success: true };
      } else {
        return { success: false, error: data.error || 'Login failed' };
      }
    } catch {
      return { success: false, error: 'Network error. Please try again.' };
    }
  };

  const ssoLdapLogin = async (username: string, password: string): Promise<{ success: boolean; error?: string; mfaRequired?: boolean }> => {
    try {
      const response = await fetch('/api/auth/sso/ldap', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ username, password }),
      });

      const data = await response.json();

      if (response.ok && data.success) {
        if (data.mfaRequired) {
          await checkAuth();
          return { success: true, mfaRequired: true };
        }
        setAppStatus('authenticated');
        await checkAuth();
        return { success: true };
      } else {
        return { success: false, error: data.error || 'LDAP login failed' };
      }
    } catch {
      return { success: false, error: 'Network error. Please try again.' };
    }
  };

  const submitMfa = async (
    code: string,
    opts: { isBackupCode?: boolean } = {},
  ): Promise<{ success: boolean; error?: string; retryAfter?: number }> => {
    try {
      const response = await fetch('/api/auth/login/mfa', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ code, isBackupCode: opts.isBackupCode === true }),
      });
      const data = await response.json().catch(() => ({}));
      if (response.ok && data.success) {
        await checkAuth();
        return { success: true };
      }
      const retryAfter = typeof data.retryAfter === 'number' ? data.retryAfter : undefined;
      return { success: false, error: data.error || 'Verification failed', retryAfter };
    } catch {
      return { success: false, error: 'Network error. Please try again.' };
    }
  };

  const cancelMfa = async () => {
    try {
      await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
    } catch (error) {
      console.error('Cancel MFA error:', error);
    } finally {
      setUser(null);
      setPermissions(null);
      setAppStatus('notAuthenticated');
    }
  };

  const logout = async () => {
    try {
      await fetch('/api/auth/logout', {
        method: 'POST',
        credentials: 'include',
      });
    } catch (error) {
      console.error('Logout error:', error);
    } finally {
      setUser(null);
      setPermissions(null);
      setAppStatus('notAuthenticated');
    }
  };

  const completeSetup = () => {
    // Fetch user info so isAdmin is correct after setup
    checkAuth();
  };

  return (
    <AuthContext.Provider value={{
      appStatus,
      isAuthenticated: appStatus === 'authenticated',
      needsSetup: appStatus === 'needsSetup',
      user,
      isAdmin: user?.role === 'admin',
      permissions,
      can,
      login,
      ssoLdapLogin,
      submitMfa,
      cancelMfa,
      logout,
      completeSetup,
      checkAuth
    }}>
      {children}
    </AuthContext.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
