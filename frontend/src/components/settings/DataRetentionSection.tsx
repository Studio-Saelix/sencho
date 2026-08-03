import { useState, useEffect } from 'react';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { RefreshCw } from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { toast } from '@/components/ui/toast-store';
import { useNodes } from '@/context/NodeContext';
import { useAuth } from '@/context/AuthContext';
import { useLicense } from '@/context/LicenseContext';
import { SENCHO_SETTINGS_CHANGED } from '@/lib/events';
import type { SenchoSettingsChangedDetail } from '@/lib/events';
import { DEFAULT_SETTINGS } from './types';
import type { PatchableSettings } from './types';
import { SettingsSection } from './SettingsSection';
import { SettingsField } from './SettingsField';
import { SettingsActions, SettingsPrimaryButton } from './SettingsActions';
import { useMastheadStats } from './MastheadStatsContext';
import { useSettingsDirty } from './useSettingsDirty';
import { useNodeSettingsLoad } from './useNodeSettingsLoad';
import { SettingsLoadGate } from './SettingsLoadError';
import { TogglePill } from '@/components/ui/toggle-pill';

interface DataRetentionSectionProps {
    onDirtyChange?: (dirty: boolean) => void;
}

function SectionSkeleton() {
    return (
        <div className="space-y-3 rounded-lg border border-glass-border bg-glass p-4">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
        </div>
    );
}

type DataRetentionFields = Pick<PatchableSettings, 'metrics_retention_hours' | 'log_retention_days' | 'audit_retention_days' | 'scan_history_per_image_limit' | 'prune_orphaned_scans'>;

const DEFAULT_DATA_RETENTION: DataRetentionFields = {
    metrics_retention_hours: DEFAULT_SETTINGS.metrics_retention_hours,
    log_retention_days: DEFAULT_SETTINGS.log_retention_days,
    audit_retention_days: DEFAULT_SETTINGS.audit_retention_days,
    scan_history_per_image_limit: DEFAULT_SETTINGS.scan_history_per_image_limit,
    prune_orphaned_scans: DEFAULT_SETTINGS.prune_orphaned_scans,
};

