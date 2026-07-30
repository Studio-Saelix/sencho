import { useState, useEffect, useCallback, useRef } from 'react';
import { Skeleton } from '@/components/ui/skeleton';
import { Input } from '@/components/ui/input';
import { TogglePill } from '@/components/ui/toggle-pill';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { SettingsPrimaryButton } from './SettingsActions';
import { apiFetch } from '@/lib/api';
import { toast } from '@/components/ui/toast-store';
import { SENCHO_SETTINGS_CHANGED } from '@/lib/events';
import { useNodes } from '@/context/NodeContext';
import { useAuth } from '@/context/AuthContext';
import { formatTimeAgo, formatTimeUntil } from '@/lib/relativeTime';
import { getCronDescription, getCronFieldError } from '@/lib/scheduling';
import { SettingsSection } from './SettingsSection';
import { SettingsField } from './SettingsField';
import { useMastheadStats } from './MastheadStatsContext';
import type { ImageUpdateStatus } from '@/types/imageUpdates';

type ImageCheckMode = 'interval' | 'cron';

const INTERVAL_PRESETS: { minutes: number; label: string }[] = [
    { minutes: 15, label: '15 minutes' },
    { minutes: 30, label: '30 minutes' },
    { minutes: 60, label: '1 hour' },
    { minutes: 120, label: '2 hours' },
    { minutes: 360, label: '6 hours' },
    { minutes: 720, label: '12 hours' },
    { minutes: 1440, label: '24 hours' },
];

function SectionSkeleton() {
    return (
        <div className="space-y-3 rounded-lg border border-glass-border bg-glass p-4">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
        </div>
    );
}

