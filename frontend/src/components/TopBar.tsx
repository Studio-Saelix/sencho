import { Fragment, type ReactNode, useMemo } from 'react';
import type { LucideIcon } from 'lucide-react';
import { Menu, MoreHorizontal, Plus } from 'lucide-react';
import { Button } from './ui/button';
import { ScrollArea } from './ui/scroll-area';
import { Sheet, SheetContent, SheetTrigger } from './ui/sheet';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './ui/tooltip';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './ui/dropdown-menu';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from './ui/context-menu';
import type { TopNavAlign } from '@/hooks/use-top-nav-align';
import type { TopNavMode } from '@/hooks/use-top-nav-mode';
import { MAX_QUICK_LINKS } from '@/hooks/use-top-nav-quick-links';
import type { NavDestination } from '@/lib/navigation/appNavRegistry';
import type { NavGroupBucket, ReachableNavigationModel } from '@/lib/navigation/buildNavigationModel';
import { cn } from '@/lib/utils';

export interface TopBarNavItem {
  value: string;
  label: string;
  icon: LucideIcon;
}

interface TopBarProps {
  activeView: string;
  /** Flat page destinations for the mobile sheet. */
  navItems: TopBarNavItem[];
  onNavigate: (value: string) => void;
  mobileNavOpen: boolean;
  onMobileNavOpenChange: (open: boolean) => void;
  search?: ReactNode;
  whatsNew?: ReactNode;
  themeSwitch?: ReactNode;
  notifications: ReactNode;
  userMenu: ReactNode;
  showLabels?: boolean;
  navAlign?: TopNavAlign;
  navMode?: TopNavMode;
  navModel?: ReachableNavigationModel;
  /** Visible (reachable) quick links for Compact mode. */
  quickLinks?: NavDestination[];
  /** Persisted pin IDs (including temporarily unreachable). Capacity is length. */
  persistedQuickLinkIds?: readonly string[];
  onAddQuickLink?: (value: string) => void;
  onRemoveQuickLink?: (value: string) => void;
  onOpenSettings?: () => void;
}

const navButtonClass = (isActive: boolean) =>
  cn(
    'relative inline-flex h-full shrink-0 items-center gap-2 px-4',
    'font-mono text-[10px] uppercase tracking-[0.18em] transition-colors',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/50',
    isActive ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
  );

function ActiveUnderline({ active }: { active: boolean }) {
  if (!active) return null;
  return (
    <span
      aria-hidden
      className="pointer-events-none absolute inset-x-0 -bottom-px h-[2px] bg-brand"
    />
  );
}

// Two bars that morph into an X, keyed off Radix's data-state attribute (already
// stamped on the trigger button by DropdownMenuTrigger asChild, so no extra React
// state is needed). A plain CSS transition, not a JS animation loop: Sencho's global
// [data-motion="reduced"] clamp (index.css) forces transition-duration to ~0ms for
// every element, so this automatically just swaps state under Reduced motion with
// zero extra code. The trigger button must carry the `group` class for the
// group-data-[state=open]: variants below to apply.
function LauncherHamburgerIcon() {
  // Both bars share everything but the direction they start from and rotate to.
  const bar = cn(
    'absolute h-[1.5px] w-3.5 rounded-full bg-current',
    'transition-transform duration-[var(--duration-fast)] ease-[var(--ease-out-expo)]',
    'group-data-[state=open]:translate-y-0',
  );
  return (
    <span className="relative flex h-4 w-4 shrink-0 items-center justify-center" aria-hidden>
      <span className={cn(bar, '-translate-y-[3px] group-data-[state=open]:rotate-45')} />
      <span className={cn(bar, 'translate-y-[3px] group-data-[state=open]:-rotate-45')} />
    </span>
  );
}

