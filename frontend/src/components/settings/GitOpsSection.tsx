import { useState, useEffect } from 'react';
import { Skeleton } from '@/components/ui/skeleton';
import { RefreshCw } from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { toast } from '@/components/ui/toast-store';
import { useAuth } from '@/context/AuthContext';
import { DEFAULT_SETTINGS } from './types';
import type { PatchableSettings } from './types';
import { SettingsSection } from './SettingsSection';
import { SettingsField } from './SettingsField';
import { SettingsActions, SettingsPrimaryButton } from './SettingsActions';
import { useMastheadStats } from './MastheadStatsContext';
import { useSettingsDirty } from './useSettingsDirty';
import { SettingsLoadGate } from './SettingsLoadError';
import type { NodeSettingsLoadPhase as LoadPhase } from './useNodeSettingsLoad';
import { NumberChip } from './SystemControls';
import { GitPollingControl } from './GitPollingControl';

interface GitOpsSectionProps {
    onDirtyChange?: (dirty: boolean) => void;
}

type GitOpsFields = Pick<PatchableSettings, 'gitops_artifact_retry_interval_mins' | 'gitops_history_retention_days'>;

const DEFAULT_FIELDS: GitOpsFields = {
    gitops_artifact_retry_interval_mins: DEFAULT_SETTINGS.gitops_artifact_retry_interval_mins,
    gitops_history_retention_days: DEFAULT_SETTINGS.gitops_history_retention_days,
};

function RetrySkeleton() {
    return (
        <div className="space-y-3 rounded-lg border border-glass-border bg-glass p-4">
            <Skeleton className="h-10 w-full" />
        </div>
    );
}

/**
 * How this instance behaves on its own schedule.
 *
 * The controls here answer different questions and none implies another. Git
 * polling is about fetching new intent on a cadence the operator opts into, and
 * it is off by default because an unattended fetch writes to a repository. The
 * artifact retry interval is about how fast Sencho proves what is already
 * running, and it is on by default because leaving it unset would hold a
 * target's approved image identity unresolved until something unrelated
 * happened to redeploy it. The history window is about how long the record of
 * all of it is kept, and it is on by default because the tables it prunes are
 * insert-only.
 *
 * They share a section because all three configure background work and an
 * operator adjusting one usually wants to see the others. They are saved
 * differently on purpose: the poll interval has to reschedule live fetchers, so
 * it owns an endpoint and is node-scoped, while the retry interval and the
 * history window are values read at the moment they are needed, so they ride
 * the shared settings and are read from this instance rather than from the
 * selected node.
 */
