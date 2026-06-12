/**
 * Coverage for the TopBar `showLabels` preference and accessibility contract.
 *
 * Locks the compact icon-only mode: when labels are hidden the desktop nav must
 * drop the visible text yet keep an accessible name on every button, and the
 * mobile navigation sheet must always show its labels regardless of the setting.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Home, Radar } from 'lucide-react';
import { TopBar, type TopBarNavItem } from '../TopBar';

const navItems: TopBarNavItem[] = [
  { value: 'dashboard', label: 'Home', icon: Home },
  { value: 'fleet', label: 'Fleet', icon: Radar },
];

function renderTopBar(overrides: Partial<Parameters<typeof TopBar>[0]> = {}) {
  return render(
    <TopBar
      activeView="dashboard"
      navItems={navItems}
      onNavigate={vi.fn()}
      mobileNavOpen={false}
      onMobileNavOpenChange={vi.fn()}
      notifications={null}
      userMenu={null}
      {...overrides}
    />,
  );
}

describe('TopBar showLabels', () => {
  it('renders visible nav labels by default', () => {
    renderTopBar();
    expect(screen.getByText('Home')).toBeInTheDocument();
    expect(screen.getByText('Fleet')).toBeInTheDocument();
  });

  it('hides the visible label text in icon-only mode but keeps the accessible name', () => {
    renderTopBar({ showLabels: false });
    expect(screen.queryByText('Home')).not.toBeInTheDocument();
    // The button is still reachable by its accessible name (aria-label).
    expect(screen.getByRole('button', { name: 'Home' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Fleet' })).toBeInTheDocument();
  });

  it('always shows labels in the mobile navigation sheet, even when desktop labels are off', () => {
    renderTopBar({ showLabels: false, mobileNavOpen: true });
    // Desktop label spans are not rendered in icon-only mode, so the only "Home"
    // text comes from the open sheet.
    expect(screen.getByText('Home')).toBeInTheDocument();
    expect(screen.getByText('Fleet')).toBeInTheDocument();
  });

  it('wraps nav buttons in a tooltip trigger only in icon-only mode', () => {
    // Radix TooltipTrigger (asChild) stamps a data-state attribute onto the
    // button; the labels-on path renders the button bare without one.
    const { unmount } = renderTopBar({ showLabels: false });
    expect(screen.getByRole('button', { name: 'Home' })).toHaveAttribute('data-state');
    unmount();
    renderTopBar({ showLabels: true });
    expect(screen.getByRole('button', { name: 'Home' })).not.toHaveAttribute('data-state');
  });

  it('forwards clicks to onNavigate through the icon-only tooltip trigger', () => {
    const onNavigate = vi.fn();
    renderTopBar({ showLabels: false, onNavigate });
    fireEvent.click(screen.getByRole('button', { name: 'Fleet' }));
    expect(onNavigate).toHaveBeenCalledWith('fleet');
  });
});
