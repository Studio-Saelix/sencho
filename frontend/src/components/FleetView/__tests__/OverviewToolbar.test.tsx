import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import { OverviewToolbar } from '../OverviewToolbar';
import type { FleetPaletteEntry, FleetPreferences } from '../types';

const PREFS: FleetPreferences = { sortBy: 'name', sortDir: 'asc', filterStatus: 'all', filterType: 'all', filterCritical: false, filterNetworking: 'all' };

function props(overrides: Partial<React.ComponentProps<typeof OverviewToolbar>> = {}) {
  return {
    viewMode: 'grid' as const,
    onViewModeChange: vi.fn(),
    searchQuery: '',
    onSearchQueryChange: vi.fn(),
    prefs: PREFS,
    onPrefsChange: vi.fn(),
    fleetPalette: [] as FleetPaletteEntry[],
    labelFilters: new Set<string>(),
    onLabelFiltersChange: vi.fn(),
    onClearFilters: vi.fn(),
    ...overrides,
  };
}

describe('OverviewToolbar', () => {
  it('collapses the search to an icon button by default and expands it on click', () => {
    render(<OverviewToolbar {...props()} />);
    expect(screen.queryByPlaceholderText('Search nodes or stacks...')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Search nodes or stacks' }));
    expect(screen.getByPlaceholderText('Search nodes or stacks...')).toBeInTheDocument();
  });

  it('renders the search expanded when a query is already active', () => {
    render(<OverviewToolbar {...props({ searchQuery: 'plex' })} />);
    expect(screen.getByDisplayValue('plex')).toBeInTheDocument();
  });

  it('focuses the input when the search expands', () => {
    render(<OverviewToolbar {...props()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Search nodes or stacks' }));
    expect(screen.getByPlaceholderText('Search nodes or stacks...')).toHaveFocus();
  });

  it('collapses back to the icon button on blur when the query is empty', () => {
    render(<OverviewToolbar {...props()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Search nodes or stacks' }));
    fireEvent.blur(screen.getByPlaceholderText('Search nodes or stacks...'));
    expect(screen.queryByPlaceholderText('Search nodes or stacks...')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Search nodes or stacks' })).toBeInTheDocument();
  });

  it('stays expanded on blur while a query is active', () => {
    render(<OverviewToolbar {...props({ searchQuery: 'plex' })} />);
    fireEvent.blur(screen.getByPlaceholderText('Search nodes or stacks...'));
    expect(screen.getByDisplayValue('plex')).toBeInTheDocument();
  });

  it('hides grid controls in topology mode', () => {
    render(<OverviewToolbar {...props({ viewMode: 'topology' })} />);
    expect(screen.queryByPlaceholderText('Search nodes or stacks...')).not.toBeInTheDocument();
  });

  it('forwards search input changes once expanded', () => {
    const onSearchQueryChange = vi.fn();
    render(<OverviewToolbar {...props({ onSearchQueryChange })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Search nodes or stacks' }));
    fireEvent.change(screen.getByPlaceholderText('Search nodes or stacks...'), { target: { value: 'web' } });
    expect(onSearchQueryChange).toHaveBeenCalledWith('web');
  });

  it('exposes the Tags filter once a palette exists (no tier gate)', () => {
    const palette: FleetPaletteEntry[] = [{ key: 'prod|rose', name: 'prod', color: 'rose' }];
    render(<OverviewToolbar {...props({ fleetPalette: palette })} />);
    fireEvent.click(screen.getByRole('button', { name: /Filters/ }));
    // "Tags" appears as both the section label and the multiselect placeholder.
    expect(screen.getAllByText('Tags').length).toBeGreaterThan(0);
  });

  it('omits the Tags filter when the palette is empty', () => {
    render(<OverviewToolbar {...props()} />);
    fireEvent.click(screen.getByRole('button', { name: /Filters/ }));
    expect(screen.queryByText('Tags')).not.toBeInTheDocument();
  });

  const nodeManagement = {
    canConnectExisting: true,
    canBootstrapServer: true,
    checkingUpdates: false,
    onConnectExisting: vi.fn(),
    onBootstrapServer: vi.fn(),
    onCheckUpdates: vi.fn(),
  };

  it('renders one node-management control in place of the old toolbar buttons', () => {
    render(<OverviewToolbar {...props({ nodeManagement })} />);
    expect(screen.getByRole('button', { name: 'Node management' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Manage nodes' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Check for node updates/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Node Update/ })).not.toBeInTheDocument();
  });

  it('keeps the node-management control in topology mode', () => {
    render(<OverviewToolbar {...props({ viewMode: 'topology', nodeManagement })} />);
    expect(screen.getByRole('button', { name: 'Node management' })).toBeInTheDocument();
  });

  it('omits the node-management control when the caller passes none', () => {
    render(<OverviewToolbar {...props()} />);
    expect(screen.queryByRole('button', { name: 'Node management' })).not.toBeInTheDocument();
  });
});
