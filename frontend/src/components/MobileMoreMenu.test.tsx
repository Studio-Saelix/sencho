import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Home, Radar, Boxes, ShieldCheck } from 'lucide-react';
import { MobileMoreMenu } from './MobileMoreMenu';
import { GlobalCommandPaletteProvider, usePaletteState } from './GlobalCommandPalette';
import type { NavItem } from './EditorLayout/hooks/useViewNavigationState';

// Includes a bottom-tab primary (dashboard) and secondary destinations; the
// menu must list every one so navigation is identical on every screen.
const navItems: NavItem[] = [
  { value: 'dashboard', label: 'Home', icon: Home },
  { value: 'fleet', label: 'Fleet', icon: Radar },
  { value: 'resources', label: 'Resources', icon: Boxes },
  { value: 'security', label: 'Security', icon: ShieldCheck },
];

function open(over: Partial<React.ComponentProps<typeof MobileMoreMenu>> = {}) {
  const props: React.ComponentProps<typeof MobileMoreMenu> = {
    navItems,
    activeView: 'security',
    onNavigate: vi.fn(),
    ...over,
  };
  // The Search item reaches the command palette via usePaletteState, so the
  // menu must render inside the palette provider.
  render(
    <GlobalCommandPaletteProvider>
      <MobileMoreMenu {...props} />
    </GlobalCommandPaletteProvider>,
  );
  // The destination list lives inside a Sheet that is closed until the trigger
  // is clicked, so open it before querying the nav buttons.
  fireEvent.click(screen.getByRole('button', { name: 'More destinations' }));
  return props;
}

describe('MobileMoreMenu', () => {
  it('lists every nav item, including the bottom-tab primaries', () => {
    open();
    for (const item of navItems) {
      expect(screen.getByRole('button', { name: item.label })).toBeInTheDocument();
    }
  });

  it('navigates to the chosen destination on click', () => {
    const { onNavigate } = open();
    fireEvent.click(screen.getByRole('button', { name: 'Resources' }));
    expect(onNavigate).toHaveBeenCalledWith('resources');
  });

  it('marks the active destination', () => {
    open({ activeView: 'security' });
    expect(screen.getByRole('button', { name: 'Security' }).className).toContain('bg-glass-highlight');
    expect(screen.getByRole('button', { name: 'Resources' }).className).not.toContain('font-medium');
  });

  it('opens the command palette from the Search item', () => {
    // The Stacks list drops the TopBar's search, so the menu's Search item is
    // the way back to the palette: clicking it flips the shared palette state.
    function PaletteProbe() {
      const { open: paletteOpen } = usePaletteState();
      return <span data-testid="palette-open">{String(paletteOpen)}</span>;
    }
    render(
      <GlobalCommandPaletteProvider>
        <PaletteProbe />
        <MobileMoreMenu navItems={navItems} activeView="security" onNavigate={vi.fn()} />
      </GlobalCommandPaletteProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'More destinations' }));
    expect(screen.getByTestId('palette-open').textContent).toBe('false');
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    expect(screen.getByTestId('palette-open').textContent).toBe('true');
  });
});
