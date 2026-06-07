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

export interface StackSidebarProps {
  isDarkMode: boolean;
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
}

export function StackSidebar(props: StackSidebarProps) {
  const {
    isDarkMode, nodeSwitcherSlot, createStackSlot, onScan, isScanning, canCreate,
    searchQuery, onSearchChange, filterChip, filterCounts, onFilterChipChange,
    list, activitySummary, onActivityAction,
    bulkMode, selectedFiles, onToggleBulkMode, onToggleSelect, onClearSelection, onBulkAction,
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
    <div className="w-64 max-md:w-full max-md:flex-1 max-md:min-h-0 max-md:border-r-0 border-r border-glass-border bg-sidebar backdrop-blur-md flex flex-col">
      {/* The TopBar provides the global chrome on mobile, so the in-sidebar
          brand row is redundant there and hidden to save vertical space. */}
      <div className="max-md:hidden">
        <SidebarBrand isDarkMode={isDarkMode} />
      </div>
      <div className="px-4 pt-2 pb-0">{nodeSwitcherSlot}</div>
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
        />
        {selectedFiles.size > 0 && (
          <SidebarBulkBar
            selectedCount={selectedFiles.size}
            onAction={onBulkAction}
            onClear={onClearSelection}
          />
        )}
        <ScrollArea className="flex-1 px-2 pb-2">
          <div data-stacks-loaded={list.isLoading ? 'false' : 'true'}>
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
