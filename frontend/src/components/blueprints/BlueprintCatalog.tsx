import { useMemo, useState } from 'react';
import { Plus, Lock, Layers, AlertCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
    type BlueprintListItem,
    type BlueprintDeploymentStatus,
    describeSelector,
} from '@/lib/blueprintsApi';

interface BlueprintCatalogProps {
    blueprints: BlueprintListItem[];
    onSelect: (id: number) => void;
    onCreate: () => void;
    canCreate: boolean;
}

type ModeFilter = 'all' | 'observe' | 'suggest' | 'enforce' | 'drifted';

const STATUS_PRIORITY: BlueprintDeploymentStatus[] = ['failed', 'name_conflict', 'evict_blocked', 'pending_state_review', 'drifted', 'correcting', 'deploying', 'pending', 'active', 'withdrawing', 'withdrawn'];

function dominantStatus(counts: Partial<Record<BlueprintDeploymentStatus, number>>): BlueprintDeploymentStatus | null {
    for (const status of STATUS_PRIORITY) {
        if ((counts[status] ?? 0) > 0) return status;
    }
    return null;
}

function statusDot(status: BlueprintDeploymentStatus | null): string {
    if (!status) return 'bg-muted-foreground';
    switch (status) {
        case 'active': return 'bg-success';
        case 'deploying':
        case 'correcting': return 'bg-brand';
        case 'failed':
        case 'name_conflict': return 'bg-destructive';
        case 'drifted':
        case 'pending':
        case 'pending_state_review':
        case 'evict_blocked':
        case 'withdrawing': return 'bg-warning';
        default: return 'bg-muted-foreground';
    }
}

export function BlueprintCatalog({ blueprints, onSelect, onCreate, canCreate }: BlueprintCatalogProps) {
    const [filter, setFilter] = useState<ModeFilter>('all');

    const counts = useMemo(() => {
        const c = { all: blueprints.length, observe: 0, suggest: 0, enforce: 0, drifted: 0 };
        for (const b of blueprints) {
            c[b.drift_mode] = (c[b.drift_mode] ?? 0) + 1;
            if ((b.deploymentCounts.drifted ?? 0) > 0) c.drifted += 1;
        }
        return c;
    }, [blueprints]);

    const filtered = useMemo(() => {
        switch (filter) {
            case 'all': return blueprints;
            case 'drifted': return blueprints.filter(b => (b.deploymentCounts.drifted ?? 0) > 0);
            default: return blueprints.filter(b => b.drift_mode === filter);
        }
    }, [blueprints, filter]);

    return (
        <div className="space-y-5">
            <div className="flex items-center justify-between flex-wrap gap-3">
                <div className="flex items-center gap-2">
                    <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-stat-icon">
                        Deployments · Blueprints
                    </span>
                </div>
                {canCreate && (
                    <Button size="sm" onClick={onCreate} className="gap-2">
                        <Plus className="h-4 w-4" strokeWidth={1.5} />
                        New Blueprint
                    </Button>
                )}
            </div>

            <div className="flex items-center gap-1 flex-wrap">
                <FilterChip active={filter === 'all'} count={counts.all} label="All" onClick={() => setFilter('all')} />
                <FilterChip active={filter === 'drifted'} count={counts.drifted} label="Drifted" onClick={() => setFilter('drifted')} tone="warning" />
                <span className="mx-2 text-stat-icon">·</span>
                <FilterChip active={filter === 'observe'} count={counts.observe} label="Observe" onClick={() => setFilter('observe')} />
                <FilterChip active={filter === 'suggest'} count={counts.suggest} label="Suggest" onClick={() => setFilter('suggest')} />
                <FilterChip active={filter === 'enforce'} count={counts.enforce} label="Enforce" onClick={() => setFilter('enforce')} />
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                {filtered.map(b => (
                    <BlueprintTile key={b.id} blueprint={b} onClick={() => onSelect(b.id)} />
                ))}
                {filtered.length === 0 && (
                    <div className="md:col-span-2 xl:col-span-3 rounded-lg border border-dashed border-border p-8 text-center">
                        <p className="text-sm text-stat-subtitle">No blueprints match this filter.</p>
                    </div>
                )}
            </div>
        </div>
    );
}

function FilterChip({ active, count, label, onClick, tone }: { active: boolean; count: number; label: string; onClick: () => void; tone?: 'warning' }) {
    const baseClass = active
        ? 'border-brand/40 bg-brand/10 text-brand'
        : 'border-card-border bg-card text-stat-subtitle hover:text-stat-value';
    const toneClass = tone === 'warning' && count > 0 && !active ? 'text-warning' : '';
    return (
        <button
            type="button"
            onClick={onClick}
            className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-1 font-mono text-[10px] uppercase tracking-[0.18em] cursor-pointer ${baseClass} ${toneClass}`}
        >
            {label}
            <span className="tabular-nums">{count}</span>
        </button>
    );
}

function BlueprintTile({ blueprint, onClick }: { blueprint: BlueprintListItem; onClick: () => void }) {
    const dom = dominantStatus(blueprint.deploymentCounts);
    const active = blueprint.deploymentCounts.active ?? 0;
    return (
        <button
            type="button"
            onClick={onClick}
            className="text-left rounded-lg border border-card-border border-t-card-border-top bg-card text-card-foreground shadow-card-bevel transition-colors hover:border-t-card-border-hover cursor-pointer p-4 space-y-2"
        >
            <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                    <span className={`inline-block w-2 h-2 rounded-full shrink-0 ${statusDot(dom)}`} aria-hidden />
                    <span className="font-serif italic text-base tracking-[-0.01em] text-stat-value truncate">
                        {blueprint.name}
                    </span>
                </div>
                <ClassificationChip classification={blueprint.classification} />
            </div>
            {blueprint.description && (
                <p className="text-xs text-stat-subtitle line-clamp-2 leading-relaxed">{blueprint.description}</p>
            )}
            <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.18em] text-stat-icon">
                <span className="tabular-nums text-stat-value">{active}/{blueprint.deploymentTotal}</span>
                <span>active</span>
                <span>·</span>
                <span className="truncate" title={describeSelector(blueprint.selector)}>{describeSelector(blueprint.selector)}</span>
            </div>
            <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.18em] text-stat-icon">
                <span>drift</span>
                <span className="text-stat-value">{blueprint.drift_mode}</span>
                {!blueprint.enabled && (
                    <>
                        <span>·</span>
                        <span className="text-warning">disabled</span>
                    </>
                )}
            </div>
        </button>
    );
}

function ClassificationChip({ classification }: { classification: 'stateless' | 'stateful' | 'unknown' }) {
    const Icon = classification === 'stateless' ? Layers : classification === 'unknown' ? AlertCircle : Lock;
    const dot = classification === 'stateless' ? 'bg-success' : classification === 'unknown' ? 'bg-muted-foreground' : 'bg-warning';
    return (
        <span className="inline-flex items-center gap-1.5 rounded border border-card-border px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.2em] text-stat-icon">
            <span className={`inline-block w-1.5 h-1.5 rounded-full ${dot}`} aria-hidden />
            <Icon className="h-3 w-3" strokeWidth={1.5} />
            {classification}
        </span>
    );
}
