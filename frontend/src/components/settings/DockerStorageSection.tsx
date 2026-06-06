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

interface DockerStorageSectionProps {
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

type DockerStorageFields = Pick<PatchableSettings, 'docker_janitor_gb' | 'prune_on_update' | 'reclaim_hero'>;

const DEFAULT_DOCKER_STORAGE: DockerStorageFields = {
    docker_janitor_gb: DEFAULT_SETTINGS.docker_janitor_gb,
    prune_on_update: DEFAULT_SETTINGS.prune_on_update,
    reclaim_hero: DEFAULT_SETTINGS.reclaim_hero,
};

export function DockerStorageSection({ onDirtyChange }: DockerStorageSectionProps) {
    const { activeNode } = useNodes();
    const { isAdmin } = useAuth();
    const readOnly = !isAdmin;
    const [settings, setSettings] = useState<DockerStorageFields>({ ...DEFAULT_DOCKER_STORAGE });
    const serverSettingsRef = useRef<DockerStorageFields>({ ...DEFAULT_DOCKER_STORAGE });
    const [isLoading, setIsLoading] = useState(false);
    const [isSaving, setIsSaving] = useState(false);

    const dirtyCount = useMemo(() => {
        const baseline = serverSettingsRef.current;
        let n = 0;
        if (settings.docker_janitor_gb !== baseline.docker_janitor_gb) n++;
        if (settings.prune_on_update !== baseline.prune_on_update) n++;
        if (settings.reclaim_hero !== baseline.reclaim_hero) n++;
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
                const safe: DockerStorageFields = {
                    docker_janitor_gb: nodeData.docker_janitor_gb ?? DEFAULT_SETTINGS.docker_janitor_gb,
                    prune_on_update: (nodeData.prune_on_update as '0' | '1') ?? DEFAULT_SETTINGS.prune_on_update,
                    reclaim_hero: (nodeData.reclaim_hero as '0' | '1') ?? DEFAULT_SETTINGS.reclaim_hero,
                };
                setSettings(safe);
                serverSettingsRef.current = { ...safe };
            } catch (e) {
                console.error('Failed to fetch Docker & storage settings', e);
            } finally {
                setIsLoading(false);
            }
        };
        fetchSettings();
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activeNode?.id]);

    const onSettingChange = <K extends keyof DockerStorageFields>(key: K, value: DockerStorageFields[K]) => {
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
            toast.success('Docker & storage settings saved.');
        } catch (e: unknown) {
            toast.error((e as Error)?.message || 'Something went wrong.');
        } finally {
            setIsSaving(false);
        }
    };

    if (isLoading) return <SectionSkeleton />;

    return (
        <fieldset disabled={readOnly} className="m-0 flex min-w-0 flex-col gap-10 border-0 p-0">
            <SettingsSection title="Storage alerts">
                <SettingsField
                    label="Janitor threshold"
                    helper="Alert when reclaimable Docker data exceeds this size."
                >
                    <NumberChip
                        value={settings.docker_janitor_gb || '5'}
                        onChange={(v) => onSettingChange('docker_janitor_gb', v)}
                        suffix="GiB"
                        min={0}
                        step={0.5}
                        warnOver={10}
                    />
                </SettingsField>
                <SettingsField
                    label="Show reclaimable-space banner"
                    helper="Show the reclaimable-space banner at the top of the Resource Hub when this node has unused images, stopped containers, or dangling volumes to clear. On by default."
                >
                    <TogglePill
                        checked={settings.reclaim_hero === '1'}
                        onChange={(next) => onSettingChange('reclaim_hero', next ? '1' : '0')}
                    />
                </SettingsField>
            </SettingsSection>

            <SettingsSection title="Image cleanup">
                <SettingsField
                    label="Prune dangling images after updates"
                    helper="When an update finishes, remove the node's dangling (untagged) image layers, including the one the update just orphaned. On by default; turn it off to keep every old layer. Applies to stack updates and Sencho self-updates on this node."
                >
                    <TogglePill
                        checked={settings.prune_on_update === '1'}
                        onChange={(next) => onSettingChange('prune_on_update', next ? '1' : '0')}
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
