import { useState, useRef, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from '@/components/ui/toast-store';
import { apiFetch } from '@/lib/api';
import { useAuth } from '@/context/AuthContext';
import { RefreshCw } from 'lucide-react';
import { SettingsSection } from './SettingsSection';
import { SettingsField } from './SettingsField';
import { SettingsActions, SettingsPrimaryButton } from './SettingsActions';

function SectionSkeleton() {
    return (
        <div className="space-y-3 rounded-lg border border-glass-border bg-glass p-4">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
        </div>
    );
}

export function AppStoreSection() {
    const { isAdmin } = useAuth();
    const readOnly = !isAdmin;
    const [templateRegistryUrl, setTemplateRegistryUrl] = useState('');
    const serverUrl = useRef('');
    const [isLoading, setIsLoading] = useState(false);
    const [isSavingRegistry, setIsSavingRegistry] = useState(false);

    useEffect(() => {
        const fetchSettings = async () => {
            setIsLoading(true);
            try {
                const res = await apiFetch('/settings');
                if (res.ok) {
                    const data: Record<string, string> = await res.json();
                    const url = data.template_registry_url ?? '';
                    setTemplateRegistryUrl(url);
                    serverUrl.current = url;
                }
            } catch (e) {
                console.error('Failed to fetch app store settings', e);
            } finally {
                setIsLoading(false);
            }
        };
        fetchSettings();
    }, []);

    const saveRegistrySettings = async () => {
        const trimmedUrl = templateRegistryUrl.trim();
        if (trimmedUrl && !/^https?:\/\/./.test(trimmedUrl)) {
            toast.error('Registry URL must start with http:// or https://');
            return;
        }
        setIsSavingRegistry(true);
        try {
            const res = await apiFetch('/settings', {
                method: 'PATCH',
                body: JSON.stringify({ template_registry_url: trimmedUrl }),
            });
            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                toast.error(err?.error || err?.message || 'Failed to save registry settings.');
                return;
            }
            serverUrl.current = templateRegistryUrl;
            await apiFetch('/templates/refresh-cache', { method: 'POST' });
            toast.success('Registry saved. App Store will reload from the new source.');
        } catch (e: unknown) {
            toast.error((e as Error)?.message || 'Failed to save registry settings.');
        } finally {
            setIsSavingRegistry(false);
        }
    };

    if (isLoading) return <SectionSkeleton />;

    return (
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

                <SettingsActions align="between" hint={readOnly ? 'Read-only · admin access required to edit' : (templateRegistryUrl ? 'using custom registry' : 'using default')}>
                    {!readOnly && (
                        <div className="flex items-center gap-2">
                            <Button
                                variant="outline"
                                size="sm"
                                onClick={() => setTemplateRegistryUrl('')}
                                disabled={isSavingRegistry || !templateRegistryUrl}
                            >
                                Reset to default
                            </Button>
                            <SettingsPrimaryButton onClick={saveRegistrySettings} disabled={isSavingRegistry}>
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
    );
}
