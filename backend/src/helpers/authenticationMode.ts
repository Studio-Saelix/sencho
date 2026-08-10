import { DatabaseService } from '../services/DatabaseService';

export const AUTHENTICATION_MODES = ['local_and_sso', 'sso_only'] as const;
export type AuthenticationMode = (typeof AUTHENTICATION_MODES)[number];

export const AUTHENTICATION_MODE_KEY = 'authentication_mode';
export const DEFAULT_AUTHENTICATION_MODE: AuthenticationMode = 'local_and_sso';

/**
 * Read authentication_mode with a fresh SQLite lookup. Must not use the
 * getGlobalSettings() process cache: enableLocalLogin / disableSso write this
 * key from a sidecar CLI process, and a stale sso_only cache would keep
 * rejecting local password login after recovery until Sencho restarts.
 * Missing or unknown values default to local_and_sso.
 */
export function getAuthenticationMode(db: DatabaseService = DatabaseService.getInstance()): AuthenticationMode {
  const raw = db.getGlobalSettingFresh(AUTHENTICATION_MODE_KEY);
  if (raw === 'sso_only') return 'sso_only';
  return DEFAULT_AUTHENTICATION_MODE;
}

export function isLocalLoginEnabled(db: DatabaseService = DatabaseService.getInstance()): boolean {
  return getAuthenticationMode(db) !== 'sso_only';
}

export function setAuthenticationMode(
  mode: AuthenticationMode,
  db: DatabaseService = DatabaseService.getInstance(),
): void {
  db.updateGlobalSetting(AUTHENTICATION_MODE_KEY, mode);
}

export function isAuthenticationMode(value: unknown): value is AuthenticationMode {
  return value === 'local_and_sso' || value === 'sso_only';
}

/** True when disabling/deleting this enabled provider would leave zero providers under sso_only. */
export function wouldRemoveLastProvider(provider: string, currentlyEnabled: boolean): boolean {
  if (!currentlyEnabled) return false;
  if (isLocalLoginEnabled()) return false;
  const enabled = DatabaseService.getInstance().getEnabledSSOConfigs();
  return enabled.length === 1 && enabled[0].provider === provider;
}
