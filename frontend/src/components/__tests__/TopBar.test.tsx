/**
 * Coverage for the TopBar `showLabels` preference and accessibility contract.
 *
 * Locks the compact icon-only mode: when labels are hidden the desktop nav must
 * drop the visible text yet keep an accessible name on every button, and the
 * mobile navigation sheet must always show its labels regardless of the setting.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Home, Radar } from 'lucide-react';
import { TopBar, type TopBarNavItem } from '../TopBar';
import { MAX_QUICK_LINKS } from '@/hooks/use-top-nav-quick-links';

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

  it('adds a leading spacer to center the nav only in icon-only center mode', () => {
    // Centered: a flex-1 spacer precedes the nav.
    const { unmount } = renderTopBar({ showLabels: false, navAlign: 'center' });
    expect(screen.getByRole('navigation', { name: 'Primary' }).previousElementSibling)
      .toHaveClass('flex-1');
    unmount();

    // Icon-only but left-aligned: no leading spacer.
    const second = renderTopBar({ showLabels: false, navAlign: 'left' });
    expect(screen.getByRole('navigation', { name: 'Primary' }).previousElementSibling).toBeNull();
    second.unmount();

    // Labels on always stays left, even if center is requested.
    renderTopBar({ showLabels: true, navAlign: 'center' });
    expect(screen.getByRole('navigation', { name: 'Primary' }).previousElementSibling).toBeNull();
  });
});

describe('TopBar smart and compact modes', () => {
  const overflowGroups = [
    {
      group: 'operations' as const,
      label: 'Operations',
      items: [{ value: 'global-observability' as const, label: 'Logs', icon: Home }],
    },
  ];
  const launcherGroups = [
    {
      group: 'overview' as const,
      label: 'Overview',
      items: [{ value: 'dashboard' as const, label: 'Home', icon: Home }],
    },
    {
      group: 'settings' as const,
      label: 'Settings',
      items: [{ value: 'settings' as const, label: 'Settings', icon: Radar }],
    },
  ];
  const emptyModel = {
    allPageItems: [
      { value: 'dashboard' as const, label: 'Home', icon: Home },
      { value: 'fleet' as const, label: 'Fleet', icon: Radar },
    ],
    primaryItems: [
      { value: 'dashboard' as const, label: 'Home', icon: Home },
      { value: 'fleet' as const, label: 'Fleet', icon: Radar },
    ],
    overflowGroups: [] as typeof overflowGroups,
    launcherGroups: [] as typeof launcherGroups,
    quickLinkCandidates: [
      { value: 'dashboard' as const, label: 'Home', icon: Home },
      { value: 'fleet' as const, label: 'Fleet', icon: Radar },
    ],
  };

  it('marks More with aria-current when the active page is in overflow', () => {
    renderTopBar({
      navMode: 'smart',
      activeView: 'global-observability',
      navModel: {
        ...emptyModel,
        overflowGroups,
      },
    });
    expect(screen.getByRole('button', { name: 'More navigation' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(screen.getByRole('button', { name: 'More navigation' })).toHaveTextContent('More');
  });

  it('opens the More menu without a redundant masthead title and keeps overflow labels', async () => {
    const onNavigate = vi.fn();
    renderTopBar({
      navMode: 'smart',
      onNavigate,
      navModel: {
        ...emptyModel,
        overflowGroups,
      },
    });
    const more = screen.getByRole('button', { name: 'More navigation' });
    more.focus();
    fireEvent.keyDown(more, { key: 'Enter' });
    expect(await screen.findByRole('menuitem', { name: /Logs/i })).toBeInTheDocument();
    expect(screen.queryByText('More', { selector: '.font-heading' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('menuitem', { name: /Logs/i }));
    expect(onNavigate).toHaveBeenCalledWith('global-observability');
  });

  it('renders Compact pins with always-inline labels and a trailing Add control', async () => {
    const user = userEvent.setup();
    const onNavigate = vi.fn();
    const onAddQuickLink = vi.fn();
    const onRemoveQuickLink = vi.fn();
    const onOpenSettings = vi.fn();
    renderTopBar({
      navMode: 'compact',
      activeView: 'dashboard',
      onNavigate,
      onAddQuickLink,
      onRemoveQuickLink,
      onOpenSettings,
      persistedQuickLinkIds: ['dashboard'],
      quickLinks: [{ value: 'dashboard', label: 'Home', icon: Home }],
      navModel: {
        ...emptyModel,
        launcherGroups,
        quickLinkCandidates: [
          { value: 'dashboard' as const, label: 'Home', icon: Home },
          { value: 'fleet' as const, label: 'Fleet', icon: Radar },
        ],
      },
    });

    const home = screen.getByRole('button', { name: 'Home' });
    expect(home.querySelector('span.inline')).toBeTruthy();
    expect(home.querySelector('span.hidden')).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Add quick link' }));
    await user.click(await screen.findByRole('menuitem', { name: /Fleet/i }));
    expect(onAddQuickLink).toHaveBeenCalledWith('fleet');

    await user.click(screen.getByRole('button', { name: 'Home' }));
    expect(onNavigate).toHaveBeenCalledWith('dashboard');

    await user.pointer({ keys: '[MouseRight]', target: screen.getByRole('button', { name: 'Home' }) });
    await user.click(await screen.findByRole('menuitem', { name: /^Remove$/i }));
    expect(onRemoveQuickLink).toHaveBeenCalledWith('dashboard');
    expect(onNavigate).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole('button', { name: 'Open navigation launcher' }));
    expect(await screen.findByText('Navigate', { selector: '.font-heading' })).toBeInTheDocument();
    await user.click(await screen.findByRole('menuitem', { name: /Settings/i }));
    expect(onOpenSettings).toHaveBeenCalled();
  });

  it('disables Add when persisted capacity is full even if fewer pins are visible', () => {
    renderTopBar({
      navMode: 'compact',
      // Capacity is a count check, so the IDs only need to be distinct and unpinned-candidate free.
      persistedQuickLinkIds: Array.from({ length: MAX_QUICK_LINKS }, (_, i) => `pinned-${i}`),
      quickLinks: [{ value: 'dashboard', label: 'Home', icon: Home }],
      navModel: {
        ...emptyModel,
        launcherGroups,
        quickLinkCandidates: [{ value: 'fleet' as const, label: 'Fleet', icon: Radar }],
      },
    });
    const add = screen.getByRole('button', { name: 'Add quick link' });
    expect(add).toBeDisabled();
    expect(add.closest('[title]')).toHaveAttribute('title', 'Remove a quick link to free a slot');
  });

  it('offers Compact launcher context Add for unpinned destinations', async () => {
    const user = userEvent.setup();
    const onAddQuickLink = vi.fn();
    const compactLauncher = [
      {
        group: 'overview' as const,
        label: 'Overview',
        items: [
          { value: 'dashboard' as const, label: 'Home', icon: Home },
          { value: 'fleet' as const, label: 'Fleet', icon: Radar },
        ],
      },
    ];
    renderTopBar({
      navMode: 'compact',
      onAddQuickLink,
      persistedQuickLinkIds: ['dashboard'],
      quickLinks: [{ value: 'dashboard', label: 'Home', icon: Home }],
      navModel: {
        ...emptyModel,
        launcherGroups: compactLauncher,
        quickLinkCandidates: [
          { value: 'dashboard' as const, label: 'Home', icon: Home },
          { value: 'fleet' as const, label: 'Fleet', icon: Radar },
        ],
      },
    });

    await user.click(screen.getByRole('button', { name: 'Open navigation launcher' }));
    fireEvent.contextMenu(await screen.findByRole('menuitem', { name: /Fleet/i }));
    await user.click(await screen.findByRole('menuitem', { name: /Add to quick links/i }));
    expect(onAddQuickLink).toHaveBeenCalledWith('fleet');
  });

  it('hides Compact launcher context Add for already-pinned destinations', async () => {
    const user = userEvent.setup();
    const compactLauncher = [
      {
        group: 'overview' as const,
        label: 'Overview',
        items: [
          { value: 'dashboard' as const, label: 'Home', icon: Home },
          { value: 'fleet' as const, label: 'Fleet', icon: Radar },
        ],
      },
    ];
    renderTopBar({
      navMode: 'compact',
      onAddQuickLink: vi.fn(),
      persistedQuickLinkIds: ['dashboard'],
      quickLinks: [{ value: 'dashboard', label: 'Home', icon: Home }],
      navModel: {
        ...emptyModel,
        launcherGroups: compactLauncher,
      },
    });

    await user.click(screen.getByRole('button', { name: 'Open navigation launcher' }));
    fireEvent.contextMenu(await screen.findByRole('menuitem', { name: /Home/i }));
    expect(screen.queryByRole('menuitem', { name: /Add to quick links/i })).toBeNull();
  });

  it('does not offer Add to quick links on Smart More', async () => {
    const user = userEvent.setup();
    renderTopBar({
      navMode: 'smart',
      onAddQuickLink: vi.fn(),
      navModel: {
        ...emptyModel,
        primaryItems: [{ value: 'dashboard' as const, label: 'Home', icon: Home }],
        overflowGroups,
      },
    });
    await user.click(screen.getByRole('button', { name: 'More navigation' }));
    fireEvent.contextMenu(await screen.findByRole('menuitem', { name: /Logs/i }));
    expect(screen.queryByRole('menuitem', { name: /Add to quick links/i })).toBeNull();
  });
});

describe('TopBar whatsNew slot', () => {
  it('renders the whatsNew slot before the search slot', () => {
    renderTopBar({
      whatsNew: <button aria-label="whats-new-marker">sparkle</button>,
      search: <button aria-label="search-marker">search</button>,
    });
    const whatsNewEl = screen.getByRole('button', { name: 'whats-new-marker' });
    const searchEl = screen.getByRole('button', { name: 'search-marker' });
    // DOM order, not visual order: whatsNew's position relative to search in
    // the source confirms it is placed before, not just present.
    expect(
      whatsNewEl.compareDocumentPosition(searchEl) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('renders nothing extra when whatsNew is omitted', () => {
    renderTopBar();
    expect(screen.queryByLabelText('whats-new-marker')).not.toBeInTheDocument();
  });
});
