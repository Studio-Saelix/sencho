import { useEffect, useMemo, useRef, useState } from 'react';
import {
    Search, ArrowUpDown, AlertTriangle, Play, Square,
    LayoutGrid, Network, SlidersHorizontal, Plus, RefreshCcwDot,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Combobox } from '@/components/ui/combobox';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { MultiSelectCombobox } from '@/components/ui/multi-select-combobox';
import { SegmentedControl, type SegmentedControlOption } from '@/components/ui/segmented-control';
import { LabelDot } from '../LabelPill';
import type { LabelColor } from '../label-types';
import type { ViewMode, SortField, FilterStatus, FilterType, FilterNetworking, FleetPreferences, FleetPaletteEntry } from './types';

const FILTER_SECTION_LABEL_CLASS = 'text-[10px] leading-3 font-mono uppercase tracking-[0.18em] text-stat-subtitle';

const SORT_OPTIONS = [
    { value: 'name', label: 'Name' },
    { value: 'cpu', label: 'CPU Usage' },
    { value: 'memory', label: 'Memory Usage' },
    { value: 'containers', label: 'Containers' },
    { value: 'status', label: 'Status' },
];

const VIEW_MODE_OPTIONS: SegmentedControlOption<ViewMode>[] = [
    { value: 'grid', label: 'Grid', icon: LayoutGrid },
    { value: 'topology', label: 'Topology', icon: Network },
];

function renderPaletteOption(option: { label: string; color?: string }) {
    return (
        <span className="flex items-center gap-1.5">
            <LabelDot color={(option.color as LabelColor) ?? 'slate'} />
            {option.label}
        </span>
    );
}

interface OverviewToolbarProps {
    viewMode: ViewMode;
    onViewModeChange: (mode: ViewMode) => void;
    searchQuery: string;
    onSearchQueryChange: (q: string) => void;
    prefs: FleetPreferences;
    onPrefsChange: (update: Partial<FleetPreferences>) => void;
    fleetPalette: FleetPaletteEntry[];
    labelFilters: Set<string>;
    onLabelFiltersChange: (filters: Set<string>) => void;
    onClearFilters: () => void;
    onAddNode?: () => void;
    onCheckUpdates?: () => void;
    checkingUpdates?: boolean;
}

