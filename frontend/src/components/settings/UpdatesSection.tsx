import { useState, useEffect, useCallback } from 'react';
import { Skeleton } from '@/components/ui/skeleton';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';
import { apiFetch } from '@/lib/api';
import { toast } from '@/components/ui/toast-store';
import { useNodes } from '@/context/NodeContext';
import { useAuth } from '@/context/AuthContext';
import { formatTimeAgo, formatTimeUntil } from '@/lib/relativeTime';
import { SettingsSection } from './SettingsSection';
import { SettingsField } from './SettingsField';
import { useMastheadStats } from './MastheadStatsContext';
import type { ImageUpdateStatus } from '@/types/imageUpdates';

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
    const { isAdmin } = useAuth();
    const readOnly = !isAdmin;
    const [status, setStatus] = useState<ImageUpdateStatus | null>(null);
    const [isLoading, setIsLoading] = useState(false);
    const [isSaving, setIsSaving] = useState(false);

    const intervalMinutes = status?.intervalMinutes ?? null;

    useMastheadStats(
        isLoading || intervalMinutes == null
            ? null
            : [{ label: 'INTERVAL', value: formatIntervalLabel(intervalMinutes), tone: 'value' }],
    );

    useEffect(() => {
        let cancelled = false;
        const fetchStatus = async () => {
            setIsLoading(true);
            try {
                const res = await apiFetch('/image-updates/status');
                if (!res.ok) throw new Error('Failed to load image-update status');
                const data = await res.json() as ImageUpdateStatus;
                if (!cancelled) setStatus(data);
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

    const handleIntervalChange = useCallback(async (value: string) => {
        const minutes = Number(value);
        if (!Number.isInteger(minutes)) return;
        setIsSaving(true);
        try {
            const res = await apiFetch('/image-updates/interval', {
                method: 'PUT',
                body: JSON.stringify({ minutes }),
            });
            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                throw new Error(err?.error || 'Failed to update interval');
            }
            const data = await res.json() as ImageUpdateStatus;
            setStatus(data);
            toast.success(`Sencho now checks for image updates every ${formatIntervalLabel(data.intervalMinutes)}.`);
        } catch (e) {
            toast.error((e as Error)?.message || 'Failed to update interval.');
        } finally {
            setIsSaving(false);
        }
    }, []);

    if (isLoading && !status) return <SectionSkeleton />;

    // A value set via the API (any integer 15-1440) may not be a preset; surface
    // it as a Custom option rather than leaving the picker blank.
    const options = intervalMinutes != null && !INTERVAL_PRESETS.some(p => p.minutes === intervalMinutes)
        ? [{ minutes: intervalMinutes, label: `Custom: ${intervalMinutes} minutes` }, ...INTERVAL_PRESETS]
        : INTERVAL_PRESETS;

    const lastChecked = status?.lastCheckedAt != null ? formatTimeAgo(status.lastCheckedAt) : 'never';
    const nextCheck = status?.checking
        ? 'checking now'
        : status?.nextCheckAt != null
            ? `in ${formatTimeUntil(status.nextCheckAt)}`
            : 'not scheduled';

    return (
        <fieldset disabled={readOnly} className="m-0 flex min-w-0 flex-col gap-10 border-0 p-0">
            <SettingsSection title="Registry checks" kicker="node-scoped">
                <SettingsField
                    label="Check registries for image updates every"
                    helper="Sencho checks registries on this interval to detect available image updates and raise notifications. Scheduled auto-update tasks apply updates on their own schedule; this only controls how often Sencho looks. Each node checks on its own interval."
                >
                    <div className="flex flex-col gap-2">
                        <Select
                            value={intervalMinutes != null ? String(intervalMinutes) : undefined}
                            onValueChange={handleIntervalChange}
                            disabled={readOnly || isSaving || intervalMinutes == null}
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
                        <p className="font-mono text-[11px] text-stat-subtitle/90">
                            Last checked {lastChecked} · Next check {nextCheck}
                        </p>
                    </div>
                </SettingsField>
            </SettingsSection>
        </fieldset>
    );
}

function formatIntervalLabel(minutes: number): string {
    if (minutes % 1440 === 0) return `${minutes / 1440}d`;
    if (minutes % 60 === 0) return `${minutes / 60}h`;
    return `${minutes}m`;
}
