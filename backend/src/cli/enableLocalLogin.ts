/**
 * Emergency CLI: re-enable local password authentication after SSO-only mode
 * locks out interactive password login (for example when the identity provider
 * is unavailable).
 *
 * Run via:
 *   docker compose exec sencho node dist/cli/enableLocalLogin.js
 *
 * Requires local shell or Docker-host access. Does not contact the identity
 * provider. Written to the audit log with actor `cli`. Takes effect on the
 * next login/status request without restarting Sencho (authentication_mode is
 * read uncached by the running process).
 */
import { DatabaseService } from '../services/DatabaseService';
import {
  getAuthenticationMode,
  setAuthenticationMode,
} from '../helpers/authenticationMode';
import { auditCli, exitWith, type CliResult } from './_shared';

export function enableLocalLogin(): CliResult {
  const db = DatabaseService.getInstance();
  const current = getAuthenticationMode(db);
  if (current === 'local_and_sso') {
    return {
      ok: true,
      message:
        'Local password authentication is already enabled (authentication_mode=local_and_sso).',
    };
  }

  try {
    setAuthenticationMode('local_and_sso', db);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, message: `Failed to re-enable local login: ${detail}` };
  }

  auditCli(db, '/cli/enable-local-login', 'CLI re-enabled local password authentication');
  return {
    ok: true,
    message:
      'Local login re-enabled. Sign in with a local administrator password; no restart is required.',
  };
}

function main(): void {
  exitWith(enableLocalLogin());
}

if (require.main === module) {
  main();
}
