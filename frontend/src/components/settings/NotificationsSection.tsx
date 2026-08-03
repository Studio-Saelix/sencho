import { useState, useEffect, useRef } from 'react';
import { Tabs, TabsContent, TabsList, TabsTrigger, TabsHighlight, TabsHighlightItem } from '@/components/ui/tabs';
import { springs } from '@/lib/motion';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { TogglePill } from '@/components/ui/toggle-pill';
import { toast } from '@/components/ui/toast-store';
import { apiFetch } from '@/lib/api';
import { useNodes } from '@/context/NodeContext';
import { useAuth } from '@/context/AuthContext';
import { RefreshCw } from 'lucide-react';
import type { Agent } from './types';
import { DEFAULT_SETTINGS } from './types';
import { SettingsSection } from './SettingsSection';
import { SettingsField } from './SettingsField';
import { SettingsActions, SettingsPrimaryButton } from './SettingsActions';
import { useMastheadStats } from './MastheadStatsContext';
import { NumberChip } from './SystemControls';
import { classifyAppriseEndpoint, isKeyedAppriseEndpoint, isStatelessAppriseEndpoint } from '@/lib/appriseEndpoint';
import { canManageNode } from '@/lib/canManageNode';
import { parseNotificationDispatchRetries } from '@/lib/notificationDispatchRetries';

type ChannelType = 'discord' | 'slack' | 'webhook' | 'apprise' | 'ntfy';

function emptyAgents(): Record<ChannelType, Agent> {
    return {
        discord: { type: 'discord', url: '', enabled: false },
        slack: { type: 'slack', url: '', enabled: false },
        webhook: { type: 'webhook', url: '', enabled: false },
        apprise: { type: 'apprise', url: '', enabled: false, config: null },
        ntfy: { type: 'ntfy', url: '', enabled: false },
    };
}

function appriseWriteConfig(agent: Agent): { urls: string } | { tags: string } {
    if (isStatelessAppriseEndpoint(agent.url)) {
        return { urls: agent.config?.urls ?? '' };
    }
    return { tags: agent.config?.tags ?? '' };
}

function hasStoredAppriseAgent(agent: Agent): boolean {
    // Stateless public URLs are not redacted; treat a public mode summary (or keyed redaction) as stored.
    return Boolean(agent.config?.mode) || agent.url.includes('<redacted>');
}

function clampRetryExtras(raw: string): string {
    const n = Math.trunc(Number(raw));
    if (!Number.isFinite(n)) return DEFAULT_SETTINGS.notification_dispatch_retries!;
    return String(Math.max(0, Math.min(3, n)));
}

interface NotificationsSectionProps {
    onDirtyChange?: (dirty: boolean) => void;
}

