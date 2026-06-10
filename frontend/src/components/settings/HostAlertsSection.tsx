import { useState, useRef, useEffect, useMemo } from 'react';
import { Skeleton } from '@/components/ui/skeleton';
import { RefreshCw } from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { toast } from '@/components/ui/toast-store';
import { useNodes } from '@/context/NodeContext';
import { useAuth } from '@/context/AuthContext';
import { DEFAULT_SETTINGS } from './types';
import type { PatchableSettings } from './types';
import { SettingsSection } from './SettingsSection';
import { SettingsField } from './SettingsField';
import { SettingsActions, SettingsPrimaryButton } from './SettingsActions';
import { useMastheadStats } from './MastheadStatsContext';
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

type HostAlertFields = Pick<PatchableSettings, 'host_cpu_limit' | 'host_ram_limit' | 'host_disk_limit' | 'host_alert_suppression_mins' | 'global_crash' | 'health_gate_enabled' | 'health_gate_window_seconds'>;

const DEFAULT_HOST_ALERTS: HostAlertFields = {
    host_cpu_limit: DEFAULT_SETTINGS.host_cpu_limit,
    host_ram_limit: DEFAULT_SETTINGS.host_ram_limit,
    host_disk_limit: DEFAULT_SETTINGS.host_disk_limit,
    host_alert_suppression_mins: DEFAULT_SETTINGS.host_alert_suppression_mins,
    global_crash: DEFAULT_SETTINGS.global_crash,
    health_gate_enabled: DEFAULT_SETTINGS.health_gate_enabled,
    health_gate_window_seconds: DEFAULT_SETTINGS.health_gate_window_seconds,
};

export function HostAlertsSection({ onDirtyChange }: HostAlertsSectionProps) {
    const { activeNode } = useNodes();
    const { isAdmin } = useAuth();
    const readOnly = !isAdmin;
    const [settings, setSettings] = useState<HostAlertFields>({ ...DEFAULT_HOST_ALERTS });
    const serverSettingsRef = useRef<HostAlertFields>({ ...DEFAULT_HOST_ALERTS });
    const [isLoading, setIsLoading] = useState(false);
    const [isSaving, setIsSaving] = useState(false);

    const dirtyCount = useMemo(() => {
        const baseline = serverSettingsRef.current;
        let n = 0;
        if (settings.host_cpu_limit !== baseline.host_cpu_limit) n++;
        if (settings.host_ram_limit !== baseline.host_ram_limit) n++;
        if (settings.host_disk_limit !== baseline.host_disk_limit) n++;
        if (settings.host_alert_suppression_mins !== baseline.host_alert_suppression_mins) n++;
        if (settings.global_crash !== baseline.global_crash) n++;
        if (settings.health_gate_enabled !== baseline.health_gate_enabled) n++;
        if (settings.health_gate_window_seconds !== baseline.health_gate_window_seconds) n++;
        return n;
    }, [settings]);

    const hasChanges = dirtyCount > 0;

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
                const safe: HostAlertFields = {
                    host_cpu_limit: nodeData.host_cpu_limit ?? DEFAULT_SETTINGS.host_cpu_limit,
                    host_ram_limit: nodeData.host_ram_limit ?? DEFAULT_SETTINGS.host_ram_limit,
                    host_disk_limit: nodeData.host_disk_limit ?? DEFAULT_SETTINGS.host_disk_limit,
                    host_alert_suppression_mins: nodeData.host_alert_suppression_mins ?? DEFAULT_SETTINGS.host_alert_suppression_mins,
                    global_crash: (nodeData.global_crash as '0' | '1') ?? DEFAULT_SETTINGS.global_crash,
                    health_gate_enabled: (nodeData.health_gate_enabled as '0' | '1') ?? DEFAULT_SETTINGS.health_gate_enabled,
                    health_gate_window_seconds: nodeData.health_gate_window_seconds ?? DEFAULT_SETTINGS.health_gate_window_seconds,
                };
                setSettings(safe);
                serverSettingsRef.current = { ...safe };
            } catch (e) {
                console.error('Failed to fetch host alert settings', e);
            } finally {
                setIsLoading(false);
            }
        };
        fetchSettings();
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activeNode?.id]);

    const onSettingChange = <K extends keyof HostAlertFields>(key: K, value: HostAlertFields[K]) => {
        setSettings(prev => ({ ...prev, [key]: value }));
    };

    const saveSettings = async () => {
        setIsSaving(true);
        try {
            const res = await apiFetch('/settings', {
                method: 'PATCH',
                body: JSON.stringify(settings),
            });
            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                toast.error(err?.error || err?.message || 'Failed to save settings.');
                return;
            }
            serverSettingsRef.current = { ...settings };
            toast.success('Host alerts saved.');
        } catch (e: unknown) {
            toast.error((e as Error)?.message || 'Something went wrong.');
        } finally {
            setIsSaving(false);
        }
    };

    if (isLoading) return <SectionSkeleton />;

    return (
        <fieldset disabled={readOnly} className="m-0 flex min-w-0 flex-col gap-10 border-0 p-0">
            <SettingsSection title="Host thresholds">
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
                    />
                </SettingsField>
            </SettingsSection>

            <SettingsSection title="Crash capture">
                <SettingsField
                    label="Global crash capture"
                    helper="Watch every managed container for unexpected exits."
                >
                    <TogglePill
                        checked={settings.global_crash === '1'}
                        onChange={(next) => onSettingChange('global_crash', next ? '1' : '0')}
                    />
                </SettingsField>
            </SettingsSection>

            <SettingsSection title="Update health gate">
                <SettingsField
                    label="Observe health after updates"
                    helper="After a stack deploy or update succeeds, watch its containers for the observation window and record a passed or failed verdict on the stack timeline. Observational only: nothing is restarted or rolled back automatically. On by default."
                >
                    <TogglePill
                        checked={settings.health_gate_enabled === '1'}
                        onChange={(next) => onSettingChange('health_gate_enabled', next ? '1' : '0')}
                    />
                </SettingsField>
                <SettingsField
                    label="Observation window"
                    helper="How long to watch containers before declaring the update healthy. Raise it for stacks that take a while to settle. Default 90 seconds."
                >
                    <NumberChip
                        value={settings.health_gate_window_seconds || '90'}
                        onChange={(v) => onSettingChange('health_gate_window_seconds', v)}
                        suffix="s"
                        min={15}
                        max={600}
                    />
                </SettingsField>
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
                            'Save alerts'
                        )}
                    </SettingsPrimaryButton>
                )}
            </SettingsActions>
        </fieldset>
    );
}