export function GitOpsSection({ onDirtyChange }: GitOpsSectionProps) {
    const { can } = useAuth();
    // The three controls gate differently, because their permissions differ,
    // and only the retry interval and history window are wrapped in a disabled
    // fieldset. The poll interval is node-scoped and the backend requires
    // node:manage against the active node, which `GitPollingControl` checks for
    // itself; the other two are instance-scoped and require system:settings,
    // since one value governs every node this instance manages.
    const canEditRetry = can('system:settings');
    const readOnly = !canEditRetry;
    const { settings, setSettings, dirtyCount, hasChanges, reset, markSaved } = useSettingsDirty<GitOpsFields>({ ...DEFAULT_FIELDS });
    const [phase, setPhase] = useState<LoadPhase>('loading');
    const [isSaving, setIsSaving] = useState(false);

    const reportDirty = phase === 'ready' && hasChanges;

    useEffect(() => {
        onDirtyChange?.(reportDirty);
    }, [reportDirty, onDirtyChange]);

    useMastheadStats(
        !reportDirty && phase !== 'ready'
            ? null
            : [
                {
                    label: 'EDITED',
                    value: hasChanges ? `${dirtyCount} pending` : 'saved',
                    tone: 'warn',
                },
            ],
    );

    // Hub-local, deliberately not the node-scoped loader the other sections use.
    // The reconciler that reads this value is the one on the instance you are
    // signed into, and it runs the checks for every node it manages, so a value
    // written to a remote node's own database would govern nothing. Reading it
    // through the node-scoped path would show the active node's copy instead of
    // the one in force.
    useEffect(() => {
        let cancelled = false;
        void (async () => {
            setPhase('loading');
            try {
                const res = await apiFetch('/settings', { localOnly: true });
                if (cancelled) return;
                if (!res.ok) {
                    setPhase('error');
                    return;
                }
                const body = (await res.json()) as Record<string, unknown>;
                if (cancelled) return;
                reset({
                    gitops_artifact_retry_interval_mins:
                        typeof body.gitops_artifact_retry_interval_mins === 'string'
                            ? body.gitops_artifact_retry_interval_mins
                            : DEFAULT_SETTINGS.gitops_artifact_retry_interval_mins,
                    gitops_history_retention_days:
                        typeof body.gitops_history_retention_days === 'string'
                            ? body.gitops_history_retention_days
                            : DEFAULT_SETTINGS.gitops_history_retention_days,
                });
                setPhase('ready');
            } catch {
                if (!cancelled) setPhase('error');
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [reset]);

    const save = async () => {
        const submitted = { ...settings };
        setIsSaving(true);
        try {
            const res = await apiFetch('/settings', {
                method: 'PATCH',
                localOnly: true,
                body: JSON.stringify(submitted),
            });
            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                toast.error(err?.error || err?.message || 'Failed to save settings.');
                return;
            }
            markSaved(submitted);
            toast.success('GitOps settings saved.');
        } catch (e: unknown) {
            toast.error((e as Error)?.message || 'Something went wrong.');
        } finally {
            setIsSaving(false);
        }
    };

    return (
        <SettingsLoadGate phase={phase} isCurrentNodeLoaded={phase === 'ready'} skeleton={<RetrySkeleton />}>
            <div className="flex min-w-0 flex-col gap-10">
                {/* Outside the fieldset on purpose: the poll interval is
                    node-scoped and its own gate is `node:manage`, so wrapping it
                    in the retry interval's `system:settings` gate would take a
                    permission an operator legitimately holds away from a control
                    that does not need it. */}
                <GitPollingControl />
                <fieldset disabled={readOnly} className="m-0 flex min-w-0 flex-col gap-10 border-0 p-0">
                    <SettingsSection title="Drift verification" kicker="this Sencho">
                        <p className="pb-2 text-sm leading-relaxed text-stat-subtitle">
                            How Sencho proves which images a Blueprint target is actually running.
                        </p>
                        <SettingsField
                            label="Retry an unresolved image identity"
                            helper="How often a drift check retries resolving the exact image identity a Blueprint target was approved at, when the first attempt could not reach the registry. Lower it for faster recovery once a registry comes back, raise it to keep Sencho off a rate-limited or private registry. This covers the Blueprint targets this Sencho manages, whichever node each one runs on. Default 5 minutes. It has no effect while every target's identity is already resolved."
                        >
                            <NumberChip
                                value={settings.gitops_artifact_retry_interval_mins || '5'}
                                onChange={(v) => setSettings(prev => ({ ...prev, gitops_artifact_retry_interval_mins: v }))}
                                suffix="min"
                                min={1}
                                max={1440}
                            />
                        </SettingsField>
                    </SettingsSection>

                    <SettingsSection title="History" kicker="this Sencho">
                        <p className="pb-2 text-sm leading-relaxed text-stat-subtitle">
                            How long the record behind the GitOps timeline is kept.
                        </p>
                        <SettingsField
                            label="Keep GitOps history for"
                            helper="Days of GitOps history and its notification fanout to keep before the cleanup pass prunes them. The newest rows are always kept, and pruning an old row never changes what the fleet is running. Lower it to keep a busy Sencho's database small, raise it to keep a longer record. Default 30 days."
                        >
                            <NumberChip
                                value={settings.gitops_history_retention_days || '30'}
                                onChange={(v) => setSettings(prev => ({ ...prev, gitops_history_retention_days: v }))}
                                suffix="days"
                                min={1}
                                max={365}
                            />
                        </SettingsField>
                    </SettingsSection>

                    <SettingsActions hint={readOnly ? 'Read-only · permission required to edit' : (hasChanges ? `${dirtyCount} unsaved` : undefined)}>
                        {!readOnly && (
                            <SettingsPrimaryButton onClick={save} disabled={isSaving || !hasChanges || phase !== 'ready'}>
                                {isSaving ? (
                                    <>
                                        <RefreshCw className="w-4 h-4 animate-spin" />
                                        Saving
                                    </>
                                ) : (
                                    'Save settings'
                                )}
                            </SettingsPrimaryButton>
                        )}
                    </SettingsActions>
                </fieldset>
            </div>
        </SettingsLoadGate>
    );
}
