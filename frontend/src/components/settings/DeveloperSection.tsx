import { useState, useEffect } from 'react';
import { TogglePill } from '@/components/ui/toggle-pill';
import { Skeleton } from '@/components/ui/skeleton';
import { useAuth } from '@/context/AuthContext';
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
import { useSettingsDirty } from './useSettingsDirty';

interface DeveloperSectionProps {
    onDirtyChange?: (dirty: boolean) => void;
}

function SectionSkeleton() {
    return (
        <div className="space-y-3 rounded-lg border border-glass-border bg-glass p-4">
            <Skeleton className="h-10 w-full" />
        </div>
    );
}

type DeveloperFields = Pick<PatchableSettings, 'developer_mode'>;

const DEFAULT_DEVELOPER: DeveloperFields = {
    developer_mode: DEFAULT_SETTINGS.developer_mode,
};

export function DeveloperSection({ onDirtyChange }: DeveloperSectionProps) {
    const { isAdmin } = useAuth();
    const { activeNode } = useNodes();
    const readOnly = !isAdmin;
    const { settings, setSettings, hasChanges, reset, markSaved } = useSettingsDirty<DeveloperFields>({ ...DEFAULT_DEVELOPER });
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
                const nodeRes = await apiFetch('/settings');
                const nodeData: Record<string, string> = nodeRes.ok ? await nodeRes.json() : {};
                const safe: DeveloperFields = {
                    developer_mode: (nodeData.developer_mode as '0' | '1') ?? DEFAULT_SETTINGS.developer_mode,
                };
                reset(safe);
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
        const submitted = { ...settings };
        const payload = {
            developer_mode: submitted.developer_mode,
        };
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
        <fieldset disabled={readOnly} className="m-0 flex min-w-0 flex-col gap-10 border-0 p-0">
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

            <SettingsActions hint={readOnly ? 'Read-only · admin access required to edit' : (hasChanges ? 'unsaved changes' : undefined)}>
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
