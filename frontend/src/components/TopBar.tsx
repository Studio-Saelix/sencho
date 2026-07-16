import { Fragment, type ReactNode, useMemo } from 'react';
import type { LucideIcon } from 'lucide-react';
import { Menu, MoreHorizontal, Plus } from 'lucide-react';
import { Button } from './ui/button';
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
import type { TopNavAlign } from '@/hooks/use-top-nav-align';
import type { TopNavMode } from '@/hooks/use-top-nav-mode';
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
  /** Flat page destinations for Classic strip and the mobile sheet. */
  navItems: TopBarNavItem[];
  onNavigate: (value: string) => void;
  mobileNavOpen: boolean;
  onMobileNavOpenChange: (open: boolean) => void;
  search?: ReactNode;
  themeSwitch?: ReactNode;
  notifications: ReactNode;
  userMenu: ReactNode;
  showLabels?: boolean;
  navAlign?: TopNavAlign;
  navMode?: TopNavMode;
  navModel?: ReachableNavigationModel;
  /** Visible (reachable) quick links for Compact mode. */
  quickLinks?: NavDestination[];
  canAddQuickLink?: boolean;
  onAddQuickLink?: () => void;
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
}: {
  groups: NavGroupBucket[];
  activeView: string;
  onSelect: (value: string) => void;
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
            return (
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
          })}
        </Fragment>
      ))}
    </>
  );
}

function ClassicStrip({
  navItems,
  activeView,
  showLabels,
  onNavigate,
}: {
  navItems: TopBarNavItem[];
  activeView: string;
  showLabels: boolean;
  onNavigate: (value: string) => void;
}) {
  return (
    <>
      {navItems.map((item) => (
        <DesktopNavButton
          key={item.value}
          item={item}
          isActive={activeView === item.value}
          showLabels={showLabels}
          onNavigate={onNavigate}
        />
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
          <DropdownMenuContent align="start" className="w-56">
            <GroupedMenuItems
              groups={overflowGroups}
              activeView={activeView}
              onSelect={onNavigate}
            />
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </>
  );
}

function CompactStrip({
  launcherGroups,
  quickLinks,
  activeView,
  canAddQuickLink,
  onNavigate,
  onAddQuickLink,
  onOpenSettings,
}: {
  launcherGroups: NavGroupBucket[];
  quickLinks: NavDestination[];
  activeView: string;
  canAddQuickLink: boolean;
  onNavigate: (value: string) => void;
  onAddQuickLink?: () => void;
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
    <>
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label="Open navigation launcher"
            aria-current={launcherActive ? 'page' : undefined}
            data-sn-launcher-active={launcherActive ? 'true' : 'false'}
            className={navButtonClass(launcherActive)}
          >
            <Menu className="w-4 h-4 shrink-0" strokeWidth={1.5} />
            <ActiveUnderline active={launcherActive} />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-56">
          <GroupedMenuItems
            groups={launcherGroups}
            activeView={activeView}
            onSelect={selectDestination}
          />
        </DropdownMenuContent>
      </DropdownMenu>

      {canAddQuickLink && (
        <button
          type="button"
          aria-label="Add current page to quick links"
          onClick={() => onAddQuickLink?.()}
          className={navButtonClass(false)}
        >
          <Plus className="w-4 h-4 shrink-0" strokeWidth={1.5} />
        </button>
      )}

      {quickLinks.map((item) => (
        <DesktopNavButton
          key={item.value}
          item={item}
          isActive={activeView === item.value}
          showLabels={false}
          onNavigate={onNavigate}
        />
      ))}
    </>
  );
}

export function TopBar({
  activeView,
  navItems,
  onNavigate,
  mobileNavOpen,
  onMobileNavOpenChange,
  search,
  themeSwitch,
  notifications,
  userMenu,
  showLabels = true,
  navAlign = 'left',
  navMode = 'smart',
  navModel,
  quickLinks = [],
  canAddQuickLink = false,
  onAddQuickLink,
  onOpenSettings,
}: TopBarProps) {
  const stripLabels = navMode !== 'compact' && showLabels;
  const centered = navMode !== 'compact' && !stripLabels && navAlign === 'center';

  const primaryItems = navModel?.primaryItems ?? navItems;
  const overflowGroups = navModel?.overflowGroups ?? [];
  const launcherGroups = navModel?.launcherGroups ?? [];

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
            !stripLabels && centered && 'shrink-0',
          )}
        >
          {navMode === 'classic' && (
            <ClassicStrip
              navItems={navItems}
              activeView={activeView}
              showLabels={stripLabels}
              onNavigate={onNavigate}
            />
          )}
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
              activeView={activeView}
              canAddQuickLink={canAddQuickLink}
              onNavigate={onNavigate}
              onAddQuickLink={onAddQuickLink}
              onOpenSettings={onOpenSettings}
            />
          )}
        </nav>
      </TooltipProvider>

      <div
        className={cn(
          'flex items-center justify-end gap-2',
          centered ? 'flex-1 min-w-0' : stripLabels ? 'relative z-10 shrink-0' : 'flex-1 min-w-0',
        )}
      >
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