function TopBarMenuMasthead({ title }: { title: string }) {
  return (
    <div className="relative overflow-hidden">
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-r from-brand/[0.05] via-transparent to-transparent" />
      <div className="absolute inset-y-0 left-0 w-[2px] bg-brand/60" />
      <div className="relative flex items-center px-[var(--density-row-x)] py-[var(--density-tile-y)]">
        <span className="font-heading text-xl leading-none text-stat-value">{title}</span>
      </div>
    </div>
  );
}

// One scroll owner. The popper content and the ScrollArea viewport are both
// capped at the available height, but the content clips (overflow-hidden,
// overriding the base DropdownMenuContent's overflow-y-auto) and only the
// viewport scrolls.
//
// The viewport's cap has to be a max-height on the viewport itself. The viewport
// is sized by `h-full` (see ui/scroll-area), and a percentage height only
// resolves against a containing block whose height is definite. The popper
// content is `height: auto` clamped by `max-height`, which is not definite, so
// neither is anything sized from it, a flex item included, so `h-full` falls
// back to auto and the viewport grows to its full content height with nothing
// to scroll. A max-height clamps the viewport whatever its height resolves to.
// (`<ScrollArea className="flex-1">` stays correct wherever the flex
// container's own height is definite, as in the sheets and sidebars.)
//
// The masthead scrolls with the list rather than being pinned outside the
// scroll region, so the cap needs no masthead-height arithmetic and stays
// correct at every density setting.
function PanelMenuContent({
  title,
  children,
}: {
  title?: string;
  children: ReactNode;
}) {
  return (
    <DropdownMenuContent align="start" sideOffset={8} className="w-56 overflow-hidden rounded-md p-0">
      <ScrollArea className="[&>[data-radix-scroll-area-viewport]]:max-h-[var(--radix-dropdown-menu-content-available-height)]">
        {title ? <TopBarMenuMasthead title={title} /> : null}
        <div className={cn(title && 'border-t border-card-border/60', 'p-1')}>{children}</div>
      </ScrollArea>
    </DropdownMenuContent>
  );
}

function DesktopNavButton({
  item,
  isActive,
  showLabels,
  onNavigate,
}: {
  item: TopBarNavItem;
  isActive: boolean;
  showLabels: boolean;
  onNavigate: (value: string) => void;
}) {
  const Icon = item.icon;
  const button = (
    <button
      type="button"
      onClick={() => onNavigate(item.value)}
      aria-label={item.label}
      aria-current={isActive ? 'page' : undefined}
      className={navButtonClass(isActive)}
    >
      <Icon className="w-4 h-4 shrink-0" strokeWidth={1.5} />
      {showLabels && <span className="hidden xl:inline">{item.label}</span>}
      <ActiveUnderline active={isActive} />
    </button>
  );
  if (showLabels) return <Fragment>{button}</Fragment>;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent side="bottom">{item.label}</TooltipContent>
    </Tooltip>
  );
}

function GroupedMenuItems({
  groups,
  activeView,
  onSelect,
  onAddQuickLink,
  persistedIds,
  atCapacity,
}: {
  groups: NavGroupBucket[];
  activeView: string;
  onSelect: (value: string) => void;
  /** When set, Compact launcher rows get a context Add action. */
  onAddQuickLink?: (value: string) => void;
  persistedIds?: ReadonlySet<string>;
  atCapacity?: boolean;
}) {
  return (
    <>
      {groups.map((group, index) => (
        <Fragment key={group.group}>
          {index > 0 && <DropdownMenuSeparator />}
          <DropdownMenuLabel className="font-mono text-[10px] uppercase tracking-[0.18em] text-stat-subtitle">
            {group.label}
          </DropdownMenuLabel>
          {group.items.map((item) => {
            const Icon = item.icon;
            const isActive = activeView === item.value;
            const canContextAdd =
              Boolean(onAddQuickLink)
              && item.value !== 'settings'
              && !persistedIds?.has(item.value)
              && !atCapacity;

            const menuItem = (
              <DropdownMenuItem
                key={item.value}
                onSelect={() => onSelect(item.value)}
                data-active={isActive ? 'true' : undefined}
                className={cn(
                  'gap-2 font-mono text-[11px] uppercase tracking-[0.14em]',
                  isActive && 'bg-accent text-accent-foreground',
                )}
              >
                <Icon className="size-4 shrink-0" strokeWidth={1.5} />
                {item.label}
              </DropdownMenuItem>
            );

            if (!canContextAdd) return menuItem;

            return (
              <ContextMenu key={item.value}>
                <ContextMenuTrigger asChild>{menuItem}</ContextMenuTrigger>
                <ContextMenuContent>
                  <ContextMenuItem
                    onSelect={() => onAddQuickLink?.(item.value)}
                  >
                    Add to quick links
                  </ContextMenuItem>
                </ContextMenuContent>
              </ContextMenu>
            );
          })}
        </Fragment>
      ))}
    </>
  );
}

