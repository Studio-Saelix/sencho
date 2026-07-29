import { createContext, useContext, useState, useEffect, useCallback, useRef, type ReactNode } from 'react';
import { markMilestone } from '@/lib/hydrationTiming';
import { resolveCan } from '@/lib/resolveCan';

type AppStatus = 'loading' | 'needsSetup' | 'notAuthenticated' | 'mfaChallenge' | 'authenticated';

export type UserRole = 'admin' | 'viewer' | 'deployer' | 'node-admin' | 'auditor';

export type PermissionsStatus = 'loading' | 'ready' | 'error';

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
  permissionsStatus: PermissionsStatus;
  permissionsReady: boolean;
  can: (action: PermissionAction, resourceType?: string, resourceId?: string, nodeId?: number | null) => boolean;
  retryPermissions: () => Promise<void>;
  login: (username: string, password: string, remember?: boolean) => Promise<{ success: boolean; error?: string; mfaRequired?: boolean }>;
  ssoLdapLogin: (username: string, password: string, remember?: boolean) => Promise<{ success: boolean; error?: string; mfaRequired?: boolean }>;
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
  const [permissionsStatus, setPermissionsStatus] = useState<PermissionsStatus>('loading');
  const permissionRequestRef = useRef(0);

  const resetPermissions = useCallback(() => {
    permissionRequestRef.current += 1;
    setPermissions(null);
    setPermissionsStatus('loading');
  }, []);

  const loadPermissions = useCallback(async () => {
    const requestId = ++permissionRequestRef.current;
    setPermissions(null);
    setPermissionsStatus('loading');

    try {
      const response = await fetch('/api/permissions/me', { credentials: 'include' });
      if (!response.ok) {
        console.error('[Auth] Permission metadata request failed:', response.status);
        if (requestId === permissionRequestRef.current) setPermissionsStatus('error');
        return;
      }
      const data = await response.json();
      if (requestId !== permissionRequestRef.current) return;
      setPermissions(data);
      setPermissionsStatus('ready');
    } catch (error) {
      console.error('[Auth] Permission metadata request failed:', error);
      if (requestId === permissionRequestRef.current) setPermissionsStatus('error');
    }
  }, []);

  const checkAuth = async () => {
    resetPermissions();
    try {
      const statusResponse = await fetch('/api/auth/status', {
        credentials: 'include',
      });
      const statusData = await statusResponse.json();

      if (statusData.needsSetup) {
        setAppStatus('needsSetup');
        setUser(null);
        resetPermissions();
        return;
      }

      if (statusData.mfaPending) {
        setUser(null);
        resetPermissions();
        setAppStatus('mfaChallenge');
        return;
      }

      const authResponse = await fetch('/api/auth/check', { credentials: 'include' });
      if (authResponse.ok) {
        const data = await authResponse.json();
        setUser(data.user ?? null);
        setAppStatus('authenticated');
        await loadPermissions();
      } else {
        setUser(null);
        resetPermissions();
        setAppStatus('notAuthenticated');
      }
    } catch {
      setUser(null);
      resetPermissions();
      setAppStatus('notAuthenticated');
    }
  };

  // One-shot boot milestone: the auth gate has resolved to a terminal status
  // (setup, login, MFA, or authenticated), so the app can leave the splash.
  useEffect(() => {
    if (appStatus === 'loading') return;
    markMilestone('auth_resolved');
  }, [appStatus]);

  useEffect(() => {
    checkAuth();
    const handleUnauthorized = () => {
      setUser(null);
      resetPermissions();
      setAppStatus('notAuthenticated');
    };
    window.addEventListener('sencho-unauthorized', handleUnauthorized);
    return () => window.removeEventListener('sencho-unauthorized', handleUnauthorized);
  }, []);

  const can = useCallback((
    action: PermissionAction,
    resourceType?: string,
    resourceId?: string,
    nodeId?: number | null,
  ): boolean => {
    if (permissionsStatus !== 'ready' || !permissions) return false;
    return resolveCan(permissions, action, resourceType, resourceId, nodeId);
  }, [permissions, permissionsStatus]);

  const login = async (username: string, password: string, remember = false): Promise<{ success: boolean; error?: string; mfaRequired?: boolean }> => {
    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        credentials: 'include',
        body: JSON.stringify({ username, password, remember }),
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
        return { success: false, error: data.error || 'Login failed' };
      }
    } catch {
      return { success: false, error: 'Network error. Please try again.' };
    }
  };

  const ssoLdapLogin = async (username: string, password: string, remember = false): Promise<{ success: boolean; error?: string; mfaRequired?: boolean }> => {
    try {
      const response = await fetch('/api/auth/sso/ldap', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ username, password, remember }),
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
      resetPermissions();
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
      resetPermissions();
      setAppStatus('notAuthenticated');
    }
  };

  const completeSetup = () => {
    checkAuth();
  };

  return (
    <AuthContext.Provider value={{
      appStatus,
      isAuthenticated: appStatus === 'authenticated',
      needsSetup: appStatus === 'needsSetup',
      user,
      isAdmin: permissionsStatus === 'ready' && permissions?.globalRole === 'admin',
      permissions,
      permissionsStatus,
      permissionsReady: permissionsStatus === 'ready',
      can,
      retryPermissions: loadPermissions,
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
