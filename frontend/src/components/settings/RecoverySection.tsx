import { useState, useEffect, useCallback } from 'react';
import type { ReactNode } from 'react';
import { RefreshCw, Download, Check, X, AlertTriangle, RotateCcw, ExternalLink } from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { toast } from '@/components/ui/toast-store';
import { cn } from '@/lib/utils';
import { Skeleton } from '@/components/ui/skeleton';
import { SettingsSection } from './SettingsSection';
import { SettingsField } from './SettingsField';
import { SettingsActions, SettingsPrimaryButton, SettingsSecondaryButton } from './SettingsActions';
import { EnvironmentChecks } from './EnvironmentChecks';
import { DEPLOY_FEEDBACK_KEY } from '@/hooks/use-deploy-feedback-enabled';
import { COMPOSE_DIFF_PREVIEW_KEY } from '@/hooks/use-compose-diff-preview-enabled';

// Mirrors the backend DiagnosticsReport (services/DiagnosticsService.ts). Kept
// local because the frontend cannot import backend types.
interface DiagnosticsReport {
    version: string | null;
    database: { ok: boolean; integrity: string; path: string; missingTables: string[] };
    encryptionKey: { present: boolean; valid: boolean };
    docker: { reachable: boolean; error?: string };
    auth: {
        adminCount: number;
        userCount: number;
        mfaEnrolledCount: number;
        ssoProviders: Array<{ provider: string; enabled: boolean }>;
    };
    config: Record<string, string>;
}

type Health = 'ok' | 'warn' | 'error';

// Browser-local display preferences cleared by "Reset interface preferences".
// The density key is internal to use-density; the other two are exported.
const DENSITY_KEY = 'sencho.appearance.density';
const INTERFACE_PREF_KEYS = [DENSITY_KEY, DEPLOY_FEEDBACK_KEY, COMPOSE_DIFF_PREVIEW_KEY];

const CLI_COMMANDS: Array<{ cmd: string; purpose: string }> = [
    { cmd: 'node dist/cli/resetMfa.js <username>', purpose: "Clear a user's two-factor enrolment" },
    { cmd: 'node dist/cli/resetPassword.js <username> <new-password>', purpose: "Reset a local user's password" },
    { cmd: 'node dist/cli/createEmergencyAdmin.js <username> <password>', purpose: 'Create a new admin account' },
    { cmd: 'node dist/cli/clearSessions.js', purpose: 'Sign every user out' },
    { cmd: 'node dist/cli/disableSso.js [provider]', purpose: 'Disable a broken SSO provider' },
    { cmd: 'node dist/cli/diagnostics.js', purpose: 'Print this report as JSON' },
    { cmd: 'node dist/cli/validateDb.js', purpose: 'Check database and encryption-key integrity' },
    { cmd: 'node dist/cli/backupData.js [dir]', purpose: 'Back up the data directory' },
];

// When Docker is unreachable, prefer the actual error the backend captured (a
// bad socket path or permission denial is not self-healing); fall back to the
// reassuring copy only when no specific cause was reported.
function dockerHelper(report: DiagnosticsReport | null): string | undefined {
    if (!report || report.docker.reachable) return undefined;
    return report.docker.error
        ? `Unreachable: ${report.docker.error}`
        : 'Sencho reconnects on its own once Docker is back.';
}