function SmartStrip({
  primaryItems,
  overflowGroups,
  activeView,
  showLabels,
  onNavigate,
}: {
  primaryItems: TopBarNavItem[];
  overflowGroups: NavGroupBucket[];
  activeView: string;
  showLabels: boolean;
  onNavigate: (value: string) => void;
}) {
  const overflowValues = useMemo(
    () => new Set<string>(overflowGroups.flatMap((g) => g.items.map((i) => i.value))),
    [overflowGroups],
  );
  const moreActive = overflowValues.has(activeView);
  const hasOverflow = overflowGroups.some((g) => g.items.length > 0);

  return (
    <>
      {primaryItems.map((item) => (
        <DesktopNavButton
          key={item.value}
          item={item}
          isActive={activeView === item.value}
          showLabels={showLabels}
          onNavigate={onNavigate}
        />
      ))}
      {hasOverflow && (
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="More navigation"
              aria-current={moreActive ? 'page' : undefined}
              className={navButtonClass(moreActive)}
            >
              <MoreHorizontal className="w-4 h-4 shrink-0" strokeWidth={1.5} />
              <span>More</span>
              <ActiveUnderline active={moreActive} />
            </button>
          </DropdownMenuTrigger>
          <PanelMenuContent>
            <GroupedMenuItems
              groups={overflowGroups}
              activeView={activeView}
              onSelect={onNavigate}
            />
          </PanelMenuContent>
        </DropdownMenu>
      )}
    </>
  );
}

