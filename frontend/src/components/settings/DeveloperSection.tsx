import { useState, useRef, useEffect } from 'react';
import { Input } from '@/components/ui/input';
import { TogglePill } from '@/components/ui/toggle-pill';
import { Skeleton } from '@/components/ui/skeleton';
import { useLicense } from '@/context/LicenseContext';
import { RefreshCw } from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { toast } from '@/components/ui/toast-store';
import { useNodes } from '@/context/NodeContext';
import { SENCHO_SETTINGS_CHANGED } from '@/lib/events';
import type { SenchoSettingsChangedDetail } from '@/lib/events';
import { DEFAULT_SETTINGS } from './types';
import type { PatchableSettings } from './types';
import { SettingsSection } from './SettingsSection';
import { SettingsField } from './SettingsField';
import { SettingsActions, SettingsPrimaryButton } from './SettingsActions';
import { useMastheadStats } from './MastheadStatsContext';

interface DeveloperSectionProps {
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

type DeveloperFields = Pick<PatchableSettings, 'developer_mode' | 'metrics_retention_hours' | 'log_retention_days' | 'audit_retention_days' | 'scan_history_per_image_limit'>;

const DEFAULT_DEVELOPER: DeveloperFields = {
    developer_mode: DEFAULT_SETTINGS.developer_mode,
    metrics_retention_hours: DEFAULT_SETTINGS.metrics_retention_hours,
    log_retention_days: DEFAULT_SETTINGS.log_retention_days,
    audit_retention_days: DEFAULT_SETTINGS.audit_retention_days,
    scan_history_per_image_limit: DEFAULT_SETTINGS.scan_history_per_image_limit,
};

export function DeveloperSection({ onDirtyChange }: DeveloperSectionProps) {
    const { isPaid, license } = useLicense();
    const { activeNode } = useNodes();
    const [settings, setSettings] = useState<DeveloperFields>({ ...DEFAULT_DEVELOPER });
    const serverSettingsRef = useRef<DeveloperFields>({ ...DEFAULT_DEVELOPER });
    const [isLoading, setIsLoading] = useState(false);
    const [isSaving, setIsSaving] = useState(false);

    const hasChanges =
        settings.developer_mode !== serverSettingsRef.current.developer_mode ||
        settings.metrics_retention_hours !== serverSettingsRef.current.metrics_retention_hours ||
        settings.log_retention_days !== serverSettingsRef.current.log_retention_days ||
        settings.audit_retention_days !== serverSettingsRef.current.audit_retention_days ||
        settings.scan_history_per_image_limit !== serverSettingsRef.current.scan_history_per_image_limit;

    useEffect(() => {
        onDirtyChange?.(hasChanges);
    }, [hasChanges, onDirtyChange]);

    useMastheadStats(
        isLoading
            ? null
            : [
                {
                    label: 'DEV MODE',
                    value: settings.developer_mode === '1' ? 'on' : 'off',
                    tone: settings.developer_mode === '1' ? 'warn' : 'subtitle',
                },
            ],
    );

    useEffect(() => {
        const fetchSettings = async () => {
            setIsLoading(true);
            try {
                const isRemote = activeNode?.type === 'remote';
                const nodeRes = await apiFetch('/settings');
                const localRes = isRemote ? await apiFetch('/settings', { localOnly: true }) : nodeRes;
                const nodeData: Record<string, string> = nodeRes.ok ? await nodeRes.json() : {};
                const localData: Record<string, string> = (isRemote && localRes.ok)
                    ? await localRes.json()
                    : nodeData;
                const safe: DeveloperFields = {
                    developer_mode: (localData.developer_mode as '0' | '1') ?? DEFAULT_SETTINGS.developer_mode,
                    metrics_retention_hours: localData.metrics_retention_hours ?? DEFAULT_SETTINGS.metrics_retention_hours,
                    log_retention_days: localData.log_retention_days ?? DEFAULT_SETTINGS.log_retention_days,
                    audit_retention_days: localData.audit_retention_days ?? DEFAULT_SETTINGS.audit_retention_days,
                    scan_history_per_image_limit: localData.scan_history_per_image_limit ?? DEFAULT_SETTINGS.scan_history_per_image_limit,
                };
                setSettings(safe);
                serverSettingsRef.current = { ...safe };
            } catch (e) {
                console.error('Failed to fetch developer settings', e);
            } finally {
                setIsLoading(false);
            }
        };
        fetchSettings();
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activeNode?.id]);

    const onSettingChange = <K extends keyof DeveloperFields>(key: K, value: DeveloperFields[K]) => {
        setSettings(prev => ({ ...prev, [key]: value }));
    };

    const saveSettings = async () => {
        const payload = {
            developer_mode: settings.developer_mode,
            metrics_retention_hours: settings.metrics_retention_hours,
            log_retention_days: settings.log_retention_days,
            audit_retention_days: settings.audit_retention_days,
            scan_history_per_image_limit: settings.scan_history_per_image_limit,
        };
        setIsSaving(true);
        try {
            const res = await apiFetch('/settings', {
                method: 'PATCH',
                body: JSON.stringify(payload),
                localOnly: true,
            });
            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                toast.error(err?.error || err?.message || 'Failed to save settings.');
                return;
            }
            serverSettingsRef.current = { ...settings };
            toast.success('Developer settings saved.');
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
        <div className="flex flex-col gap-10">
            <SettingsSection title="Diagnostics">
                <SettingsField
                    label="Developer mode"
                    helper="Enable real-time metrics streams and verbose debug diagnostics in the UI."
                >
                    <TogglePill
                        id="developer_mode"
                        checked={settings.developer_mode === '1'}
                        onChange={(c) => onSettingChange('developer_mode', c ? '1' : '0')}
                    />
                </SettingsField>
            </SettingsSection>

            <SettingsSection title="Data retention">
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

                {isPaid && license?.variant === 'admiral' && (
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

            <SettingsActions hint={hasChanges ? 'unsaved changes' : undefined}>
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
            </SettingsActions>
        </div>
    );
}
