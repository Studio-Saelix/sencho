import { useState, useEffect } from 'react';
import { Tabs, TabsContent, TabsList, TabsTrigger, TabsHighlight, TabsHighlightItem } from '@/components/ui/tabs';
import { springs } from '@/lib/motion';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { TogglePill } from '@/components/ui/toggle-pill';
import { toast } from '@/components/ui/toast-store';
import { apiFetch } from '@/lib/api';
import { useNodes } from '@/context/NodeContext';
import { RefreshCw } from 'lucide-react';
import type { Agent } from './types';
import { SettingsSection } from './SettingsSection';
import { SettingsField } from './SettingsField';
import { SettingsActions, SettingsPrimaryButton } from './SettingsActions';
import { useMastheadStats } from './MastheadStatsContext';

export function NotificationsSection() {
    const { activeNode } = useNodes();

    const [notifTab, setNotifTab] = useState<'discord' | 'slack' | 'webhook'>('discord');
    const [agents, setAgents] = useState<Record<string, Agent>>({
        discord: { type: 'discord', url: '', enabled: false },
        slack: { type: 'slack', url: '', enabled: false },
        webhook: { type: 'webhook', url: '', enabled: false },
    });
    const [isSavingAgent, setIsSavingAgent] = useState<Record<string, boolean>>({});
    const [isTestingAgent, setIsTestingAgent] = useState<Record<string, boolean>>({});

    const fetchAgents = async () => {
        try {
            const res = await apiFetch('/agents');
            if (res.ok) {
                const data: Agent[] = await res.json();
                setAgents(prev => {
                    const next = { ...prev };
                    data.forEach(a => { next[a.type] = a; });
                    return next;
                });
            }
        } catch (e) {
            console.error('Failed to fetch agents', e);
        }
    };

    useEffect(() => { fetchAgents(); }, [activeNode?.id]); // eslint-disable-line react-hooks/exhaustive-deps

    const enabledCount = Object.values(agents).filter(a => a.enabled).length;
    useMastheadStats([
        {
            label: 'CHANNELS',
            value: `${enabledCount}/3`,
            tone: enabledCount > 0 ? 'value' : 'subtitle',
        },
    ]);

    const handleAgentChange = (type: string, field: keyof Agent, value: Agent[keyof Agent]) => {
        setAgents(prev => ({
            ...prev,
            [type]: { ...prev[type], [field]: value },
        }));
    };

    const saveAgent = async (type: string) => {
        setIsSavingAgent(prev => ({ ...prev, [type]: true }));
        try {
            const res = await apiFetch('/agents', {
                method: 'POST',
                body: JSON.stringify(agents[type]),
            });
            if (res.ok) {
                toast.success(`${type.charAt(0).toUpperCase() + type.slice(1)} settings saved.`);
            } else {
                const err = await res.json().catch(() => ({}));
                toast.error(err?.error || err?.message || 'Something went wrong.');
            }
        } catch (e: unknown) {
            toast.error((e as Error)?.message || 'Network error.');
        } finally {
            setIsSavingAgent(prev => ({ ...prev, [type]: false }));
        }
    };

    const testAgent = async (type: string) => {
        if (!agents[type].url) {
            toast.error('Please enter a webhook URL first.');
            return;
        }
        setIsTestingAgent(prev => ({ ...prev, [type]: true }));
        try {
            const res = await apiFetch('/notifications/test', {
                method: 'POST',
                body: JSON.stringify({ type, url: agents[type].url }),
            });
            if (res.ok) {
                toast.success('Test notification sent!');
            } else {
                const err = await res.json().catch(() => ({}));
                toast.error(err?.details || err?.error || 'Test failed.');
            }
        } catch (e: unknown) {
            toast.error((e as Error)?.message || 'Network error.');
        } finally {
            setIsTestingAgent(prev => ({ ...prev, [type]: false }));
        }
    };

    const renderAgentTab = (type: 'discord' | 'slack' | 'webhook', title: string) => (
        <SettingsSection title={title} kicker={agents[type].enabled ? 'enabled' : 'off'}>
            <SettingsField
                label="Enabled"
                helper={`Send Sencho events to this ${title.toLowerCase()} channel.`}
            >
                <TogglePill
                    id={`${type}-enabled`}
                    checked={agents[type].enabled}
                    onChange={(c) => handleAgentChange(type, 'enabled', c)}
                />
            </SettingsField>
            <SettingsField
                label="Webhook URL"
                helper="Sencho posts JSON payloads here. Use a private channel."
                htmlFor={`${type}-url`}
            >
                <Input
                    id={`${type}-url`}
                    placeholder="https://..."
                    value={agents[type].url}
                    onChange={(e) => handleAgentChange(type, 'url', e.target.value)}
                />
            </SettingsField>
            <SettingsActions>
                <Button variant="outline" onClick={() => testAgent(type)} disabled={isTestingAgent[type]}>
                    {isTestingAgent[type] ? (
                        <>
                            <RefreshCw className="w-4 h-4 animate-spin" />
                            Testing
                        </>
                    ) : (
                        'Test'
                    )}
                </Button>
                <SettingsPrimaryButton onClick={() => saveAgent(type)} disabled={isSavingAgent[type]}>
                    {isSavingAgent[type] ? (
                        <>
                            <RefreshCw className="w-4 h-4 animate-spin" />
                            Saving
                        </>
                    ) : (
                        'Save'
                    )}
                </SettingsPrimaryButton>
            </SettingsActions>
        </SettingsSection>
    );

    return (
        <div className="flex flex-col gap-6">
            <Tabs value={notifTab} onValueChange={(v) => setNotifTab(v as 'discord' | 'slack' | 'webhook')} className="w-full">
                <TabsList className="w-full mb-4 grid grid-cols-3">
                    <TabsHighlight className="rounded-md bg-brand/20" transition={springs.snappy}>
                        <TabsHighlightItem value="discord">
                            <TabsTrigger value="discord">Discord</TabsTrigger>
                        </TabsHighlightItem>
                        <TabsHighlightItem value="slack">
                            <TabsTrigger value="slack">Slack</TabsTrigger>
                        </TabsHighlightItem>
                        <TabsHighlightItem value="webhook">
                            <TabsTrigger value="webhook">Webhook</TabsTrigger>
                        </TabsHighlightItem>
                    </TabsHighlight>
                </TabsList>
                <TabsContent value="discord">{renderAgentTab('discord', 'Discord')}</TabsContent>
                <TabsContent value="slack">{renderAgentTab('slack', 'Slack')}</TabsContent>
                <TabsContent value="webhook">{renderAgentTab('webhook', 'Custom Webhook')}</TabsContent>
            </Tabs>
        </div>
    );
}
