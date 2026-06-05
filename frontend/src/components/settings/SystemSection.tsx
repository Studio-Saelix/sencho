import { useState, useRef, useEffect, useMemo } from 'react';
import { Skeleton } from '@/components/ui/skeleton';
import { RefreshCw } from 'lucide-react';
import { cn } from '@/lib/utils';
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

interface SystemSectionProps {
    onDirtyChange?: (dirty: boolean) => void;
}

interface NumberChipProps {
    value: string;
    onChange: (v: string) => void;
    suffix: string;
    min?: number;
    max?: number;
    step?: number;
    warnOver?: number;
}

function NumberChip({ value, onChange, suffix, min, max, step = 1, warnOver }: NumberChipProps) {
    const [editing, setEditing] = useState(false);
    const [draft, setDraft] = useState(value);
    const inputRef = useRef<HTMLInputElement | null>(null);

    useEffect(() => {
        if (editing) inputRef.current?.select();
    }, [editing]);

    const startEdit = () => {
        setDraft(value);
        setEditing(true);
    };

    const commit = () => {
        const trimmed = draft.trim();
        const parsed = Number(trimmed);
        if (trimmed !== '' && Number.isFinite(parsed)) {
            let next = parsed;
            if (typeof min === 'number') next = Math.max(min, next);
            if (typeof max === 'number') next = Math.min(max, next);
            onChange(String(next));
        }
        setEditing(false);
    };

    const numeric = Number(value);
    const warn = typeof warnOver === 'number' && Number.isFinite(numeric) && numeric > warnOver;

    const chipClass = cn(
        'inline-flex items-baseline gap-1 rounded-md border px-2.5 py-1 font-mono text-sm tabular-nums tracking-tight transition-colors min-w-[78px] justify-end focus-within:ring-2 focus-within:ring-brand/50 focus-within:outline-none',
        warn
            ? 'border-warning/40 bg-warning/10 text-warning'
            : 'border-card-border bg-card text-stat-value hover:border-brand/50',
    );

    if (editing) {
        return (
            <span className={chipClass}>
                <input
                    ref={inputRef}
                    type="number"
                    min={min}
                    max={max}
                    step={step}
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onBlur={commit}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter') commit();
                        if (e.key === 'Escape') setEditing(false);
                    }}
                    className="w-12 bg-transparent text-right outline-none [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                />
                <span className="text-stat-subtitle">{suffix}</span>
            </span>
        );
    }

    return (
        <button
            type="button"
            className={cn(chipClass, 'focus-visible:ring-2 focus-visible:ring-brand/50 focus-visible:outline-none disabled:opacity-50 disabled:cursor-not-allowed')}
            onClick={startEdit}
        >
            <span>{value || '0'}</span>
            <span className="text-stat-subtitle">{suffix}</span>
        </button>
    );
}

interface TogglePillProps {
    checked: boolean;
    onChange: (next: boolean) => void;
}

function TogglePill({ checked, onChange }: TogglePillProps) {
    return (
        <button
            type="button"
            role="switch"
            aria-checked={checked}
            onClick={() => onChange(!checked)}
            className={cn(
                'inline-flex items-center justify-center rounded-md border px-2.5 py-1 font-mono text-xs uppercase tracking-[0.18em] transition-colors min-w-[60px] focus-visible:ring-2 focus-visible:ring-brand/50 focus-visible:outline-none disabled:opacity-50 disabled:cursor-not-allowed',
                checked
                    ? 'border-success/30 bg-success/10 text-success hover:bg-success/15'
                    : 'border-card-border bg-card text-stat-subtitle hover:text-stat-value',
            )}
        >
            {checked ? 'ON' : 'OFF'}
        </button>
    );
}

function SettingsSkeleton() {
    return (
        <div className="space-y-3 rounded-lg border border-glass-border bg-glass p-4">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
        </div>
    );
}

type SystemFields = Pick<PatchableSettings, 'host_cpu_limit' | 'host_ram_limit' | 'host_disk_limit' | 'host_alert_suppression_mins' | 'docker_janitor_gb' | 'global_crash' | 'mesh_auto_recreate' | 'reclaim_hero'>;

const DEFAULT_SYSTEM: SystemFields = {
    host_cpu_limit: DEFAULT_SETTINGS.host_cpu_limit,
    host_ram_limit: DEFAULT_SETTINGS.host_ram_limit,
    host_disk_limit: DEFAULT_SETTINGS.host_disk_limit,
    host_alert_suppression_mins: DEFAULT_SETTINGS.host_alert_suppression_mins,
    docker_janitor_gb: DEFAULT_SETTINGS.docker_janitor_gb,
    global_crash: DEFAULT_SETTINGS.global_crash,
    mesh_auto_recreate: DEFAULT_SETTINGS.mesh_auto_recreate,
    reclaim_hero: DEFAULT_SETTINGS.reclaim_hero,
};

