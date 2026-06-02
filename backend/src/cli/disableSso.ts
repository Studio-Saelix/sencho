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
 */
import { DatabaseService } from '../services/DatabaseService';
import { auditCli, exitWith, type CliResult } from './_shared';

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
        db.upsertSSOConfig(provider, false, config.config_json);
        auditCli(db, `/cli/disable-sso/${provider}`, `CLI disabled SSO provider ${provider}`);
        return { ok: true, message: `Disabled SSO provider ${provider}. Its configuration was preserved.` };
    }

    const enabled = db.getEnabledSSOConfigs();
    if (enabled.length === 0) {
        return { ok: true, message: 'No SSO providers are currently enabled.' };
    }
    for (const config of enabled) {
        db.upsertSSOConfig(config.provider, false, config.config_json);
    }
    const names = enabled.map(c => c.provider).join(', ');
    auditCli(db, '/cli/disable-sso', `CLI disabled all SSO providers (${enabled.length})`);
    return { ok: true, message: `Disabled ${enabled.length} SSO provider(s): ${names}. Configurations were preserved.` };
}

function main(): void {
    exitWith(disableSso(process.argv[2]));
}

if (require.main === module) {
    main();
}