export function UpdatesSection() {
    const { activeNode } = useNodes();
    const { can, permissionsReady } = useAuth();
    const readOnly = !permissionsReady || !can('system:settings');
    const [status, setStatus] = useState<ImageUpdateStatus | null>(null);
    const [isLoading, setIsLoading] = useState(false);
    const [isSaving, setIsSaving] = useState(false);

    // uiMode drives which control is visible. It is initialized from status.mode
    // on first fetch and synced back only after successful PUTs, so the user can
    // switch to Cron locally without persisting, and stay on Cron after a 400.
    const [uiMode, setUiMode] = useState<ImageCheckMode>('interval');
    // Draft cron text for the input; the saved expression lives in status.cronExpression.
    const [draftCron, setDraftCron] = useState('');
    // Inline error from a failed cron save (backend 400 message).
    const [saveError, setSaveError] = useState<string | null>(null);

    const intervalMinutes = status?.intervalMinutes ?? null;

    // Mirror activeNode.id in a ref so the PATCH handler can detect a node
    // switch mid-flight and discard a stale write.
    const activeNodeIdRef = useRef(activeNode?.id ?? null);
    activeNodeIdRef.current = activeNode?.id ?? null;

    const checksEnabled = status?.enabled ?? true;
    const nodeSupportsEnabledSetting = status !== null && status.enabled !== undefined;
    const cadenceLocked = !checksEnabled || readOnly || isSaving;

    // Derive toggle state from the current status. When the field is missing
    // (older remote node) the toggle is disabled with a helpful message.
    const sidebarIndicators = status?.sidebarIndicators ?? false;
    const nodeSupportsSidebarSetting = status !== null && status.sidebarIndicators !== undefined;

    const handleChecksEnabledChange = useCallback(async (next: boolean) => {
        const targetNodeId = activeNodeIdRef.current;
        setIsSaving(true);
        try {
            const res = await apiFetch('/image-updates/enabled', {
                method: 'PUT',
                nodeId: targetNodeId ?? null,
                body: JSON.stringify({ enabled: next }),
            });
            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                throw new Error(err?.error || 'Failed to update setting');
            }
            const data = await res.json() as ImageUpdateStatus;
            if (activeNodeIdRef.current === targetNodeId) {
                setStatus(data);
                setUiMode(data.mode);
                window.dispatchEvent(new CustomEvent(SENCHO_SETTINGS_CHANGED, {
                    detail: { changedKeys: ['image_update_checks_enabled'] },
                }));
            }
        } catch (e) {
            if (activeNodeIdRef.current === targetNodeId) {
                toast.error((e as Error)?.message || 'Failed to update image update checks setting.');
            }
        } finally {
            setIsSaving(false);
        }
    }, []);

    const handleSidebarIndicatorsChange = useCallback(async (next: boolean) => {
        const targetNodeId = activeNodeIdRef.current;
        setIsSaving(true);
        try {
            const res = await apiFetch('/settings', {
                method: 'PATCH',
                nodeId: targetNodeId ?? null,
                body: JSON.stringify({ image_update_sidebar_indicators: next ? '1' : '0' }),
            });
            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                throw new Error(err?.error || 'Failed to update setting');
            }
            // Guard: if the active node changed while the PATCH was in flight,
            // discard the response; it belongs to a different node.
            if (activeNodeIdRef.current === targetNodeId) {
                setStatus(prev => prev ? { ...prev, sidebarIndicators: next } : prev);
                window.dispatchEvent(new CustomEvent(SENCHO_SETTINGS_CHANGED, {
                    detail: { changedKeys: ['image_update_sidebar_indicators'] },
                }));
            }
        } catch (e) {
            // Only surface the error if the active node hasn't changed. A
            // stale failure from node A must not toast while the user views
            // node B.
            if (activeNodeIdRef.current === targetNodeId) {
                toast.error((e as Error)?.message || 'Failed to update sidebar indicator setting.');
            }
        } finally {
            setIsSaving(false);
        }
    }, []);

    useMastheadStats(
        isLoading || intervalMinutes == null
            ? null
            : [{
                label: checksEnabled ? 'INTERVAL' : 'CHECKS',
                value: checksEnabled ? formatIntervalLabel(intervalMinutes) : 'Off',
                tone: 'value',
            }],
    );

    useEffect(() => {
        let cancelled = false;
        const fetchStatus = async () => {
            setStatus(null);
            setIsLoading(true);
            try {
                const res = await apiFetch('/image-updates/status');
                if (!res.ok) throw new Error('Failed to load image-update status');
                const data = await res.json() as ImageUpdateStatus;
                if (!cancelled) {
                    setStatus(data);
                    setUiMode(data.mode);
                    if (data.mode === 'cron' && data.cronExpression) {
                        setDraftCron(data.cronExpression);
                    }
                }
            } catch (e) {
                console.error('Failed to fetch image-update status', e);
                if (!cancelled) toast.error((e as Error)?.message || 'Failed to load image-update status.');
            } finally {
                if (!cancelled) setIsLoading(false);
            }
        };
        fetchStatus();
        return () => { cancelled = true; };
    }, [activeNode?.id]);

    // ── Interval change (immediate save) ──────────────────────────────────

    const handleIntervalChange = useCallback(async (value: string) => {
        const minutes = Number(value);
        if (!Number.isInteger(minutes)) return;
        setIsSaving(true);
        try {
            const body: Record<string, unknown> = { minutes };
            // When in interval mode, always send mode: 'interval' to clear any
            // stale cron config on the server.
            body.mode = 'interval';
            const res = await apiFetch('/image-updates/interval', {
                method: 'PUT',
                body: JSON.stringify(body),
            });
            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                throw new Error(err?.error || 'Failed to update interval');
            }
            const data = await res.json() as ImageUpdateStatus;
            setStatus(data);
            setUiMode('interval');
            setSaveError(null);
            toast.success(`Sencho now checks for image updates every ${formatIntervalLabel(data.intervalMinutes)}.`);
        } catch (e) {
            toast.error((e as Error)?.message || 'Failed to update interval.');
        } finally {
            setIsSaving(false);
        }
    }, []);

    // ── Mode toggle ───────────────────────────────────────────────────────

    const handleModeChange = useCallback((next: ImageCheckMode) => {
        setSaveError(null);
        if (next === 'interval') {
            // Switching to Interval: immediately persist.
            setIsSaving(true);
            const minutes = intervalMinutes ?? 120;
            apiFetch('/image-updates/interval', {
                method: 'PUT',
                body: JSON.stringify({ minutes, mode: 'interval' }),
            })
                .then(async res => {
                    if (!res.ok) throw new Error('Failed to switch to interval mode');
                    const data = await res.json() as ImageUpdateStatus;
                    setStatus(data);
                    setUiMode('interval');
                })
                .catch(e => {
                    toast.error((e as Error)?.message || 'Failed to switch to interval mode.');
                    // Keep uiMode on 'cron' on failure; do not optimistically switch.
                })
                .finally(() => setIsSaving(false));
        } else {
            // Switching to Cron: local UI only. Draft input appears.
            setUiMode('cron');
            if (!draftCron && status?.cronExpression) {
                setDraftCron(status.cronExpression);
            }
        }
    }, [intervalMinutes, status?.cronExpression, draftCron]);

    // ── Cron save ─────────────────────────────────────────────────────────

    const cronTrimmed = draftCron.trim();
    const cronFieldError = getCronFieldError(draftCron);
    const cronDescription = cronTrimmed.length > 0 ? getCronDescription(draftCron) : '';
    const hasDescriptionError = cronTrimmed.length > 0 && cronDescription === 'Invalid expression';
    const canSaveCron = cronTrimmed.length > 0 && !cronFieldError && !hasDescriptionError && !isSaving && checksEnabled;

    const handleSaveCron = useCallback(async () => {
        if (!canSaveCron || intervalMinutes == null) return;
        setIsSaving(true);
        setSaveError(null);
        try {
            const res = await apiFetch('/image-updates/interval', {
                method: 'PUT',
                body: JSON.stringify({
                    minutes: intervalMinutes,
                    mode: 'cron',
                    cron: cronTrimmed,
                }),
            });
            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                const msg = err?.error || 'Failed to save cron schedule';
                setSaveError(msg);
                // Keep uiMode='cron', keep draft. status.mode stays unchanged.
                return;
            }
            const data = await res.json() as ImageUpdateStatus;
            setStatus(data);
            setUiMode('cron');
            setDraftCron(data.cronExpression ?? '');
            toast.success('Image update checks now run on a cron schedule.');
        } catch (e) {
            setSaveError((e as Error)?.message || 'Failed to save cron schedule.');
        } finally {
            setIsSaving(false);
        }
    }, [canSaveCron, intervalMinutes, cronTrimmed]);

    if (isLoading && !status) return <SectionSkeleton />;

    // A value set via the API (any integer 15-1440) may not be a preset; surface
    // it as a Custom option rather than leaving the picker blank.
    const options = intervalMinutes != null && !INTERVAL_PRESETS.some(p => p.minutes === intervalMinutes)
        ? [{ minutes: intervalMinutes, label: `Custom: ${intervalMinutes} minutes` }, ...INTERVAL_PRESETS]
        : INTERVAL_PRESETS;

    const lastChecked = status?.lastCheckedAt != null ? formatTimeAgo(status.lastCheckedAt) : 'never';
    const nextCheck = status?.enabled === false
        ? 'disabled'
        : status?.checking
            ? 'checking now'
            : status?.nextCheckAt != null
                ? `in ${formatTimeUntil(status.nextCheckAt)}`
                : 'not scheduled';

    const enableHelper = status !== null && status.enabled === undefined
        ? 'This node is running an older version of Sencho that does not support this setting. Upgrade the node to enable it.'
        : checksEnabled
            ? 'When on, Sencho polls registries on a schedule, raises update notifications, and feeds Home, sidebar, Anatomy, and Fleet Readiness. Turn off when another tool is the update authority for this node.'
            : 'Image update detection is off for this node. Scheduled registry checks and update notifications are stopped. Explicit stack Update, pull, and redeploy actions remain available.';

    return (
        <fieldset disabled={readOnly} className="m-0 flex min-w-0 flex-col gap-10 border-0 p-0">
            <SettingsSection title="Registry checks" kicker="node-scoped">
                <SettingsField
                    label="Enable image update checks"
                    helper={enableHelper}
                    htmlFor="image-checks-enabled-toggle"
                >
                    <TogglePill
                        id="image-checks-enabled-toggle"
                        checked={checksEnabled && nodeSupportsEnabledSetting}
                        onChange={handleChecksEnabledChange}
                        disabled={status === null || !nodeSupportsEnabledSetting || readOnly || isSaving}
                    />
                </SettingsField>

                <SettingsField
                    label="Check registries for image updates every"
                    helper="Sencho checks registries to detect available image updates and raise notifications. Choose a fixed interval, or set a cron expression for precise scheduling. Cron expressions run in the node's local timezone. Each node checks on its own schedule."
                >
                    <div className="flex flex-col gap-3">
                        <SegmentedControl<ImageCheckMode>
                            value={uiMode}
                            onChange={handleModeChange}
                            ariaLabel="Image check scheduling mode"
                            className="self-start"
                            disabled={cadenceLocked || intervalMinutes == null}
                            options={[
                                { value: 'interval', label: 'Interval' },
                                { value: 'cron', label: 'Cron' },
                            ]}
                        />

                        {uiMode === 'interval' ? (
                            <Select
                                value={intervalMinutes != null ? String(intervalMinutes) : undefined}
                                onValueChange={handleIntervalChange}
                                disabled={cadenceLocked || intervalMinutes == null}
                            >
                                <SelectTrigger className="w-44" aria-label="Image update check interval">
                                    <SelectValue placeholder="Select interval" />
                                </SelectTrigger>
                                <SelectContent>
                                    {options.map(opt => (
                                        <SelectItem key={opt.minutes} value={String(opt.minutes)}>
                                            {opt.label}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        ) : (
                            <div className="flex flex-col gap-2">
                                <div className="flex items-center gap-2">
                                    <Input
                                        className="font-mono w-44"
                                        placeholder="0 3 * * 1"
                                        value={draftCron}
                                        onChange={e => { setDraftCron(e.target.value); setSaveError(null); }}
                                        disabled={cadenceLocked}
                                    />
                                    <SettingsPrimaryButton
                                        disabled={!canSaveCron}
                                        onClick={handleSaveCron}
                                    >
                                        Save schedule
                                    </SettingsPrimaryButton>
                                </div>
                                {saveError
                                    ? <p className="text-xs text-destructive">{saveError}</p>
                                    : cronFieldError
                                        ? <p className="text-xs text-destructive">{cronFieldError}</p>
                                        : cronDescription
                                            ? <p className="text-xs text-stat-subtitle">{cronDescription}</p>
                                            : null}
                            </div>
                        )}

                        <p className="font-mono text-[11px] text-stat-subtitle/90">
                            Last checked {lastChecked} · Next check {nextCheck}
                        </p>
                    </div>
                </SettingsField>
            </SettingsSection>

            {checksEnabled && (
                <SettingsSection title="Sidebar" kicker="node-scoped">
                    <SettingsField
                        label="Show update status in sidebar"
                        helper={
                            status !== null && status.sidebarIndicators === undefined
                                ? "This node is running an older version of Sencho that does not support this setting. Upgrade the node to enable it."
                                : "Show a pulsing dot when a stack has an available update and a warning icon when the check fails. The Stack Health table on the home page always shows update status regardless of this setting. Notifications are unaffected."
                        }
                        htmlFor="sidebar-indicators-toggle"
                    >
                        <TogglePill
                            id="sidebar-indicators-toggle"
                            checked={sidebarIndicators}
                            onChange={handleSidebarIndicatorsChange}
                            disabled={status === null || !nodeSupportsSidebarSetting || readOnly || isSaving}
                        />
                    </SettingsField>
                </SettingsSection>
            )}
        </fieldset>
    );
}

function formatIntervalLabel(minutes: number): string {
    if (minutes % 1440 === 0) return `${minutes / 1440}d`;
    if (minutes % 60 === 0) return `${minutes / 60}h`;
    return `${minutes}m`;
}