function CompactQuickLink({
  item,
  isActive,
  onNavigate,
  onRemove,
}: {
  item: NavDestination;
  isActive: boolean;
  onNavigate: (value: string) => void;
  onRemove: (value: string) => void;
}) {
  const Icon = item.icon;

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <button
          type="button"
          onClick={() => onNavigate(item.value)}
          aria-label={item.label}
          aria-current={isActive ? 'page' : undefined}
          className={cn('relative inline-flex h-full shrink-0 items-stretch', navButtonClass(isActive))}
        >
          <Icon className="w-4 h-4 shrink-0" strokeWidth={1.5} />
          <span className="inline">{item.label}</span>
          <ActiveUnderline active={isActive} />
        </button>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={() => onRemove(item.value)}>Remove</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

function CompactStrip({
  launcherGroups,
  quickLinks,
  quickLinkCandidates,
  persistedQuickLinkIds,
  activeView,
  onNavigate,
  onAddQuickLink,
  onRemoveQuickLink,
  onOpenSettings,
}: {
  launcherGroups: NavGroupBucket[];
  quickLinks: NavDestination[];
  quickLinkCandidates: NavDestination[];
  persistedQuickLinkIds: readonly string[];
  activeView: string;
  onNavigate: (value: string) => void;
  onAddQuickLink?: (value: string) => void;
  onRemoveQuickLink?: (value: string) => void;
  onOpenSettings?: () => void;
}) {
  const launcherValues = useMemo(
    () => new Set<string>(launcherGroups.flatMap((g) => g.items.map((i) => i.value))),
    [launcherGroups],
  );
  const quickValues = useMemo(
    () => new Set<string>(quickLinks.map((i) => i.value)),
    [quickLinks],
  );
  const persistedSet = useMemo(
    () => new Set<string>(persistedQuickLinkIds),
    [persistedQuickLinkIds],
  );
  const atCapacity = persistedQuickLinkIds.length >= MAX_QUICK_LINKS;
  const unpinnedCandidates = useMemo(
    () => quickLinkCandidates.filter((item) => !persistedSet.has(item.value)),
    [quickLinkCandidates, persistedSet],
  );
  const addEnabled = !atCapacity && unpinnedCandidates.length > 0;
  const addDisabledReason = atCapacity
    ? 'Remove a quick link to free a slot'
    : 'No more destinations available';

  const launcherActive =
    launcherValues.has(activeView) && !quickValues.has(activeView);

  const selectDestination = (value: string) => {
    if (value === 'settings') {
      onOpenSettings?.();
      return;
    }
    onNavigate(value);
  };

  return (
    <div className="flex min-w-0 flex-1 self-stretch items-stretch">
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label="Open navigation launcher"
            aria-current={launcherActive ? 'page' : undefined}
            data-sn-launcher-active={launcherActive ? 'true' : 'false'}
            className={cn(navButtonClass(launcherActive), 'group')}
          >
            <LauncherHamburgerIcon />
            <ActiveUnderline active={launcherActive} />
          </button>
        </DropdownMenuTrigger>
        <PanelMenuContent title="Navigate">
          <GroupedMenuItems
            groups={launcherGroups}
            activeView={activeView}
            onSelect={selectDestination}
            onAddQuickLink={onAddQuickLink}
            persistedIds={persistedSet}
            atCapacity={atCapacity}
          />
        </PanelMenuContent>
      </DropdownMenu>

      <div
        data-sn-quick-link-rail
        className="flex min-w-0 self-stretch items-stretch overflow-x-auto [scrollbar-width:none]"
      >
        {quickLinks.map((item) => (
          <CompactQuickLink
            key={item.value}
            item={item}
            isActive={activeView === item.value}
            onNavigate={onNavigate}
            onRemove={(value) => onRemoveQuickLink?.(value)}
          />
        ))}
      </div>

      {addEnabled ? (
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="Add quick link"
              className={navButtonClass(false)}
            >
              <Plus className="w-4 h-4 shrink-0" strokeWidth={1.5} />
            </button>
          </DropdownMenuTrigger>
          <PanelMenuContent title="Add quick link">
            {unpinnedCandidates.map((item) => {
              const Icon = item.icon;
              const isCurrent = item.value === activeView;
              return (
                <DropdownMenuItem
                  key={item.value}
                  onSelect={() => onAddQuickLink?.(item.value)}
                  className={cn(
                    'gap-2 font-mono text-[11px] uppercase tracking-[0.14em]',
                    isCurrent && 'bg-accent text-accent-foreground',
                  )}
                >
                  <Icon className="size-4 shrink-0" strokeWidth={1.5} />
                  {item.label}
                </DropdownMenuItem>
              );
            })}
          </PanelMenuContent>
        </DropdownMenu>
      ) : (
        <Tooltip>
          <TooltipTrigger asChild>
            <span tabIndex={0} className="inline-flex h-full shrink-0 items-stretch">
              <button
                type="button"
                aria-label="Add quick link"
                aria-disabled="true"
                disabled
                className={cn(navButtonClass(false), 'pointer-events-none opacity-40')}
              >
                <Plus className="w-4 h-4 shrink-0" strokeWidth={1.5} />
              </button>
            </span>
          </TooltipTrigger>
          <TooltipContent side="bottom">{addDisabledReason}</TooltipContent>
        </Tooltip>
      )}
    </div>
  );
}

export function TopBar({
  activeView,
  navItems,
  onNavigate,
  mobileNavOpen,
  onMobileNavOpenChange,
  search,
  whatsNew,
  themeSwitch,
  notifications,
  userMenu,
  showLabels = true,
  navAlign = 'left',
  navMode = 'compact',
  navModel,
  quickLinks = [],
  persistedQuickLinkIds = [],
  onAddQuickLink,
  onRemoveQuickLink,
  onOpenSettings,
}: TopBarProps) {
  const stripLabels = navMode !== 'compact' && showLabels;
  const centered = navMode !== 'compact' && !stripLabels && navAlign === 'center';

  const primaryItems = navModel?.primaryItems ?? navItems;
  const overflowGroups = navModel?.overflowGroups ?? [];
  const launcherGroups = navModel?.launcherGroups ?? [];
  const quickLinkCandidates = navModel?.quickLinkCandidates ?? [];

  return (
    <div
      data-sn-chrome="topbar"
      data-sn-nav-mode={navMode}
      className={cn(
        'relative flex h-14 items-center gap-3 px-4',
        'border-b border-glass-border bg-sidebar backdrop-blur-md',
        'shadow-chrome-top',
      )}
    >
      {centered && <div className="flex-1 min-w-0" />}

      <TooltipProvider delayDuration={300} disableHoverableContent>
        <nav
          aria-label="Primary"
          className={cn(
            'hidden md:flex self-stretch items-stretch',
            stripLabels && 'min-w-0 flex-1 overflow-x-auto [scrollbar-width:none]',
            navMode === 'compact' && 'min-w-0 flex-1 overflow-x-visible',
            !stripLabels && centered && 'shrink-0',
          )}
        >
          {navMode === 'smart' && (
            <SmartStrip
              primaryItems={primaryItems}
              overflowGroups={overflowGroups}
              activeView={activeView}
              showLabels={stripLabels}
              onNavigate={onNavigate}
            />
          )}
          {navMode === 'compact' && (
            <CompactStrip
              launcherGroups={launcherGroups}
              quickLinks={quickLinks}
              quickLinkCandidates={quickLinkCandidates}
              persistedQuickLinkIds={persistedQuickLinkIds}
              activeView={activeView}
              onNavigate={onNavigate}
              onAddQuickLink={onAddQuickLink}
              onRemoveQuickLink={onRemoveQuickLink}
              onOpenSettings={onOpenSettings}
            />
          )}
        </nav>
      </TooltipProvider>

      <div
        className={cn(
          'flex items-center justify-end gap-2',
          centered ? 'flex-1 min-w-0' : 'relative z-10 shrink-0',
          !centered && !stripLabels && navMode !== 'compact' && 'flex-1 min-w-0',
        )}
      >
        {whatsNew}
        {search}
        {themeSwitch}
        {notifications}
        {userMenu}

        <Sheet open={mobileNavOpen} onOpenChange={onMobileNavOpenChange}>
          <SheetTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Open navigation menu"
              className="h-8 w-8 rounded-lg md:hidden"
            >
              <Menu className="w-4 h-4" strokeWidth={1.5} />
            </Button>
          </SheetTrigger>
          <SheetContent side="right" className="w-64 p-0">
            <div className="p-4 border-b">
              <p className="text-sm font-medium">Navigation</p>
            </div>
            <nav className="flex flex-col p-2 gap-1">
              {navItems.map(({ value, label, icon: Icon }) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => {
                    onNavigate(value);
                    onMobileNavOpenChange(false);
                  }}
                  className={cn(
                    'flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition-colors',
                    activeView === value
                      ? 'bg-glass-highlight font-medium text-foreground'
                      : 'text-muted-foreground hover:bg-glass-highlight hover:text-foreground',
                  )}
                >
                  <Icon className="w-4 h-4" strokeWidth={1.5} />
                  {label}
                </button>
              ))}
            </nav>
          </SheetContent>
        </Sheet>
      </div>
    </div>
  );
}
