import { useState, type ReactNode } from 'react';
import { Menu } from 'lucide-react';
import { Button } from './ui/button';
import { Sheet, SheetContent, SheetTrigger } from './ui/sheet';
import { cn } from '@/lib/utils';
import type { NavItem, ActiveView } from './EditorLayout/hooks/useViewNavigationState';

// Destinations the bottom tab bar already exposes; the "more" menu omits these
// so it lists only the secondary destinations (auto-updates, app store,
// observability, etc.). Kept in sync with MobileTabBar's tab set.
const TAB_BAR_VIEWS = new Set<string>(['dashboard', 'fleet', 'scheduled-ops', 'settings']);

interface MobileMoreMenuProps {
  /** The already-gated nav items (admin / remote / paid filtering applied). */
  navItems: NavItem[];
  activeView: ActiveView;
  onNavigate: (value: ActiveView) => void;
  /** Theme switch + account controls, pinned to the bottom of the sheet. */
  footer?: ReactNode;
}

/**
 * The "more destinations" affordance for the mobile content screens. On a phone
 * the global TopBar is dropped and each screen's masthead leads, so this hosts
 * every secondary destination the bottom tab bar does not (auto-updates, app
 * store, observability, etc.) plus the theme and account controls.
 */
export function MobileMoreMenu({ navItems, activeView, onNavigate, footer }: MobileMoreMenuProps) {
  const [open, setOpen] = useState(false);
  const secondaryItems = navItems.filter(item => !TAB_BAR_VIEWS.has(item.value));

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label="More destinations"
          className="h-9 w-9 rounded-lg text-stat-icon"
        >
          <Menu className="h-[18px] w-[18px]" strokeWidth={1.6} />
        </Button>
      </SheetTrigger>
      <SheetContent side="right" className="flex w-72 flex-col p-0">
        <div className="border-b border-hairline px-4 py-3">
          <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-stat-icon">Navigate</p>
        </div>
        <nav className="flex flex-1 flex-col gap-1 overflow-y-auto p-2">
          {secondaryItems.map(({ value, label, icon: Icon }) => (
            <button
              key={value}
              type="button"
              onClick={() => {
                onNavigate(value);
                setOpen(false);
              }}
              className={cn(
                'flex min-h-11 items-center gap-3 rounded-lg px-3 text-sm transition-colors',
                activeView === value
                  ? 'bg-glass-highlight font-medium text-foreground'
                  : 'text-muted-foreground hover:bg-glass-highlight hover:text-foreground',
              )}
            >
              <Icon className="h-4 w-4" strokeWidth={1.5} />
              {label}
            </button>
          ))}
        </nav>
        {footer ? (
          <div className="flex items-center justify-between gap-2 border-t border-hairline px-4 py-3">
            {footer}
          </div>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}
