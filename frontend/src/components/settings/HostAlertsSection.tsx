import { useState, useEffect } from 'react';
import { Skeleton } from '@/components/ui/skeleton';
import { RefreshCw } from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { toast } from '@/components/ui/toast-store';
import { useNodes } from '@/context/NodeContext';
import { useAuth } from '@/context/AuthContext';
import { canManageNode } from '@/lib/canManageNode';
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
import { NumberChip } from './SystemControls';

interface HostAlertsSectionProps {
    onDirtyChange?: (dirty: boolean) => void;
}

function SectionSkeleton() {
    return (
        <div className="space-y-3 rounded-lg border border-glass-border bg-glass p-4">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
        </div>
    );
}

type HostAlertFields = Pick<PatchableSettings, 'host_alerts_enabled' | 'host_cpu_limit' | 'host_ram_limit' | 'host_disk_limit' | 'host_alert_suppression_mins'>;

const DEFAULT_HOST_ALERTS: HostAlertFields = {
    host_alerts_enabled: DEFAULT_SETTINGS.host_alerts_enabled,
    host_cpu_limit: DEFAULT_SETTINGS.host_cpu_limit,
    host_ram_limit: DEFAULT_SETTINGS.host_ram_limit,
    host_disk_limit: DEFAULT_SETTINGS.host_disk_limit,
    host_alert_suppression_mins: DEFAULT_SETTINGS.host_alert_suppression_mins,
};

export function HostAlertsSection({ onDirtyChange }: HostAlertsSectionProps) {
    const { activeNode } = useNodes();
    const { can } = useAuth();
    const readOnly = !canManageNode(can, activeNode?.id);
    const { settings, setSettings, dirtyCount, hasChanges, reset, markSaved } = useSettingsDirty<HostAlertFields>({ ...DEFAULT_HOST_ALERTS });
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
            const safe: HostAlertFields = {
                host_alerts_enabled: (nodeData.host_alerts_enabled as '0' | '1') ?? DEFAULT_SETTINGS.host_alerts_enabled,
                host_cpu_limit: nodeData.host_cpu_limit ?? DEFAULT_SETTINGS.host_cpu_limit,
                host_ram_limit: nodeData.host_ram_limit ?? DEFAULT_SETTINGS.host_ram_limit,
                host_disk_limit: nodeData.host_disk_limit ?? DEFAULT_SETTINGS.host_disk_limit,
                host_alert_suppression_mins: nodeData.host_alert_suppression_mins ?? DEFAULT_SETTINGS.host_alert_suppression_mins,
            };
            reset(safe);
        })();
        return () => {
            cancelled = true;
        };
    }, [activeNode?.id, load, reset]);

    const onSettingChange = <K extends keyof HostAlertFields>(key: K, value: HostAlertFields[K]) => {
        setSettings(prev => ({ ...prev, [key]: value }));
    };

    const saveSettings = async () => {
        const saveGuard = captureSaveGuard();
        const submitted = { ...settings };
        setIsSaving(true);
        try {
            const res = await apiFetch('/settings', {
                method: 'PATCH',
                nodeId: saveGuard.nodeId,
                body: JSON.stringify(submitted),
            });
            if (!isSaveOwner(saveGuard)) return;
            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                toast.error(err?.error || err?.message || 'Failed to save settings.');
                return;
            }
            markSaved(submitted);
            toast.success('Host alert settings saved.');
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
            <SettingsSection title="Host thresholds">
                <SettingsField
                    label="Host threshold alerts"
                    helper="Master switch for CPU, RAM, and disk threshold alerts only. When OFF, no host threshold checks run and the controls below are inactive. Stack alert rules are unaffected."
                >
                    <TogglePill
                        checked={settings.host_alerts_enabled === '1'}
                        onChange={(next) => onSettingChange('host_alerts_enabled', next ? '1' : '0')}
                    />
                </SettingsField>
                <SettingsField
                    label="CPU limit"
                    helper="Alerts fire when host CPU utilization exceeds this percentage."
                >
                    <NumberChip
                        value={settings.host_cpu_limit || '90'}
                        onChange={(v) => onSettingChange('host_cpu_limit', v)}
                        suffix="%"
                        min={1}
                        max={100}
                        warnOver={95}
                        disabled={settings.host_alerts_enabled !== '1'}
                    />
                </SettingsField>
                <SettingsField
                    label="RAM limit"
                    helper="Swap is never acceptable. Set this below where the host begins paging."
                >
                    <NumberChip
                        value={settings.host_ram_limit || '90'}
                        onChange={(v) => onSettingChange('host_ram_limit', v)}
                        suffix="%"
                        min={1}
                        max={100}
                        warnOver={95}
                        disabled={settings.host_alerts_enabled !== '1'}
                    />
                </SettingsField>
                <SettingsField
                    label="Disk limit"
                    helper="Low free space slows image pulls and backups."
                >
                    <NumberChip
                        value={settings.host_disk_limit || '90'}
                        onChange={(v) => onSettingChange('host_disk_limit', v)}
                        suffix="%"
                        min={1}
                        max={100}
                        warnOver={95}
                        disabled={settings.host_alerts_enabled !== '1'}
                    />
                </SettingsField>
                <SettingsField
                    label="Alert suppression"
                    helper="How long to wait before resending a host alert while the metric stays over threshold. The follow-up message includes a count of suppressed cycles."
                >
                    <NumberChip
                        value={settings.host_alert_suppression_mins || '60'}
                        onChange={(v) => onSettingChange('host_alert_suppression_mins', v)}
                        suffix="min"
                        min={1}
                        max={1440}
                        disabled={settings.host_alerts_enabled !== '1'}
                    />
                </SettingsField>
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
                            'Save alerts'
                        )}
                    </SettingsPrimaryButton>
                )}
            </SettingsActions>
        </fieldset>
        </SettingsLoadGate>
    );
}
