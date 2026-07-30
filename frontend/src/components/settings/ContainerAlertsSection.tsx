import { useState, useEffect } from 'react';
import { TogglePill } from '@/components/ui/toggle-pill';
import { Skeleton } from '@/components/ui/skeleton';
import { useAuth } from '@/context/AuthContext';
import { RefreshCw } from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { canManageNode } from '@/lib/canManageNode';
import { toast } from '@/components/ui/toast-store';
import { useNodes } from '@/context/NodeContext';
import { DEFAULT_SETTINGS } from './types';
import type { PatchableSettings } from './types';
import { SettingsSection } from './SettingsSection';
import { SettingsField } from './SettingsField';
import { SettingsActions, SettingsPrimaryButton } from './SettingsActions';
import { useMastheadStats } from './MastheadStatsContext';
import { useSettingsDirty } from './useSettingsDirty';
import { useNodeSettingsLoad } from './useNodeSettingsLoad';
import { SettingsLoadGate } from './SettingsLoadError';

interface ContainerAlertsSectionProps {
    onDirtyChange?: (dirty: boolean) => void;
}

function SectionSkeleton() {
    return (
        <div className="space-y-3 rounded-lg border border-glass-border bg-glass p-4">
            <Skeleton className="h-10 w-full" />
        </div>
    );
}

type ContainerAlertFields = Pick<PatchableSettings, 'global_crash'>;

const DEFAULT_CONTAINER_ALERTS: ContainerAlertFields = {
    global_crash: DEFAULT_SETTINGS.global_crash,
};

export function ContainerAlertsSection({ onDirtyChange }: ContainerAlertsSectionProps) {
    const { can } = useAuth();
    const { activeNode } = useNodes();
    const readOnly = !canManageNode(can, activeNode?.id);
    const { settings, setSettings, dirtyCount, hasChanges, reset, markSaved } = useSettingsDirty<ContainerAlertFields>({ ...DEFAULT_CONTAINER_ALERTS });
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
            const safe: ContainerAlertFields = {
                global_crash: (nodeData.global_crash as '0' | '1') ?? DEFAULT_SETTINGS.global_crash,
            };
            reset(safe);
        })();
        return () => {
            cancelled = true;
        };
    }, [activeNode?.id, load, reset]);

    const onSettingChange = <K extends keyof ContainerAlertFields>(key: K, value: ContainerAlertFields[K]) => {
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
                body: JSON.stringify({ global_crash: submitted.global_crash }),
            });
            if (!isSaveOwner(saveGuard)) return;
            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                toast.error(err?.error || err?.message || 'Failed to save settings.');
                return;
            }
            markSaved(submitted);
            toast.success('Container alert settings saved.');
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
            <SettingsSection title="Container crash & health alerts">
                <SettingsField
                    label="Container crash & health alerts"
                    helper="Send alerts for unexpected container exits, OOM kills, and Docker healthcheck failures. Auto-Heal can still observe crash signals independently."
                >
                    <TogglePill
                        checked={settings.global_crash === '1'}
                        onChange={(c) => onSettingChange('global_crash', c ? '1' : '0')}
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
                            'Save settings'
                        )}
                    </SettingsPrimaryButton>
                )}
            </SettingsActions>
        </fieldset>
        </SettingsLoadGate>
    );
}
