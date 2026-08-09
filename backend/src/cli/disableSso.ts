/**
 * Emergency CLI: disable a broken SSO/OIDC/LDAP provider so local password
 * sign-in is reachable again. Used when a misconfigured identity provider
 * blocks the login screen.
 *
 * Run via:
 *   docker compose exec sencho node dist/cli/disableSso.js [provider]
 *
 * With no argument it disables every enabled provider. The stored configuration
 * is preserved (only the enabled flag is cleared) so it can be fixed and
 * re-enabled from the UI. Written to the audit log with actor `cli`.
 *
 * When authentication_mode is sso_only and every provider is disabled (no
 * argument), this command restores local_and_sso first so the operator is
 * never left with SSO-only and zero providers. A named-provider disable that
 * would remove the last enabled provider under sso_only is rejected; use the
 * no-argument form or enableLocalLogin instead. Disabling one of several
 * providers leaves authentication_mode unchanged.
 */
import { DatabaseService } from '../services/DatabaseService';
import {
  getAuthenticationMode,
  setAuthenticationMode,
} from '../helpers/authenticationMode';
import { auditCli, exitWith, type CliResult } from './_shared';

function restoreLocalLoginIfNeeded(db: DatabaseService): CliResult | null {
  const mode = getAuthenticationMode(db);
  if (mode !== 'sso_only') return null;
  try {
    setAuthenticationMode('local_and_sso', db);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      message: `Failed to re-enable local login before disabling SSO: ${detail}. Providers were left unchanged.`,
    };
  }
  auditCli(db, '/cli/enable-local-login', 'CLI re-enabled local password authentication before disabling SSO');
  return null;
}

export function disableSso(provider?: string): CliResult {
  const db = DatabaseService.getInstance();

  if (provider) {
    const config = db.getSSOConfig(provider);
    if (!config) {
      return { ok: false, message: `No SSO config found for provider: ${provider}` };
    }
    if (config.enabled !== 1) {
      return { ok: true, message: `SSO provider ${provider} is already disabled.` };
    }

    const mode = getAuthenticationMode(db);
    if (mode === 'sso_only') {
      const enabled = db.getEnabledSSOConfigs();
      if (enabled.length === 1 && enabled[0].provider === provider) {
        return {
          ok: false,
          message:
            `Cannot disable the last SSO provider while SSO-only mode is active. ` +
            `Run without a provider argument, or run enableLocalLogin first.`,
        };
      }
    }

    // Named disable leaves authentication_mode unchanged (including sso_only).
    db.upsertSSOConfig(provider, false, config.config_json);
    auditCli(db, `/cli/disable-sso/${provider}`, `CLI disabled SSO provider ${provider}`);
    const modeNote =
      mode === 'sso_only'
        ? ' Authentication mode remains SSO only; remaining providers stay available.'
        : '';
    return {
      ok: true,
      message: `Disabled SSO provider ${provider}. Its configuration was preserved.${modeNote}`,
    };
  }

  const enabled = db.getEnabledSSOConfigs();
  const wasSsoOnly = getAuthenticationMode(db) === 'sso_only';
  if (enabled.length === 0) {
    const modeError = restoreLocalLoginIfNeeded(db);
    if (modeError) return modeError;
    const modeNote = wasSsoOnly
      ? ' Local password login is available again (no restart required).'
      : '';
    return { ok: true, message: `No SSO providers are currently enabled.${modeNote}` };
  }

  const modeError = restoreLocalLoginIfNeeded(db);
  if (modeError) return modeError;

  for (const config of enabled) {
    db.upsertSSOConfig(config.provider, false, config.config_json);
  }
  const names = enabled.map(c => c.provider).join(', ');
  auditCli(db, '/cli/disable-sso', `CLI disabled all SSO providers (${enabled.length})`);
  const modeNote = wasSsoOnly
    ? ' Local password login is available again (no restart required).'
    : '';
  return {
    ok: true,
    message: `Disabled ${enabled.length} SSO provider(s): ${names}. Configurations were preserved.${modeNote}`,
  };
}

function main(): void {
  exitWith(disableSso(process.argv[2]));
}

if (require.main === module) {
  main();
}