// Save text content to a file via a transient object URL. Used for both the
// diagnostics JSON export and the offline command reference.
function triggerDownload(filename: string, content: string, mime: string) {
    const url = URL.createObjectURL(new Blob([content], { type: mime }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
}

// Plain-text command reference an operator can save while the app is reachable,
// so the commands are on hand for exactly the situation where it is not.
function cliReferenceText(): string {
    const lines = [
        'Sencho emergency recovery commands',
        '',
        'Run each from a shell on the host running Sencho:',
        '  docker compose exec sencho <command>',
        '',
    ];
    for (const { cmd, purpose } of CLI_COMMANDS) {
        lines.push(`# ${purpose}`, `docker compose exec sencho ${cmd}`, '');
    }
    return lines.join('\n');
}

function StatusValue({ health, children }: { health: Health; children: ReactNode }) {
    const Icon = health === 'ok' ? Check : health === 'warn' ? AlertTriangle : X;
    return (
        <span
            className={cn(
                'inline-flex items-center gap-1.5 font-mono text-xs tabular-nums',
                health === 'ok' ? 'text-success' : health === 'warn' ? 'text-warning' : 'text-destructive',
            )}
        >
            <Icon className="h-3.5 w-3.5 shrink-0" />
            {children}
        </span>
    );
}

function RecoverySkeleton() {
    return (
        <div className="space-y-3 rounded-lg border border-glass-border bg-glass p-4" aria-busy="true">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
        </div>
    );
}

export function RecoverySection() {
    const [report, setReport] = useState<DiagnosticsReport | null>(null);
    const [isLoading, setIsLoading] = useState(true);

    const load = useCallback(async () => {
        setIsLoading(true);
        try {
            const res = await apiFetch('/diagnostics', { localOnly: true });
            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                toast.error(err?.error || 'Failed to load diagnostics.');
                setReport(null);
                return;
            }
            setReport(await res.json() as DiagnosticsReport);
        } catch (e: unknown) {
            toast.error((e as Error)?.message || 'Failed to load diagnostics.');
            setReport(null);
        } finally {
            setIsLoading(false);
        }
    }, []);

    useEffect(() => {
        // eslint-disable-next-line react-hooks/set-state-in-effect
        void load();
    }, [load]);

    const exportReport = () => {
        if (!report) return;
        try {
            const stamp = new Date().toISOString().replace(/[:.]/g, '-');
            triggerDownload(`sencho-diagnostics-${stamp}.json`, JSON.stringify(report, null, 2), 'application/json');
        } catch (e: unknown) {
            toast.error((e as Error)?.message || 'Could not export diagnostics.');
        }
    };

    const downloadCommands = () => {
        try {
            triggerDownload('sencho-recovery-commands.txt', cliReferenceText(), 'text/plain');
        } catch (e: unknown) {
            toast.error((e as Error)?.message || 'Could not download the command reference.');
        }
    };

    const resetInterface = () => {
        try {
            INTERFACE_PREF_KEYS.forEach(key => window.localStorage.removeItem(key));
            toast.success('Interface preferences reset to defaults. Reloading...');
            setTimeout(() => window.location.reload(), 600);
        } catch (e: unknown) {
            toast.error((e as Error)?.message || 'Could not reset interface preferences.');
        }
    };

    if (isLoading) return <RecoverySkeleton />;

    const dbHealth: Health = report?.database.ok ? 'ok' : 'error';
    const keyHealth: Health = report?.encryptionKey.present && report.encryptionKey.valid ? 'ok' : 'error';
    const dockerHealth: Health = report?.docker.reachable ? 'ok' : 'warn';
    const adminHealth: Health = (report?.auth.adminCount ?? 0) > 0 ? 'ok' : 'warn';

    return (
        <div className="flex flex-col gap-10">
            <SettingsSection
                title="System health"
                kicker="this node"
                description="A read-only snapshot of the control plane. It loads without Docker or live metrics, so it stays available when the dashboard does not."
            >
                <SettingsField label="Version">
                    <span className="font-mono text-xs text-stat-value">{report?.version ?? 'unknown'}</span>
                </SettingsField>
                <SettingsField label="Database" helper={report && !report.database.ok ? `Integrity: ${report.database.integrity}` : undefined} tone={dbHealth === 'error' ? 'error' : 'default'}>
                    <StatusValue health={dbHealth}>{report?.database.ok ? 'Healthy' : 'Problem detected'}</StatusValue>
                </SettingsField>
                <SettingsField label="Encryption key" tone={keyHealth === 'error' ? 'error' : 'default'}>
                    <StatusValue health={keyHealth}>
                        {!report?.encryptionKey.present ? 'Missing' : report.encryptionKey.valid ? 'Present' : 'Invalid'}
                    </StatusValue>
                </SettingsField>
                <SettingsField label="Docker" helper={dockerHelper(report)} tone={dockerHealth === 'warn' ? 'warn' : 'default'}>
                    <StatusValue health={dockerHealth}>{report?.docker.reachable ? 'Reachable' : 'Unreachable'}</StatusValue>
                </SettingsField>
                <SettingsField label="Administrators" tone={adminHealth === 'warn' ? 'warn' : 'default'}>
                    <StatusValue health={adminHealth}>{report?.auth.adminCount ?? 0} of {report?.auth.userCount ?? 0} users</StatusValue>
                </SettingsField>
                <SettingsField label="Two-factor enrolled">
                    <span className="font-mono text-xs text-stat-value tabular-nums">{report?.auth.mfaEnrolledCount ?? 0} user(s)</span>
                </SettingsField>
                <SettingsField label="SSO providers">
                    <span className="font-mono text-xs text-stat-value">
                        {report && report.auth.ssoProviders.length > 0
                            ? report.auth.ssoProviders.map(p => `${p.provider} (${p.enabled ? 'on' : 'off'})`).join(', ')
                            : 'None configured'}
                    </span>
                </SettingsField>

                <SettingsActions hint="read-only">
                    <SettingsSecondaryButton onClick={() => void load()}>
                        <RefreshCw className="h-4 w-4" />
                        Refresh
                    </SettingsSecondaryButton>
                    <SettingsPrimaryButton onClick={exportReport} disabled={!report}>
                        <Download className="h-4 w-4" />
                        Export diagnostics
                    </SettingsPrimaryButton>
                </SettingsActions>
            </SettingsSection>

            <SettingsSection
                title="Environment"
                kicker="preflight"
                description="What deploys depend on: the Docker engine, the Compose plugin, the compose directory and its host path mapping, TLS, and disk headroom. Each warning carries a fix."
            >
                <div className="pt-3">
                    <EnvironmentChecks />
                </div>
            </SettingsSection>

            <SettingsSection
                title="Safe actions"
                description="Low-risk recovery steps that touch no secrets and no other operators' accounts."
            >
                <SettingsField
                    label="Reset interface preferences"
                    helper="Restore density and editor display options on this browser to their defaults, then reload. Useful if a display setting wedges the layout."
                    align="start"
                >
                    <SettingsSecondaryButton onClick={resetInterface}>
                        <RotateCcw className="h-4 w-4" />
                        Reset
                    </SettingsSecondaryButton>
                </SettingsField>
                <SettingsField
                    label="Recovery guide"
                    helper="Step-by-step recovery for Sencho, deploys, sign-in, Docker, and remote nodes."
                    align="start"
                >
                    <a
                        href="https://docs.sencho.io/operations/recovery"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.18em] text-brand transition-colors hover:text-brand/80"
                    >
                        Open guide
                        <ExternalLink className="h-3.5 w-3.5" />
                    </a>
                </SettingsField>
            </SettingsSection>

            <SettingsSection
                title="Command-line recovery"
                description="When the UI is fully unreachable, run these from a shell on the host. Each prints what it changed and writes to the audit log where applicable."
            >
                <div className="flex flex-col gap-2 pt-3">
                    <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-stat-subtitle/70">
                        prefix each with: docker compose exec sencho
                    </p>
                    {CLI_COMMANDS.map(({ cmd, purpose }) => (
                        <div key={cmd} className="flex flex-col gap-0.5 rounded-md border border-card-border bg-card px-3 py-2">
                            <code className="font-mono text-xs text-stat-value break-all">{cmd}</code>
                            <span className="text-xs text-stat-subtitle">{purpose}</span>
                        </div>
                    ))}
                </div>
                <SettingsActions hint="save these before you need them">
                    <SettingsPrimaryButton onClick={downloadCommands}>
                        <Download className="h-4 w-4" />
                        Download commands
                    </SettingsPrimaryButton>
                </SettingsActions>
            </SettingsSection>
        </div>
    );
}
