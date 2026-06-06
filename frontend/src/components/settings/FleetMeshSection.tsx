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

type FleetMeshFields = Pick<PatchableSettings, 'mesh_auto_recreate'>;

const DEFAULT_FLEET_MESH: FleetMeshFields = {
    mesh_auto_recreate: DEFAULT_SETTINGS.mesh_auto_recreate,
};

export function FleetMeshSection({ onDirtyChange }: FleetMeshSectionProps) {
    const { activeNode } = useNodes();
    const { isAdmin } = useAuth();
    const readOnly = !isAdmin;
    const [settings, setSettings] = useState<FleetMeshFields>({ ...DEFAULT_FLEET_MESH });
    const serverSettingsRef = useRef<FleetMeshFields>({ ...DEFAULT_FLEET_MESH });
    const [isLoading, setIsLoading] = useState(false);
    const [isSaving, setIsSaving] = useState(false);

    const dirtyCount = useMemo(() => {
        const baseline = serverSettingsRef.current;
        let n = 0;
        if (settings.mesh_auto_recreate !== baseline.mesh_auto_recreate) n++;
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
                const safe: FleetMeshFields = {
                    mesh_auto_recreate: (nodeData.mesh_auto_recreate as '0' | '1') ?? DEFAULT_SETTINGS.mesh_auto_recreate,
                };
                setSettings(safe);
                serverSettingsRef.current = { ...safe };
            } catch (e) {
                console.error('Failed to fetch fleet mesh settings', e);
            } finally {
                setIsLoading(false);
            }
        };
        fetchSettings();
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activeNode?.id]);

    const onSettingChange = <K extends keyof FleetMeshFields>(key: K, value: FleetMeshFields[K]) => {
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
            toast.success('Mesh settings saved.');
        } catch (e: unknown) {
            toast.error((e as Error)?.message || 'Something went wrong.');
        } finally {
            setIsSaving(false);
        }
    };

    if (isLoading) return <SectionSkeleton />;

    return (
        <fieldset disabled={readOnly} className="m-0 flex min-w-0 flex-col gap-10 border-0 p-0">
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