export function DataRetentionSection({ onDirtyChange }: DataRetentionSectionProps) {
    const { can, permissionsReady } = useAuth();
    const { isPaid } = useLicense();
    const { activeNode } = useNodes();
    const readOnly = !permissionsReady || !can('system:settings');
    const { settings, setSettings, dirtyCount, hasChanges, reset, markSaved } = useSettingsDirty<DataRetentionFields>({ ...DEFAULT_DATA_RETENTION });
    const { phase, isCurrentNodeLoaded, load, isSaveOwner, captureSaveGuard } = useNodeSettingsLoad(activeNode?.id);
    const [isSaving, setIsSaving] = useState(false);

    const reportDirty = isCurrentNodeLoaded && hasChanges;

    useEffect(() => {
        onDirtyChange?.(reportDirty);
    }, [reportDirty, onDirtyChange]);

    useMastheadStats(
        !isCurrentNodeLoaded
            ? null
            : [
                {
                    label: 'EDITED',
                    value: hasChanges ? `${dirtyCount} pending` : 'saved',
                    tone: hasChanges ? 'warn' : 'value',
                },
            ],
    );

    useEffect(() => {
        let cancelled = false;
        setIsSaving(false);
        void (async () => {
            const nodeData = await load();
            if (cancelled || !nodeData) return;
            const safe: DataRetentionFields = {
                metrics_retention_hours: nodeData.metrics_retention_hours ?? DEFAULT_SETTINGS.metrics_retention_hours,
                log_retention_days: nodeData.log_retention_days ?? DEFAULT_SETTINGS.log_retention_days,
                audit_retention_days: nodeData.audit_retention_days ?? DEFAULT_SETTINGS.audit_retention_days,
                scan_history_per_image_limit: nodeData.scan_history_per_image_limit ?? DEFAULT_SETTINGS.scan_history_per_image_limit,
                prune_orphaned_scans: (nodeData.prune_orphaned_scans as '0' | '1') ?? DEFAULT_SETTINGS.prune_orphaned_scans,
            };
            reset(safe);
        })();
        return () => {
            cancelled = true;
        };
    }, [activeNode?.id, load, reset]);

    const onSettingChange = <K extends keyof DataRetentionFields>(key: K, value: DataRetentionFields[K]) => {
        setSettings(prev => ({ ...prev, [key]: value }));
    };

    const saveSettings = async () => {
        const saveGuard = captureSaveGuard();
        const submitted = { ...settings };
        const payload: DataRetentionFields = {
            metrics_retention_hours: submitted.metrics_retention_hours,
            log_retention_days: submitted.log_retention_days,
            scan_history_per_image_limit: submitted.scan_history_per_image_limit,
            prune_orphaned_scans: submitted.prune_orphaned_scans,
        };
        // audit_retention_days is a paid-only key the backend rejects from a
        // Community operator. The field renders only when isPaid, so include it
        // in the save only then; otherwise a Community save would 403 on a key
        // the operator cannot edit and never sees.
        if (isPaid) {
            payload.audit_retention_days = submitted.audit_retention_days;
        }
        setIsSaving(true);
        try {
            const res = await apiFetch('/settings', {
                method: 'PATCH',
                nodeId: saveGuard.nodeId,
                body: JSON.stringify(payload),
            });
            if (!isSaveOwner(saveGuard)) return;
            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                toast.error(err?.error || err?.message || 'Failed to save settings.');
                return;
            }
            markSaved(submitted);
            toast.success('Data retention saved.');
            window.dispatchEvent(new CustomEvent<SenchoSettingsChangedDetail>(SENCHO_SETTINGS_CHANGED, {
                detail: { changedKeys: Object.keys(payload) },
            }));
        } catch (e: unknown) {
            if (!isSaveOwner(saveGuard)) return;
            toast.error((e as Error)?.message || 'Something went wrong.');
        } finally {
            if (isSaveOwner(saveGuard)) setIsSaving(false);
        }
    };

    return (
        <SettingsLoadGate phase={phase} isCurrentNodeLoaded={isCurrentNodeLoaded} skeleton={<SectionSkeleton />}>
        <fieldset disabled={readOnly} className="m-0 flex min-w-0 flex-col gap-10 border-0 p-0">
            <SettingsSection title="Retention windows">
                <SettingsField
                    label="Container metrics"
                    helper="How long to keep per-container CPU, RAM, and network history."
                >
                    <div className="flex items-center gap-2">
                        <Input
                            type="number"
                            min={1}
                            max={8760}
                            value={settings.metrics_retention_hours}
                            onChange={(e) => onSettingChange('metrics_retention_hours', e.target.value)}
                            className="w-24"
                        />
                        <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-stat-subtitle">hrs</span>
                    </div>
                </SettingsField>

                <SettingsField
                    label="Notification log"
                    helper="How long to keep alert and notification history."
                >
                    <div className="flex items-center gap-2">
                        <Input
                            type="number"
                            min={1}
                            max={365}
                            value={settings.log_retention_days}
                            onChange={(e) => onSettingChange('log_retention_days', e.target.value)}
                            className="w-24"
                        />
                        <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-stat-subtitle">days</span>
                    </div>
                </SettingsField>

                <SettingsField
                    label="Scan history per digest"
                    helper="How many vulnerability scans to keep per image digest (or per image reference when no digest is stored). Older scans beyond the cap are pruned."
                >
                    <div className="flex items-center gap-2">
                        <Input
                            type="number"
                            min={5}
                            max={1000}
                            value={settings.scan_history_per_image_limit}
                            onChange={(e) => onSettingChange('scan_history_per_image_limit', e.target.value)}
                            className="w-24"
                        />
                        <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-stat-subtitle">scans</span>
                    </div>
                </SettingsField>

                <SettingsField
                    label="Remove scans for deleted images and stacks"
                    helper="Keep the Security Overview tied to what still exists by deleting scan results once their image is gone from this node or their stack is deleted. On by default; turn it off to retain scan history for removed images and stacks."
                >
                    <TogglePill
                        checked={settings.prune_orphaned_scans === '1'}
                        onChange={(next) => onSettingChange('prune_orphaned_scans', next ? '1' : '0')}
                    />
                </SettingsField>

                {isPaid && (
                    <SettingsField
                        label="Audit log"
                        helper="How long to keep audit trail entries."
                    >
                        <div className="flex items-center gap-2">
                            <Input
                                type="number"
                                min={1}
                                max={365}
                                value={settings.audit_retention_days}
                                onChange={(e) => onSettingChange('audit_retention_days', e.target.value)}
                                className="w-24"
                            />
                            <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-stat-subtitle">days</span>
                        </div>
                    </SettingsField>
                )}
            </SettingsSection>

            <SettingsActions hint={readOnly ? 'Read-only · permission required to edit' : (hasChanges ? `${dirtyCount} unsaved` : undefined)}>
                {!readOnly && (
                    <SettingsPrimaryButton onClick={saveSettings} disabled={isSaving || !hasChanges || !isCurrentNodeLoaded}>
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
        </SettingsLoadGate>
    );
}