export function OverviewToolbar({
    viewMode,
    onViewModeChange,
    searchQuery,
    onSearchQueryChange,
    prefs,
    onPrefsChange,
    fleetPalette,
    labelFilters,
    onLabelFiltersChange,
    onClearFilters,
    onAddNode,
    onCheckUpdates,
    checkingUpdates,
}: OverviewToolbarProps) {
    const showGridControls = viewMode === 'grid';
    const activeFilterCount =
        (prefs.filterStatus !== 'all' ? 1 : 0) +
        (prefs.filterType !== 'all' ? 1 : 0) +
        (prefs.filterCritical ? 1 : 0) +
        (prefs.filterNetworking !== 'all' ? 1 : 0) +
        (labelFilters.size > 0 ? 1 : 0);

    const paletteOptions = useMemo(
        () => fleetPalette.map(p => ({ value: p.key, label: p.name, color: p.color })),
        [fleetPalette],
    );

    // Collapsed by default to a single icon button; expands to the full input on
    // click and collapses again on blur once the query is cleared. An active
    // query keeps it open so the filter stays visible and editable.
    const [searchExpanded, setSearchExpanded] = useState(false);
    const searchInputRef = useRef<HTMLInputElement>(null);
    const searchOpen = searchExpanded || searchQuery !== '';

    useEffect(() => {
        if (searchExpanded) searchInputRef.current?.focus();
    }, [searchExpanded]);

    return (
        <div className="flex flex-wrap items-center gap-2 mb-4">
            {showGridControls && (
                <>
                    {searchOpen ? (
                        <div className="relative flex-1 min-w-[200px] max-w-sm">
                            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
                            <Input
                                ref={searchInputRef}
                                placeholder="Search nodes or stacks..."
                                value={searchQuery}
                                onChange={(e) => onSearchQueryChange(e.target.value)}
                                onBlur={() => { if (searchQuery === '') setSearchExpanded(false); }}
                                className="pl-9 h-9"
                            />
                        </div>
                    ) : (
                        <Button
                            variant="outline"
                            size="sm"
                            className="h-9 w-9 p-0 shrink-0"
                            onClick={() => setSearchExpanded(true)}
                            title="Search nodes or stacks"
                            aria-label="Search nodes or stacks"
                        >
                            <Search className="w-4 h-4" />
                        </Button>
                    )}
                    <div className="w-40">
                        <Combobox
                            options={SORT_OPTIONS}
                            value={prefs.sortBy}
                            onValueChange={(v) => onPrefsChange({ sortBy: v as SortField })}
                            placeholder="Sort by..."
                            className="[&>button]:!bg-background"
                        />
                    </div>
                    <Button
                        variant="outline"
                        size="sm"
                        className="h-9 w-9 p-0 shrink-0"
                        onClick={() => onPrefsChange({ sortDir: prefs.sortDir === 'asc' ? 'desc' : 'asc' })}
                        title={prefs.sortDir === 'asc' ? 'Switch to descending' : 'Switch to ascending'}
                    >
                        <ArrowUpDown className={`w-4 h-4 ${prefs.sortDir === 'desc' ? 'rotate-180' : ''} transition-transform`} />
                    </Button>
                    <Popover>
                        <PopoverTrigger asChild>
                            <Button
                                variant={activeFilterCount > 0 ? 'default' : 'outline'}
                                size="sm"
                                className="h-9 gap-2 shrink-0"
                            >
                                <SlidersHorizontal className="w-4 h-4" />
                                Filters
                                {activeFilterCount > 0 && (
                                    <Badge variant="secondary" className="h-5 min-w-[1.25rem] px-1.5 text-[10px] tabular-nums">
                                        {activeFilterCount}
                                    </Badge>
                                )}
                            </Button>
                        </PopoverTrigger>
                        <PopoverContent align="end" className="w-80 space-y-4">
                            <div className="space-y-1.5">
                                <label className={FILTER_SECTION_LABEL_CLASS}>Status</label>
                                <div className="flex items-center gap-1.5">
                                    {(['all', 'online', 'offline'] as FilterStatus[]).map(status => (
                                        <Button
                                            key={status}
                                            variant={prefs.filterStatus === status ? 'default' : 'outline'}
                                            size="sm"
                                            className="h-7 text-xs px-2.5"
                                            onClick={() => onPrefsChange({ filterStatus: status })}
                                        >
                                            {status === 'all' ? 'All' : status === 'online' ? (
                                                <><Play className="w-3 h-3 mr-1" />Online</>
                                            ) : (
                                                <><Square className="w-3 h-3 mr-1" />Offline</>
                                            )}
                                        </Button>
                                    ))}
                                </div>
                            </div>
                            <div className="space-y-1.5">
                                <label className={FILTER_SECTION_LABEL_CLASS}>Type</label>
                                <div className="flex items-center gap-1.5">
                                    {(['all', 'local', 'remote'] as FilterType[]).map(type => (
                                        <Button
                                            key={type}
                                            variant={prefs.filterType === type ? 'default' : 'outline'}
                                            size="sm"
                                            className="h-7 text-xs px-2.5"
                                            onClick={() => onPrefsChange({ filterType: type })}
                                        >
                                            {type === 'all' ? 'All' : type.charAt(0).toUpperCase() + type.slice(1)}
                                        </Button>
                                    ))}
                                </div>
                            </div>
                            <div className="space-y-1.5">
                                <label className={FILTER_SECTION_LABEL_CLASS}>Severity</label>
                                <Button
                                    variant={prefs.filterCritical ? 'default' : 'outline'}
                                    size="sm"
                                    className="h-7 text-xs px-2.5"
                                    onClick={() => onPrefsChange({ filterCritical: !prefs.filterCritical })}
                                >
                                    <AlertTriangle className="w-3 h-3 mr-1" />
                                    Critical Only
                                </Button>
                            </div>
                            <div className="space-y-1.5">
                                <label className={FILTER_SECTION_LABEL_CLASS}>Networking</label>
                                <div className="flex flex-wrap items-center gap-1.5">
                                    {([['all', 'All'], ['exposed', 'Exposed'], ['unknown', 'Unknown'], ['drift', 'Drift']] as [FilterNetworking, string][]).map(([value, label]) => (
                                        <Button
                                            key={value}
                                            variant={prefs.filterNetworking === value ? 'default' : 'outline'}
                                            size="sm"
                                            className="h-7 text-xs px-2.5"
                                            onClick={() => onPrefsChange({ filterNetworking: value })}
                                        >
                                            {label}
                                        </Button>
                                    ))}
                                </div>
                            </div>
                            {fleetPalette.length > 0 && (
                                <div className="space-y-1.5">
                                    <label className={FILTER_SECTION_LABEL_CLASS}>Tags</label>
                                    <MultiSelectCombobox
                                        options={paletteOptions}
                                        selected={labelFilters}
                                        onSelectionChange={onLabelFiltersChange}
                                        placeholder="Tags"
                                        renderOption={renderPaletteOption}
                                    />
                                </div>
                            )}
                            {activeFilterCount > 0 && (
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    className="w-full h-8 text-xs"
                                    onClick={onClearFilters}
                                >
                                    Clear all filters
                                </Button>
                            )}
                        </PopoverContent>
                    </Popover>
                </>
            )}

            <SegmentedControl
                value={viewMode}
                onChange={onViewModeChange}
                ariaLabel="View mode"
                options={VIEW_MODE_OPTIONS}
                className="ml-auto shrink-0 shadow-card-bevel"
            />

            {onCheckUpdates && (
                <Button
                    variant="outline"
                    size="sm"
                    className="h-9 w-9 p-0 shrink-0"
                    onClick={onCheckUpdates}
                    disabled={checkingUpdates}
                    title="Check for updates"
                    aria-label="Check for updates"
                >
                    <RefreshCcwDot className={`w-4 h-4 ${checkingUpdates ? 'animate-spin' : ''}`} />
                </Button>
            )}

            {onAddNode && (
                <Button
                    size="sm"
                    className="h-9 w-9 p-0 shrink-0"
                    onClick={onAddNode}
                    title="Add node"
                    aria-label="Add node"
                >
                    <Plus className="w-4 h-4" strokeWidth={1.5} />
                </Button>
            )}
        </div>
    );
}
