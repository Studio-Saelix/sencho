import { useState, useEffect } from 'react';
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
import { useSettingsDirty } from './useSettingsDirty';
import { TogglePill } from '@/components/ui/toggle-pill';
import { NumberChip } from './SystemControls';

interface DriftDetectionSectionProps {
    onDirtyChange?: (dirty: boolean) => void;
}

function SectionSkeleton() {
    return (
        <div className="space-y-3 rounded-lg border border-glass-border bg-glass p-4">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
        </div>
    );
}

type DriftScanFields = Pick<PatchableSettings, 'drift_scan_enabled' | 'drift_scan_interval_minutes'>;

const DEFAULT_DRIFT_SCAN: DriftScanFields = {
    drift_scan_enabled: DEFAULT_SETTINGS.drift_scan_enabled,
    drift_scan_interval_minutes: DEFAULT_SETTINGS.drift_scan_interval_minutes,
};

export function DriftDetectionSection({ onDirtyChange }: DriftDetectionSectionProps) {
    const { activeNode } = useNodes();
    const { isAdmin } = useAuth();
    const readOnly = !isAdmin;
    const { settings, setSettings, dirtyCount, hasChanges, reset, markSaved } = useSettingsDirty<DriftScanFields>({ ...DEFAULT_DRIFT_SCAN });
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
                const res = await apiFetch('/settings');
                const data: Record<string, string> = res.ok ? await res.json() : {};
                reset({
                    drift_scan_enabled: (data.drift_scan_enabled as '0' | '1') ?? DEFAULT_SETTINGS.drift_scan_enabled,
                    drift_scan_interval_minutes: data.drift_scan_interval_minutes ?? DEFAULT_SETTINGS.drift_scan_interval_minutes,
                });
            } catch (e) {
                console.error('Failed to fetch drift detection settings', e);
            } finally {
                setIsLoading(false);
            }
        };
        fetchSettings();
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activeNode?.id]);

    const onSettingChange = <K extends keyof DriftScanFields>(key: K, value: DriftScanFields[K]) => {
        setSettings(prev => ({ ...prev, [key]: value }));
    };

    const saveSettings = async () => {
        const submitted = { ...settings };
        setIsSaving(true);
        try {
            const res = await apiFetch('/settings', {
                method: 'PATCH',
                body: JSON.stringify(submitted),
            });
            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                toast.error(err?.error || err?.message || 'Failed to save settings.');
                return;
            }
            markSaved(submitted);
            toast.success('Drift detection settings saved.');
        } catch (e: unknown) {
            toast.error((e as Error)?.message || 'Something went wrong.');
        } finally {
            setIsSaving(false);
        }
    };

    if (isLoading) return <SectionSkeleton />;

    return (
        <fieldset disabled={readOnly} className="m-0 flex min-w-0 flex-col gap-10 border-0 p-0">
            <SettingsSection title="Background drift detection" kicker="node-scoped">
                <SettingsField
                    label="Scan stacks for drift on a schedule"
                    helper="When on, this node periodically reconciles every stack so configuration drift is recorded in each stack's drift history and surfaced in the activity feed, without opening the Drift tab. Detection only: Sencho never changes a running stack to match its compose. Off by default."
                >
                    <TogglePill
                        checked={settings.drift_scan_enabled === '1'}
                        onChange={(next) => onSettingChange('drift_scan_enabled', next ? '1' : '0')}
                    />
                </SettingsField>
                <SettingsField
                    label="Scan every"
                    helper="How often a background scan runs while drift detection is on. The Drift tab still re-checks on demand and after every deploy, regardless of this interval."
                >
                    <NumberChip
                        value={settings.drift_scan_interval_minutes || '60'}
                        onChange={(v) => onSettingChange('drift_scan_interval_minutes', v)}
                        suffix="min"
                        min={15}
                        max={1440}
                        step={15}
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
                            'Save settings'
                        )}
                    </SettingsPrimaryButton>
                )}
            </SettingsActions>
        </fieldset>
    );
}
