import { useState, useRef, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from '@/components/ui/toast-store';
import { apiFetch } from '@/lib/api';
import { useAuth } from '@/context/AuthContext';
import { useNodes } from '@/context/NodeContext';
import { canManageNode } from '@/lib/canManageNode';
import { RefreshCw } from 'lucide-react';
import { SettingsSection } from './SettingsSection';
import { SettingsField } from './SettingsField';
import { SettingsActions, SettingsPrimaryButton } from './SettingsActions';
import { useNodeSettingsLoad } from './useNodeSettingsLoad';
import { SettingsLoadGate } from './SettingsLoadError';

function SectionSkeleton() {
    return (
        <div className="space-y-3 rounded-lg border border-glass-border bg-glass p-4">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
        </div>
    );
}

export function AppStoreSection() {
    const { can } = useAuth();
    const { activeNode } = useNodes();
    const readOnly = !canManageNode(can, activeNode?.id);
    const [templateRegistryUrl, setTemplateRegistryUrl] = useState('');
    const serverUrl = useRef('');
    const { phase, isCurrentNodeLoaded, load, isSaveOwner, captureSaveGuard } = useNodeSettingsLoad(activeNode?.id);
    const [isSavingRegistry, setIsSavingRegistry] = useState(false);

    useEffect(() => {
        let cancelled = false;
        setIsSavingRegistry(false);
        void (async () => {
            const nodeData = await load();
            if (cancelled || !nodeData) return;
            const url = nodeData.template_registry_url ?? '';
            setTemplateRegistryUrl(url);
            serverUrl.current = url;
        })();
        return () => {
            cancelled = true;
        };
    }, [activeNode?.id, load]);

    const saveRegistrySettings = async () => {
        const saveGuard = captureSaveGuard();
        const trimmedUrl = templateRegistryUrl.trim();
        if (trimmedUrl && !/^https?:\/\/./.test(trimmedUrl)) {
            toast.error('Registry URL must start with http:// or https://');
            return;
        }
        setIsSavingRegistry(true);
        try {
            const res = await apiFetch('/settings', {
                method: 'PATCH',
                nodeId: saveGuard.nodeId,
                body: JSON.stringify({ template_registry_url: trimmedUrl }),
            });
            if (!res.ok) {
                if (isSaveOwner(saveGuard)) {
                    const err = await res.json().catch(() => ({}));
                    toast.error(err?.error || err?.message || 'Failed to save registry settings.');
                }
                return;
            }
            // Always refresh the node that received the PATCH, even after a switch.
            const refresh = await apiFetch('/templates/refresh-cache', {
                method: 'POST',
                nodeId: saveGuard.nodeId,
            });
            if (!isSaveOwner(saveGuard)) return;
            if (!refresh.ok) {
                toast.error('Registry saved, but refreshing the App Store cache failed.');
                return;
            }
            serverUrl.current = templateRegistryUrl;
            toast.success('Registry saved. App Store will reload from the new source.');
        } catch (e: unknown) {
            if (!isSaveOwner(saveGuard)) return;
            toast.error((e as Error)?.message || 'Failed to save registry settings.');
        } finally {
            if (isSaveOwner(saveGuard)) setIsSavingRegistry(false);
        }
    };

    return (
        <SettingsLoadGate phase={phase} isCurrentNodeLoaded={isCurrentNodeLoaded} skeleton={<SectionSkeleton />}>
        <fieldset disabled={readOnly} className="m-0 flex min-w-0 flex-col gap-10 border-0 p-0">
            <SettingsSection title="Default registry">
                <SettingsField
                    label="LinuxServer.io"
                    helper="Used when no custom registry is set."
                >
                    <code className="font-mono text-xs text-stat-subtitle">
                        api.linuxserver.io/api/v1/images
                    </code>
                </SettingsField>
            </SettingsSection>

            <SettingsSection title="Custom registry">
                <SettingsField
                    label="Registry URL"
                    helper="Provide a Portainer v2 compatible template JSON URL. Overrides the default registry. Leave empty to use LinuxServer.io."
                    htmlFor="template-registry-url"
                >
                    <Input
                        id="template-registry-url"
                        placeholder="https://example.com/templates.json"
                        value={templateRegistryUrl}
                        onChange={(e) => setTemplateRegistryUrl(e.target.value)}
                    />
                </SettingsField>

                <SettingsActions align="between" hint={readOnly ? 'Read-only · permission required to edit' : (templateRegistryUrl ? 'using custom registry' : 'using default')}>
                    {!readOnly && (
                        <div className="flex items-center gap-2">
                            <Button
                                variant="outline"
                                size="sm"
                                onClick={() => setTemplateRegistryUrl('')}
                                disabled={isSavingRegistry || !templateRegistryUrl || !isCurrentNodeLoaded}
                            >
                                Reset to default
                            </Button>
                            <SettingsPrimaryButton onClick={saveRegistrySettings} disabled={isSavingRegistry || !isCurrentNodeLoaded}>
                                {isSavingRegistry ? (
                                    <>
                                        <RefreshCw className="w-4 h-4 animate-spin" />
                                        Saving
                                    </>
                                ) : (
                                    'Save & refresh'
                                )}
                            </SettingsPrimaryButton>
                        </div>
                    )}
                </SettingsActions>
            </SettingsSection>
        </fieldset>
        </SettingsLoadGate>
    );
}
