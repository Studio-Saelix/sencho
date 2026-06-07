import { Home, Layers, Radar, Clock, Settings as SettingsIcon } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { NavItem, ActiveView } from './EditorLayout/hooks/useViewNavigationState';
import type { MobileView } from './EditorLayout/mobile-surface';

type TabId = 'home' | 'stacks' | 'fleet' | 'schedules' | 'settings';

interface MobileTabBarProps {
  /** The already-gated nav items (admin / remote / paid filtering applied). */
  navItems: NavItem[];
  activeView: ActiveView;
  /** Which top-level mobile surface is showing when no stack detail is open. */
  mobileView: MobileView;
  /** True while a stack detail is open (keeps the Stacks tab marked current). */
  detailOpen: boolean;
  onHome: () => void;
  onStacks: () => void;
  onNavigate: (view: ActiveView) => void;
  onSettings: () => void;
}

interface Tab {
  id: TabId;
  label: string;
  icon: LucideIcon;
  view?: ActiveView;
}

/**
 * Bottom tab bar for the mobile shell (hidden at md+). Five primary
 * destinations: Home (dashboard), Stacks (the list), Fleet, Sched, Settings.
 * Fleet and Sched only appear when present in the gated `navItems`, so the bar
 * never exposes a flow the desktop nav would hide (admin-only schedules,
 * hub-only views on a remote node). Everything else stays reachable through the
 * masthead "more" menu on bespoke screens, or the TopBar nav sheet elsewhere.
 */
export function MobileTabBar({
  navItems,
  activeView,
  mobileView,
  detailOpen,
  onHome,
  onStacks,
  onNavigate,
  onSettings,
}: MobileTabBarProps) {
  const has = (value: ActiveView) => navItems.some(i => i.value === value);

  const tabs: Tab[] = [
    { id: 'home', label: 'Home', icon: Home },
    { id: 'stacks', label: 'Stacks', icon: Layers },
    ...(has('fleet') ? [{ id: 'fleet' as const, label: 'Fleet', icon: Radar, view: 'fleet' as const }] : []),
    ...(has('scheduled-ops')
      ? [{ id: 'schedules' as const, label: 'Sched', icon: Clock, view: 'scheduled-ops' as const }]
      : []),
    { id: 'settings', label: 'Settings', icon: SettingsIcon },
  ];

  const currentTab = (): TabId | null => {
    if (detailOpen || mobileView === 'list') return 'stacks';
    if (activeView === 'dashboard') return 'home';
    if (activeView === 'fleet') return 'fleet';
    if (activeView === 'scheduled-ops') return 'schedules';
    if (activeView === 'settings') return 'settings';
    return null;
  };
  const current = currentTab();

  const select = (tab: Tab) => {
    if (tab.id === 'home') onHome();
    else if (tab.id === 'stacks') onStacks();
    else if (tab.id === 'settings') onSettings();
    else if (tab.view) onNavigate(tab.view);
  };

  return (
    <nav
      aria-label="Primary mobile"
      className={cn(
        'md:hidden flex shrink-0 items-stretch',
        'border-t border-hairline',
        'bg-[color-mix(in_oklch,var(--card)_70%,transparent)] backdrop-blur-md backdrop-saturate-150',
        'pb-[max(8px,env(safe-area-inset-bottom))]',
      )}
    >
      {tabs.map(tab => {
        const on = current === tab.id;
        const Icon = tab.icon;
        return (
          <button
            key={tab.id}
            type="button"
            onClick={() => select(tab)}
            aria-current={on ? 'page' : undefined}
            aria-label={tab.label}
            className={cn(
              'flex flex-1 min-h-14 flex-col items-center justify-center gap-1 pt-2',
              'transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/50',
              on ? 'text-brand' : 'text-stat-icon hover:text-foreground',
            )}
          >
            <Icon className="h-5 w-5" strokeWidth={1.6} />
            <span className={cn('font-mono text-[9px] uppercase tracking-[0.08em]', on && 'font-medium')}>
              {tab.label}
            </span>
          </button>
        );
      })}
    </nav>
  );
}
