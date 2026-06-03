import { useState, useEffect, useCallback } from 'react';
import type { ReactNode } from 'react';
import { RefreshCw, Check, AlertTriangle, X } from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { toast } from '@/components/ui/toast-store';
import { cn } from '@/lib/utils';
import { Skeleton } from '@/components/ui/skeleton';
import { SettingsActions, SettingsSecondaryButton } from './SettingsActions';

// Shape mirrors the backend EnvironmentReport (services/EnvironmentCheckService.ts);
// kept local because the frontend cannot import backend types. The panel only
// reads checks, so `remediation` stays optional here even though the backend
// models it as required on every warn / fail row.
type CheckStatus = 'pass' | 'warn' | 'fail';
type CheckId = 'docker_socket' | 'docker_compose' | 'compose_dir' | 'path_mapping' | 'tls' | 'disk_space';

interface EnvironmentCheck {
    id: CheckId;
    label: string;
    status: CheckStatus;
    detail: string;
    remediation?: string;
}

interface EnvironmentReport {
    checks: EnvironmentCheck[];
    generatedAt: number;
}

const STATUS_WORD: Record<CheckStatus, string> = { pass: 'OK', warn: 'Warning', fail: 'Action needed' };

function StatusBadge({ status, children }: { status: CheckStatus; children: ReactNode }) {
    const Icon = status === 'pass' ? Check : status === 'warn' ? AlertTriangle : X;
    return (
        <span
            className={cn(
                'inline-flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.18em]',
                status === 'pass' ? 'text-success' : status === 'warn' ? 'text-warning' : 'text-destructive',
            )}
        >
            <Icon className="h-3.5 w-3.5 shrink-0" />
            {children}
        </span>
    );
}

function CheckRow({ check }: { check: EnvironmentCheck }) {
    return (
        <div
            className={cn(
                'rounded-md border px-3 py-2.5',
                check.status === 'pass'
                    ? 'border-card-border bg-card'
                    : check.status === 'warn'
                        ? 'border-warning/40 bg-warning/5'
                        : 'border-destructive/40 bg-destructive/5',
            )}
        >
            <div className="flex items-center justify-between gap-3">
                <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-stat-subtitle">{check.label}</span>
                <StatusBadge status={check.status}>{STATUS_WORD[check.status]}</StatusBadge>
            </div>
            <p className="mt-1 text-xs text-stat-value">{check.detail}</p>
            {check.remediation ? (
                <p className="mt-1.5 text-xs leading-relaxed text-stat-subtitle">{check.remediation}</p>
            ) : null}
        </div>
    );
}

function ChecksSkeleton() {
    return (
        <div className="flex flex-col gap-2" aria-busy="true">
            {[0, 1, 2, 3, 4, 5].map(i => <Skeleton key={i} className="h-14 w-full" />)}
        </div>
    );
}

/**
 * Preflight environment checks (Docker engine + Compose, the compose directory
 * and its host path mapping, TLS, disk headroom) with inline remediation.
 * Layout-neutral so it renders both inside the Recovery settings tab and as the
 * final step of the setup wizard. Self-contained: fetches on mount and exposes
 * a Re-run control. It never blocks; the caller decides what continue action,
 * if any, sits alongside it.
 */
export function EnvironmentChecks({ className }: { className?: string }) {
    const [report, setReport] = useState<EnvironmentReport | null>(null);
    const [isLoading, setIsLoading] = useState(true);

    const load = useCallback(async () => {
        setIsLoading(true);
        try {
            const res = await apiFetch('/diagnostics/environment', { localOnly: true });
            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                toast.error(err?.error || 'Failed to run environment checks.');
                setReport(null);
                return;
            }
            setReport(await res.json() as EnvironmentReport);
        } catch (e: unknown) {
            toast.error((e as Error)?.message || 'Failed to run environment checks.');
            setReport(null);
        } finally {
            setIsLoading(false);
        }
    }, []);

    useEffect(() => {
        // eslint-disable-next-line react-hooks/set-state-in-effect
        void load();
    }, [load]);

    return (
        <div className={cn('flex flex-col gap-3', className)}>
            {isLoading ? (
                <ChecksSkeleton />
            ) : report ? (
                <div className="flex flex-col gap-2">
                    {report.checks.map(check => <CheckRow key={check.id} check={check} />)}
                </div>
            ) : (
                <p className="text-xs text-stat-subtitle">Checks could not be run. Try again.</p>
            )}
            <SettingsActions hint="environment preflight">
                <SettingsSecondaryButton onClick={() => void load()} disabled={isLoading}>
                    <RefreshCw className={cn('h-4 w-4', isLoading && 'animate-spin')} />
                    Re-run
                </SettingsSecondaryButton>
            </SettingsActions>
        </div>
    );
}
