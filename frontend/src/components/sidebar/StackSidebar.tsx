import { useState, useCallback, type ReactNode } from 'react';
import { Command } from '@/components/ui/command';
import { ScrollArea } from '@/components/ui/scroll-area';
import { SidebarActions } from './SidebarActions';
import { SidebarActivityTicker, type SidebarActivityAction } from './SidebarActivityTicker';
import { SidebarBrand } from './SidebarBrand';
import { SidebarBulkBar } from './SidebarBulkBar';
import { SidebarFilterChips, type FilterCounts } from './SidebarFilterChips';
import { SidebarSearch } from './SidebarSearch';
import { StackList, type StackListProps } from './StackList';
import type { FilterChip } from './sidebar-types';
import type { BulkAction } from '@/hooks/useBulkStackActions';
import type { SidebarActivitySummary } from './useSidebarActivitySummary';
import type { BuildInfo } from '@/context/BuildInfoProvider';
import { isStacksListSettled } from './stacksLoadUi';

export interface StackSidebarProps {
  isDarkMode: boolean;
  buildInfo?: BuildInfo | null;
  nodeSwitcherSlot: ReactNode;
  createStackSlot: ReactNode | null;
  onScan: () => void;
  isScanning: boolean;
  canCreate: boolean;
  searchQuery: string;
  onSearchChange: (v: string) => void;
  filterChip: FilterChip;
  filterCounts: FilterCounts;
  onFilterChipChange: (chip: FilterChip) => void;
  list: StackListProps;
  activitySummary: SidebarActivitySummary;
  onActivityAction: (action: SidebarActivityAction) => void;
  bulkMode: boolean;
  selectedFiles: Set<string>;
  onToggleBulkMode: () => void;
  onToggleSelect: (file: string) => void;
  onClearSelection: () => void;
  onBulkAction: (action: BulkAction) => void;
  showUpdatesChip?: boolean;
  /** True when Up/Down filter counts derive from retained stale evidence. */
  filterStale?: boolean;
  /** False while status evidence is not authoritative; disables bulk buttons. */
  actionsReady?: boolean;
  /** Fill the parent pane instead of the fixed desktop width (the resizable
   *  shell pane owns the width); mobile classes are unaffected. */
  fluid?: boolean;
}

export function StackSidebar(props: StackSidebarProps) {
  const {
    isDarkMode, buildInfo, nodeSwitcherSlot, createStackSlot, onScan, isScanning, canCreate,
    searchQuery, onSearchChange, filterChip, filterCounts, onFilterChipChange,
    list, activitySummary, onActivityAction,
    bulkMode, selectedFiles, onToggleBulkMode, onToggleSelect, onClearSelection, onBulkAction,
    showUpdatesChip = true,
    filterStale = false,
    actionsReady = false,
    fluid = false,
  } = props;

  const [filtersVisible, setFiltersVisible] = useState(() => {
    try {
      const v = window.localStorage.getItem('sencho:sidebar:filters-visible');
      return v === null ? true : v !== 'false';
    } catch { return true; }
  });

  const handleToggleFilters = useCallback(() => {
    setFiltersVisible(prev => {
      const next = !prev;
      try { window.localStorage.setItem('sencho:sidebar:filters-visible', String(next)); } catch { /* localStorage unavailable */ }
      return next;
    });
  }, []);

  return (
    <div
      data-sn-chrome="sidebar"
      className={`${fluid ? 'h-full w-full max-md:h-auto' : 'w-64'} max-md:w-full max-md:flex-1 max-md:min-h-0 max-md:border-r-0 border-r border-glass-border bg-sidebar backdrop-blur-md flex flex-col`}
    >
      {/* On mobile the status masthead leads (it carries the node switcher as
          its kicker chip), so the in-sidebar brand and node rows are redundant
          there and hidden to save vertical space. */}
      <div className="max-md:hidden">
        <SidebarBrand isDarkMode={isDarkMode} buildInfo={buildInfo} />
      </div>
      <div className="max-md:hidden px-4 pt-2 pb-0">{nodeSwitcherSlot}</div>
      {canCreate && createStackSlot !== null && (
        <SidebarActions
          createStackSlot={createStackSlot}
          onScan={onScan}
          isScanning={isScanning}
          bulkMode={bulkMode}
          onToggleBulkMode={onToggleBulkMode}
        />
      )}
      <Command shouldFilter={false} className="bg-transparent flex-1 flex flex-col overflow-hidden">
        <SidebarSearch value={searchQuery} onValueChange={onSearchChange} />
        <SidebarFilterChips
          active={filterChip}
          counts={filterCounts}
          onChange={onFilterChipChange}
          visible={filtersVisible}
          onToggle={handleToggleFilters}
          showUpdatesChip={showUpdatesChip}
          stale={filterStale}
        />
        {selectedFiles.size > 0 && (
          <SidebarBulkBar
            selectedCount={selectedFiles.size}
            onAction={onBulkAction}
            onClear={onClearSelection}
            actionsReady={actionsReady}
          />
        )}
        <ScrollArea block className="flex-1 px-2 pb-2">
          <div
            data-stacks-loaded={
              isStacksListSettled(list.isLoading, list.stacksLoadStatus, list.hydrationStatus) ? 'true' : 'false'
            }
          >
            <StackList {...list} bulkMode={bulkMode} selectedFiles={selectedFiles} onToggleSelect={onToggleSelect} />
          </div>
        </ScrollArea>
      </Command>
      <SidebarActivityTicker
        summary={activitySummary}
        onAction={onActivityAction}
      />
    </div>
  );
}