export function SystemSection({ onDirtyChange }: SystemSectionProps) {
    const { activeNode } = useNodes();
    const { isAdmin } = useAuth();
    const readOnly = !isAdmin;
    const [settings, setSettings] = useState<SystemFields>({ ...DEFAULT_SYSTEM });
    const serverSettingsRef = useRef<SystemFields>({ ...DEFAULT_SYSTEM });
    const [isLoading, setIsLoading] = useState(false);
    const [isSaving, setIsSaving] = useState(false);

    const dirtyCount = useMemo(() => {
        const baseline = serverSettingsRef.current;
        let n = 0;
        if (settings.host_cpu_limit !== baseline.host_cpu_limit) n++;
        if (settings.host_ram_limit !== baseline.host_ram_limit) n++;
        if (settings.host_disk_limit !== baseline.host_disk_limit) n++;
        if (settings.host_alert_suppression_mins !== baseline.host_alert_suppression_mins) n++;
        if (settings.docker_janitor_gb !== baseline.docker_janitor_gb) n++;
        if (settings.global_crash !== baseline.global_crash) n++;
        if (settings.mesh_auto_recreate !== baseline.mesh_auto_recreate) n++;
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
                const safe: SystemFields = {
                    host_cpu_limit: nodeData.host_cpu_limit ?? DEFAULT_SETTINGS.host_cpu_limit,
                    host_ram_limit: nodeData.host_ram_limit ?? DEFAULT_SETTINGS.host_ram_limit,
                    host_disk_limit: nodeData.host_disk_limit ?? DEFAULT_SETTINGS.host_disk_limit,
                    host_alert_suppression_mins: nodeData.host_alert_suppression_mins ?? DEFAULT_SETTINGS.host_alert_suppression_mins,
                    docker_janitor_gb: nodeData.docker_janitor_gb ?? DEFAULT_SETTINGS.docker_janitor_gb,
                    global_crash: (nodeData.global_crash as '0' | '1') ?? DEFAULT_SETTINGS.global_crash,
                    mesh_auto_recreate: (nodeData.mesh_auto_recreate as '0' | '1') ?? DEFAULT_SETTINGS.mesh_auto_recreate,
                    reclaim_hero: (nodeData.reclaim_hero as '0' | '1') ?? DEFAULT_SETTINGS.reclaim_hero,
                };
                setSettings(safe);
                serverSettingsRef.current = { ...safe };
            } catch (e) {
                console.error('Failed to fetch system settings', e);
            } finally {
                setIsLoading(false);
            }
        };
        fetchSettings();
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activeNode?.id]);

    const onSettingChange = <K extends keyof SystemFields>(key: K, value: SystemFields[K]) => {
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
            toast.success('System limits saved.');
        } catch (e: unknown) {
            toast.error((e as Error)?.message || 'Something went wrong.');
        } finally {
            setIsSaving(false);
        }
    };

    if (isLoading) return <SettingsSkeleton />;

    return (
        <fieldset disabled={readOnly} className="m-0 flex min-w-0 flex-col gap-10 border-0 p-0">
            <SettingsSection title="Host thresholds">
                <SettingsField
                    label="CPU limit"
                    helper="Alerts fire when host CPU utilization exceeds this percentage."
                >
                    <NumberChip
                        value={settings.host_cpu_limit || '90'}
                        onChange={(v) => onSettingChange('host_cpu_limit', v)}
                        suffix="%"
                        min={1}
                        max={100}
                        warnOver={95}
                    />
                </SettingsField>
                <SettingsField
                    label="RAM limit"
                    helper="Swap is never acceptable. Set this below where the host begins paging."
                >
                    <NumberChip
                        value={settings.host_ram_limit || '90'}
                        onChange={(v) => onSettingChange('host_ram_limit', v)}
                        suffix="%"
                        min={1}
                        max={100}
                        warnOver={95}
                    />
                </SettingsField>
                <SettingsField
                    label="Disk limit"
                    helper="Low free space slows image pulls and backups."
                >
                    <NumberChip
                        value={settings.host_disk_limit || '90'}
                        onChange={(v) => onSettingChange('host_disk_limit', v)}
                        suffix="%"
                        min={1}
                        max={100}
                        warnOver={95}
                    />
                </SettingsField>
                <SettingsField
                    label="Alert suppression"
                    helper="How long to wait before resending a host alert while the metric stays over threshold. The follow-up message includes a count of suppressed cycles."
                >
                    <NumberChip
                        value={settings.host_alert_suppression_mins || '60'}
                        onChange={(v) => onSettingChange('host_alert_suppression_mins', v)}
                        suffix="min"
                        min={1}
                        max={1440}
                    />
                </SettingsField>
            </SettingsSection>

            <SettingsSection title="Docker hygiene">
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
                    label="Global crash capture"
                    helper="Watch every managed container for unexpected exits."
                >
                    <TogglePill
                        checked={settings.global_crash === '1'}
                        onChange={(next) => onSettingChange('global_crash', next ? '1' : '0')}
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

            {/*
              Mesh-data-plane recreate touches Docker (createNetwork +
              connectContainerToNetwork) on the backend, which is admin-gated
              by `requireAdmin` on the settings route. Hide the affordance
              for non-admins so the toggle does not surface a 403 on save.
              The rest of the System section stays visible because it
              matches the existing pattern (host thresholds, janitor, alert
              suppression all visible read-only to non-admins).
            */}
            {isAdmin && (
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

            <SettingsActions hint={readOnly ? 'Read-only · admin access required to edit' : (hasChanges ? `${dirtyCount} unsaved` : undefined)}>
                {!readOnly && (
                    <SettingsPrimaryButton onClick={saveSettings} disabled={isSaving || !hasChanges}>
                        {isSaving ? (
                            <>
                                <RefreshCw className="w-4 h-4 animate-spin" />
                                Saving
                            </>
                        ) : (
                            'Save limits'
                        )}
                    </SettingsPrimaryButton>
                )}
            </SettingsActions>
        </fieldset>
    );
}