export function NotificationsSection({ onDirtyChange }: NotificationsSectionProps) {
    // This section configures outbound notification *channels* (/api/agents), which
    // require node:manage. Alert routing and mute rules live in separate Settings
    // sections and stay Admin-only via notifications.ts / adminOnly registry flags.
    const { activeNode } = useNodes();
    const { can } = useAuth();
    const readOnly = !canManageNode(can, activeNode?.id);
    const activeNodeIdRef = useRef(activeNode?.id);
    useEffect(() => { activeNodeIdRef.current = activeNode?.id; }, [activeNode?.id]);

    const [notifTab, setNotifTab] = useState<ChannelType>('discord');
    const [agents, setAgents] = useState<Record<string, Agent>>(emptyAgents);
    const [isSavingAgent, setIsSavingAgent] = useState<Record<string, boolean>>({});
    const [isTestingAgent, setIsTestingAgent] = useState<Record<string, boolean>>({});
    const [appriseUrlDirty, setAppriseUrlDirty] = useState(false);
    const [appriseConfigDirty, setAppriseConfigDirty] = useState(false);

    const [retries, setRetries] = useState(DEFAULT_SETTINGS.notification_dispatch_retries!);
    const [savedRetries, setSavedRetries] = useState(DEFAULT_SETTINGS.notification_dispatch_retries!);
    const [isSavingRetries, setIsSavingRetries] = useState(false);
    // idle: node-switch reset before first successful load; ready: trusted saved value; error: GET failed.
    const [retriesLoadState, setRetriesLoadState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
    const [hasLoadedRetries, setHasLoadedRetries] = useState(false);
    const [retriesNeedsRepair, setRetriesNeedsRepair] = useState(false);
    const retriesFetchGenRef = useRef(0);
    const retriesMutationGenRef = useRef(0);
    const retriesSaveGenRef = useRef(0);
    const retriesDirty = hasLoadedRetries && (retries !== savedRetries || retriesNeedsRepair);

    useEffect(() => {
        onDirtyChange?.(retriesDirty);
    }, [retriesDirty, onDirtyChange]);

    const fetchAgents = async () => {
        const requestNodeId = activeNode?.id;
        try {
            const res = await apiFetch('/agents', {
                // Bind the request to the node captured when this fetch started.
                nodeId: typeof requestNodeId === 'number' ? requestNodeId : undefined,
            });
            if (!res.ok) return;
            const data: Agent[] = await res.json();
            // Compare after body parse so a slow json() cannot commit after a node switch.
            if (activeNodeIdRef.current !== requestNodeId) return;
            const next = emptyAgents();
            data.forEach(a => {
                if (a.type in next) next[a.type as ChannelType] = a;
            });
            setAgents(next);
            setAppriseUrlDirty(false);
            setAppriseConfigDirty(false);
        } catch (e) {
            console.error('Failed to fetch agents', e);
        }
    };

    const fetchRetries = async () => {
        const requestNodeId = activeNode?.id;
        const fetchGen = ++retriesFetchGenRef.current;
        const mutationAtStart = retriesMutationGenRef.current;
        setRetriesLoadState('loading');
        const isCurrent = () => (
            activeNodeIdRef.current === requestNodeId
            && fetchGen === retriesFetchGenRef.current
            && retriesMutationGenRef.current === mutationAtStart
        );
        const restoreAfterStale = () => {
            if (activeNodeIdRef.current !== requestNodeId) return;
            // A newer fetch owns loading; do not fight it.
            if (fetchGen !== retriesFetchGenRef.current) return;
            // A newer edit/save owns the value; leave ready so edited UI stays interactive.
            if (retriesMutationGenRef.current !== mutationAtStart) {
                setRetriesLoadState('ready');
            }
        };
        try {
            const res = await apiFetch('/settings', {
                nodeId: typeof requestNodeId === 'number' ? requestNodeId : undefined,
            });
            if (!isCurrent()) {
                restoreAfterStale();
                return;
            }
            if (!res.ok) {
                setRetriesLoadState('error');
                return;
            }
            const data: Record<string, string> = await res.json();
            if (!isCurrent()) {
                restoreAfterStale();
                return;
            }
            // Missing key: same as seed/runtime default. Malformed stored values must NOT
            // clamp into a false "saved" policy (backend falls back to 0 without accepting 1.5/9).
            const raw = data.notification_dispatch_retries;
            if (raw === undefined || raw === null || raw === '') {
                const next = DEFAULT_SETTINGS.notification_dispatch_retries!;
                setRetries(next);
                setSavedRetries(next);
                setRetriesNeedsRepair(false);
                setRetriesLoadState('ready');
                setHasLoadedRetries(true);
                return;
            }
            const parsed = parseNotificationDispatchRetries(raw);
            if (parsed === null) {
                const next = DEFAULT_SETTINGS.notification_dispatch_retries!;
                setRetries(next);
                setSavedRetries(next);
                setRetriesNeedsRepair(true);
                setRetriesLoadState('error');
                setHasLoadedRetries(true);
                return;
            }
            const next = String(parsed);
            setRetries(next);
            setSavedRetries(next);
            setRetriesNeedsRepair(false);
            setRetriesLoadState('ready');
            setHasLoadedRetries(true);
        } catch (e) {
            console.error('Failed to fetch notification retry setting', e);
            if (!isCurrent()) {
                restoreAfterStale();
                return;
            }
            setRetriesLoadState('error');
        }
    };

    useEffect(() => {
        // Reset local channel/retry state when the active node changes so a prior
        // node's values cannot flash while the replacement fetches settle.
        retriesFetchGenRef.current += 1;
        retriesMutationGenRef.current += 1;
        retriesSaveGenRef.current += 1;
        // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional node-switch reset
        setAgents(emptyAgents());
        setAppriseUrlDirty(false);
        setAppriseConfigDirty(false);
        setRetries(DEFAULT_SETTINGS.notification_dispatch_retries!);
        setSavedRetries(DEFAULT_SETTINGS.notification_dispatch_retries!);
        setRetriesLoadState('idle');
        setHasLoadedRetries(false);
        setRetriesNeedsRepair(false);
        setIsSavingRetries(false);
        void fetchAgents();
        void fetchRetries();
    }, [activeNode?.id]); // eslint-disable-line react-hooks/exhaustive-deps

    const enabledCount = Object.values(agents).filter(a => a.enabled).length;
    useMastheadStats([
        {
            label: 'CHANNELS',
            value: `${enabledCount}/5`,
            tone: enabledCount > 0 ? 'value' : 'subtitle',
        },
        ...(retriesDirty
            ? [{ label: 'EDITED', value: 'retries', tone: 'warn' as const }]
            : []),
    ]);

    const saveRetries = async () => {
        const requestNodeId = activeNode?.id;
        const submitted = clampRetryExtras(retries);
        const mutationAtStart = retriesMutationGenRef.current;
        const saveGen = ++retriesSaveGenRef.current;
        setIsSavingRetries(true);
        try {
            const res = await apiFetch('/settings', {
                method: 'PATCH',
                nodeId: typeof requestNodeId === 'number' ? requestNodeId : undefined,
                body: JSON.stringify({ notification_dispatch_retries: submitted }),
            });
            if (activeNodeIdRef.current !== requestNodeId) return;
            if (retriesMutationGenRef.current !== mutationAtStart) return;
            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                toast.error(err?.error || err?.message || 'Something went wrong.');
                return;
            }
            // Invalidate in-flight GETs so a late load cannot overwrite this save.
            retriesFetchGenRef.current += 1;
            retriesMutationGenRef.current += 1;
            setRetries(submitted);
            setSavedRetries(submitted);
            setRetriesLoadState('ready');
            setHasLoadedRetries(true);
            setRetriesNeedsRepair(false);
            toast.success('Delivery retries saved.');
        } catch (e: unknown) {
            if (activeNodeIdRef.current !== requestNodeId) return;
            if (retriesMutationGenRef.current !== mutationAtStart) return;
            toast.error((e as Error)?.message || 'Network error.');
        } finally {
            // Own the spinner by save generation, not value mutation (success bumps mutation).
            if (activeNodeIdRef.current === requestNodeId && saveGen === retriesSaveGenRef.current) {
                setIsSavingRetries(false);
            }
        }
    };

    const retriesKicker =
        retriesNeedsRepair && retries === savedRetries
            ? 'error'
            : retriesDirty
                ? 'edited'
                : retriesLoadState === 'error'
                    ? 'error'
                    : retriesLoadState === 'loading' || retriesLoadState === 'idle'
                        ? 'loading'
                        : 'saved';
    const retriesControlsDisabled = readOnly || !hasLoadedRetries;

    const handleAgentChange = (type: string, field: keyof Agent, value: Agent[keyof Agent]) => {
        setAgents(prev => ({
            ...prev,
            [type]: { ...prev[type], [field]: value },
        }));
    };

    const handleAppriseConfigPatch = (patch: { urls?: string; tags?: string }) => {
        setAppriseConfigDirty(true);
        setAgents(prev => ({
            ...prev,
            apprise: { ...prev.apprise, config: { ...prev.apprise.config, ...patch } },
        }));
    };

    const saveAgent = async (type: string) => {
        setIsSavingAgent(prev => ({ ...prev, [type]: true }));
        try {
            const agent = agents[type];
            const body: Record<string, unknown> = {
                type: agent.type,
                enabled: agent.enabled,
            };

            if (type !== 'apprise') {
                body.url = agent.url;
            } else {
                const stored = hasStoredAppriseAgent(agent);
                // Omit url/config on clean saves (including enable toggles) so preserve-on-write keeps destinations.
                // URL-only edits omit config so blank destination fields do not wipe stored URLs.
                if (appriseUrlDirty || !stored) {
                    body.url = agent.url.trim();
                }
                const storedMode = agent.config?.mode ?? null;
                const nextMode = classifyAppriseEndpoint(agent.url);
                const modeChanged = Boolean(stored && storedMode && nextMode && storedMode !== nextMode);
                if (appriseConfigDirty || !stored || modeChanged) {
                    body.config = appriseWriteConfig(agent);
                }
            }

            const res = await apiFetch('/agents', {
                method: 'POST',
                body: JSON.stringify(body),
            });
            if (res.ok) {
                toast.success(`${type.charAt(0).toUpperCase() + type.slice(1)} settings saved.`);
                await fetchAgents();
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

    const appriseCanTest = (() => {
        const agent = agents.apprise;
        if (!agent.url.trim() || agent.url.includes('<redacted>')) return false;
        if (isStatelessAppriseEndpoint(agent.url)) {
            return Boolean(agent.config?.urls?.trim());
        }
        return true;
    })();

    const testAgent = async (type: string) => {
        if (type === 'apprise' && !appriseCanTest) {
            toast.error('Enter a raw Apprise endpoint (and destination URLs for /notify) before testing.');
            return;
        }
        if (!agents[type].url) {
            toast.error('Please enter a webhook URL first.');
            return;
        }
        setIsTestingAgent(prev => ({ ...prev, [type]: true }));
        try {
            const body: Record<string, unknown> = { type, url: agents[type].url };
            if (type === 'apprise') {
                body.config = appriseWriteConfig(agents.apprise);
            }
            const res = await apiFetch('/notifications/test', {
                method: 'POST',
                body: JSON.stringify(body),
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

    const renderAgentTab = (type: ChannelType, title: string) => (
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
                label={type === 'apprise' ? 'Apprise endpoint' : type === 'ntfy' ? 'ntfy server and topic URL' : 'Webhook URL'}
                helper={type === 'apprise' ? 'Use /notify/{key} for keyed delivery or /notify with destination URLs below.' : type === 'ntfy' ? 'Sencho posts a plain-text message. The URL must include the topic path.' : 'Sencho posts JSON payloads here. Use a private channel.'}
                htmlFor={`${type}-url`}
            >
                <Input
                    id={`${type}-url`}
                    placeholder={type === 'apprise' ? 'http://apprise.local/notify' : type === 'ntfy' ? 'https://ntfy.sh/mytopic' : 'https://...'}
                    value={agents[type].url}
                    onChange={(e) => {
                        if (type === 'apprise') setAppriseUrlDirty(true);
                        handleAgentChange(type, 'url', e.target.value);
                    }}
                />
            </SettingsField>
            {type === 'apprise' && isStatelessAppriseEndpoint(agents.apprise.url) && (
                <SettingsField
                    label="Destination URLs"
                    helper="Required for a /notify endpoint. Separate Apprise URLs with commas or whitespace. Leave blank when editing to keep stored destinations."
                    htmlFor="apprise-urls"
                >
                    <Input
                        id="apprise-urls"
                        placeholder={agents.apprise.config?.has_urls ? 'Configured destinations are preserved until replaced.' : 'discord://...'}
                        value={agents.apprise.config?.urls ?? ''}
                        onChange={(e) => handleAppriseConfigPatch({ urls: e.target.value })}
                    />
                </SettingsField>
            )}
            {type === 'apprise' && isKeyedAppriseEndpoint(agents.apprise.url) && (
                <SettingsField label="Tags" helper="Optional tags for a keyed /notify/{key} endpoint." htmlFor="apprise-tags">
                    <Input
                        id="apprise-tags"
                        value={agents.apprise.config?.tags ?? ''}
                        onChange={(e) => handleAppriseConfigPatch({ tags: e.target.value })}
                    />
                </SettingsField>
            )}
            {type === 'apprise' && agents.apprise.url.trim() && !isKeyedAppriseEndpoint(agents.apprise.url) && !isStatelessAppriseEndpoint(agents.apprise.url) && (
                <p className="text-xs text-stat-subtitle">
                    Enter an endpoint ending in /notify or /notify/&#123;key&#125; to configure Apprise.
                </p>
            )}
            <SettingsActions>
                <Button
                    variant="outline"
                    onClick={() => testAgent(type)}
                    disabled={isTestingAgent[type] || (type === 'apprise' && !appriseCanTest)}
                    title={type === 'apprise' && !appriseCanTest
                        ? 'Enter a raw Apprise endpoint (and destination URLs for /notify) before testing.'
                        : undefined}
                >
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
            {type === 'apprise' && !appriseCanTest && agents.apprise.url.includes('<redacted>') && (
                <p className="text-xs text-stat-subtitle">
                    Replace the redacted endpoint with the real URL to send a test. Unchanged secrets are preserved on Save.
                </p>
            )}
        </SettingsSection>
    );

    return (
        <div className="flex flex-col gap-6">
            <Tabs value={notifTab} onValueChange={(v) => setNotifTab(v as ChannelType)} className="w-full">
                <TabsList className="w-full mb-4 grid grid-cols-5">
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
                        <TabsHighlightItem value="apprise">
                            <TabsTrigger value="apprise">Apprise</TabsTrigger>
                        </TabsHighlightItem>
                        <TabsHighlightItem value="ntfy">
                            <TabsTrigger value="ntfy">ntfy</TabsTrigger>
                        </TabsHighlightItem>
                    </TabsHighlight>
                </TabsList>
                <TabsContent value="discord">{renderAgentTab('discord', 'Discord')}</TabsContent>
                <TabsContent value="slack">{renderAgentTab('slack', 'Slack')}</TabsContent>
                <TabsContent value="webhook">{renderAgentTab('webhook', 'Custom Webhook')}</TabsContent>
                <TabsContent value="apprise">{renderAgentTab('apprise', 'Apprise')}</TabsContent>
                <TabsContent value="ntfy">{renderAgentTab('ntfy', 'ntfy')}</TabsContent>
            </Tabs>
            <fieldset disabled={readOnly} className="min-w-0 border-0 p-0 m-0">
                <SettingsSection title="Delivery retries" kicker={retriesKicker}>
                    <SettingsField
                        label="Extra attempts"
                        helper={
                            retriesNeedsRepair
                                ? 'Stored delivery retries value is invalid for this node. Runtime delivery uses 0 until you save a value from 0 to 3.'
                                : retriesLoadState === 'error'
                                    ? 'Could not load delivery retries for this node. Retry after the load succeeds; default 0 is not treated as saved until then.'
                                    : 'Extra in-process attempts after a transient delivery failure (0 keeps single-shot). Fixed 1 second between attempts. Ambiguous timeouts can produce duplicate notifications.'
                        }
                    >
                        <NumberChip
                            value={retries}
                            onChange={(v) => {
                                retriesMutationGenRef.current += 1;
                                setRetries(clampRetryExtras(v));
                            }}
                            suffix="extra"
                            min={0}
                            max={3}
                            step={1}
                            disabled={retriesControlsDisabled}
                        />
                    </SettingsField>
                    <SettingsActions>
                        {(hasLoadedRetries || retriesLoadState === 'error') && (
                            <Button
                                variant="outline"
                                onClick={() => void fetchRetries()}
                                disabled={readOnly || isSavingRetries || retriesLoadState === 'loading'}
                            >
                                {retriesLoadState === 'error' ? 'Retry load' : 'Reload'}
                            </Button>
                        )}
                        <SettingsPrimaryButton
                            onClick={() => void saveRetries()}
                            disabled={retriesControlsDisabled || !retriesDirty || isSavingRetries}
                        >
                            {isSavingRetries ? (
                                <>
                                    <RefreshCw className="w-4 h-4 animate-spin" />
                                    Saving
                                </>
                            ) : (
                                'Save retries'
                            )}
                        </SettingsPrimaryButton>
                    </SettingsActions>
                </SettingsSection>
            </fieldset>
        </div>
    );
}
