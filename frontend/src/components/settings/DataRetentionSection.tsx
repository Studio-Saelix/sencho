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

type DataRetentionFields = Pick<PatchableSettings, 'metrics_retention_hours' | 'log_retention_days' | 'audit_retention_days' | 'scan_history_per_image_limit'>;

const DEFAULT_DATA_RETENTION: DataRetentionFields = {
    metrics_retention_hours: DEFAULT_SETTINGS.metrics_retention_hours,
    log_retention_days: DEFAULT_SETTINGS.log_retention_days,
    audit_retention_days: DEFAULT_SETTINGS.audit_retention_days,
    scan_history_per_image_limit: DEFAULT_SETTINGS.scan_history_per_image_limit,
};

export function DataRetentionSection({ onDirtyChange }: DataRetentionSectionProps) {
    const { isAdmin } = useAuth();
    const { isPaid } = useLicense();
    const { activeNode } = useNodes();
    const readOnly = !isAdmin;
    const { settings, setSettings, dirtyCount, hasChanges, reset, markSaved } = useSettingsDirty<DataRetentionFields>({ ...DEFAULT_DATA_RETENTION });
    const [isLoading, setIsLoading] = useState(false);
    const [isSaving, setIsSaving] = useState(false);

    useEffect(() => {
        onDirtyChange?.(hasChanges);
    }, [hasChanges, onDirtyChange]);

    useMastheadStats(
        isLoading
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
        const fetchSettings = async () => {
            setIsLoading(true);
            try {
                const nodeRes = await apiFetch('/settings');
                const nodeData: Record<string, string> = nodeRes.ok ? await nodeRes.json() : {};
                const safe: DataRetentionFields = {
                    metrics_retention_hours: nodeData.metrics_retention_hours ?? DEFAULT_SETTINGS.metrics_retention_hours,
                    log_retention_days: nodeData.log_retention_days ?? DEFAULT_SETTINGS.log_retention_days,
                    audit_retention_days: nodeData.audit_retention_days ?? DEFAULT_SETTINGS.audit_retention_days,
                    scan_history_per_image_limit: nodeData.scan_history_per_image_limit ?? DEFAULT_SETTINGS.scan_history_per_image_limit,
                };
                reset(safe);
            } catch (e) {
                console.error('Failed to fetch data retention settings', e);
            } finally {
                setIsLoading(false);
            }
        };
        fetchSettings();
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activeNode?.id]);

    const onSettingChange = <K extends keyof DataRetentionFields>(key: K, value: DataRetentionFields[K]) => {
        setSettings(prev => ({ ...prev, [key]: value }));
    };

    const saveSettings = async () => {
        const submitted = { ...settings };
        const payload: DataRetentionFields = {
            metrics_retention_hours: submitted.metrics_retention_hours,
            log_retention_days: submitted.log_retention_days,
            scan_history_per_image_limit: submitted.scan_history_per_image_limit,
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
                body: JSON.stringify(payload),
            });
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
            toast.error((e as Error)?.message || 'Something went wrong.');
        } finally {
            setIsSaving(false);
        }
    };

    if (isLoading) return <SectionSkeleton />;

    return (
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
                    label="Scan history per image"
                    helper="How many vulnerability scans to keep per image. Older scans beyond the cap are pruned."
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

            <SettingsActions hint={readOnly ? 'Read-only · admin access required to edit' : (hasChanges ? `${dirtyCount} unsaved` : undefined)}>
                {!readOnly && (
                    <SettingsPrimaryButton onClick={saveSettings} disabled={isSaving || !hasChanges}>
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
    );
}
