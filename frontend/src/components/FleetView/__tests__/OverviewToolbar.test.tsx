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
  it('shows search and sort controls in grid mode', () => {
    render(<OverviewToolbar {...props()} />);
    expect(screen.getByPlaceholderText('Search nodes or stacks...')).toBeInTheDocument();
  });

  it('hides grid controls in topology mode', () => {
    render(<OverviewToolbar {...props({ viewMode: 'topology' })} />);
    expect(screen.queryByPlaceholderText('Search nodes or stacks...')).not.toBeInTheDocument();
  });

  it('forwards search input changes', () => {
    const onSearchQueryChange = vi.fn();
    render(<OverviewToolbar {...props({ onSearchQueryChange })} />);
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
});
