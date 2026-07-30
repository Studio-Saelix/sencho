import { useState, useEffect } from 'react';
import { Skeleton } from '@/components/ui/skeleton';
import { RefreshCw } from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { toast } from '@/components/ui/toast-store';
import { useNodes } from '@/context/NodeContext';
import { useAuth } from '@/context/AuthContext';
import { useExperimental } from '@/hooks/useExperimental';
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

interface FleetMeshSectionProps {
    onDirtyChange?: (dirty: boolean) => void;
}

function SectionSkeleton() {
    return (
        <div className="space-y-3 rounded-lg border border-glass-border bg-glass p-4">
            <Skeleton className="h-10 w-full" />
        </div>
    );
}

type FleetMeshFields = Pick<PatchableSettings, 'mesh_auto_recreate' | 'snapshot_documentation'>;
type SnapshotOnlyFields = Pick<PatchableSettings, 'snapshot_documentation'>;

const DEFAULT_FLEET_MESH: FleetMeshFields = {
    mesh_auto_recreate: DEFAULT_SETTINGS.mesh_auto_recreate,
    snapshot_documentation: DEFAULT_SETTINGS.snapshot_documentation,
};

export function FleetMeshSection({ onDirtyChange }: FleetMeshSectionProps) {
    const { activeNode } = useNodes();
    const { isAdmin } = useAuth();
    const { experimental, experimentalReady } = useExperimental();
    const showMesh = experimentalReady && experimental;
    // Admin role only (section is adminOnly in the registry). Do not swap to can().
    const readOnly = !isAdmin;
    const { settings, setSettings, dirtyCount, hasChanges, reset, markSaved } = useSettingsDirty<FleetMeshFields>({ ...DEFAULT_FLEET_MESH });
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
            const safe: FleetMeshFields = {
                mesh_auto_recreate: (nodeData.mesh_auto_recreate as '0' | '1') ?? DEFAULT_SETTINGS.mesh_auto_recreate,
                snapshot_documentation: (nodeData.snapshot_documentation as '0' | '1') ?? DEFAULT_SETTINGS.snapshot_documentation,
            };
            reset(safe);
        })();
        return () => {
            cancelled = true;
        };
    }, [activeNode?.id, load, reset]);

    const onSettingChange = <K extends keyof FleetMeshFields>(key: K, value: FleetMeshFields[K]) => {
        setSettings(prev => ({ ...prev, [key]: value }));
    };

    const saveSettings = async () => {
        // When Mesh discovery is off, never write mesh_auto_recreate: a failed
        // settings read would otherwise push the default and overwrite a real
        // Mesh config the operator cannot see.
        const saveGuard = captureSaveGuard();
        const submitted: FleetMeshFields | SnapshotOnlyFields = showMesh
            ? { ...settings }
            : { snapshot_documentation: settings.snapshot_documentation };
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
            if (showMesh) {
                markSaved(submitted as FleetMeshFields);
            } else {
                markSaved({
                    ...settings,
                    snapshot_documentation: (submitted as SnapshotOnlyFields).snapshot_documentation,
                });
            }
            toast.success('Fleet settings saved.');
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
            {showMesh && (
                <SettingsSection title="Mesh data plane">
                    <SettingsField
                        label="Auto-recreate mesh network"
                        helper="If sencho_mesh is removed at runtime, rebuild it at the same subnet on the next 10s tick. Off by default; leave off and restart Sencho manually for the safest path."
                    >
                        <TogglePill
                            checked={settings.mesh_auto_recreate === '1'}
                            onChange={(next) => onSettingChange('mesh_auto_recreate', next ? '1' : '0')}
                        />
                    </SettingsField>
                </SettingsSection>
            )}

            <SettingsSection title="Documentation snapshots">
                <SettingsField
                    label="Capture stack documentation in snapshots"
                    helper="Preserve each stack's Dossier notes alongside its captured files. Restoring a stack never overwrites current notes unless you explicitly choose to. Off by default."
                >
                    <TogglePill
                        checked={settings.snapshot_documentation === '1'}
                        onChange={(next) => onSettingChange('snapshot_documentation', next ? '1' : '0')}
                    />
                </SettingsField>
            </SettingsSection>

            <SettingsActions hint={readOnly ? 'Read-only · admin access required to edit' : (hasChanges ? `${dirtyCount} unsaved` : undefined)}>
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
