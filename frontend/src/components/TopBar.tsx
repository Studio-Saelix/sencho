import { Fragment, type ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { Menu } from 'lucide-react';
import { Button } from './ui/button';
import { Sheet, SheetContent, SheetTrigger } from './ui/sheet';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './ui/tooltip';
import type { TopNavAlign } from '@/hooks/use-top-nav-align';
import { cn } from '@/lib/utils';

export interface TopBarNavItem {
    value: string;
    label: string;
    icon: LucideIcon;
}

interface TopBarProps {
    activeView: string;
    navItems: TopBarNavItem[];
    onNavigate: (value: string) => void;
    mobileNavOpen: boolean;
    onMobileNavOpenChange: (open: boolean) => void;
    search?: ReactNode;
    themeSwitch?: ReactNode;
    notifications: ReactNode;
    userMenu: ReactNode;
    /** Show text labels beside the desktop nav icons. When false, the bar is icon-only. */
    showLabels?: boolean;
    /** Desktop nav placement in icon-only mode. Ignored while labels are shown (always left). */
    navAlign?: TopNavAlign;
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
}: TopBarProps) {
    // Centering applies only to the icon-only bar; with labels on the nav stays
    // left so the long labels read from the edge.
    const centered = !showLabels && navAlign === 'center';
    return (
        <div
            className={cn(
                'relative flex h-14 items-center gap-3 px-4',
                'border-b border-glass-border bg-sidebar backdrop-blur-md',
                'shadow-chrome-top',
            )}
        >
            {/* LEFT SPACER: balances the right utilities so the nav centers. */}
            {centered && <div className="flex-1 min-w-0" />}

            {/* NAV ZONE: Navigation (hidden on mobile) */}
            <TooltipProvider delayDuration={300} disableHoverableContent>
                <nav aria-label="Primary" className="hidden md:flex self-stretch items-stretch">
                    {navItems.map(({ value, label, icon: Icon }) => {
                        const isActive = activeView === value;
                        const button = (
                            <button
                                onClick={() => onNavigate(value)}
                                aria-label={label}
                                aria-current={isActive ? 'page' : undefined}
                                className={cn(
                                    'relative inline-flex h-full items-center gap-2 px-4',
                                    'font-mono text-[10px] uppercase tracking-[0.18em] transition-colors',
                                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/50',
                                    isActive ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
                                )}
                            >
                                <Icon className="w-4 h-4 shrink-0" strokeWidth={1.5} />
                                {showLabels && <span className="hidden xl:inline">{label}</span>}
                                {isActive && (
                                    <span
                                        aria-hidden
                                        className="pointer-events-none absolute inset-x-0 -bottom-px h-[2px] bg-brand"
                                    />
                                )}
                            </button>
                        );
                        // Icon-only mode: a tooltip names the destination on hover/focus. With
                        // labels on, the visible text carries it, so the button renders bare.
                        return showLabels ? (
                            <Fragment key={value}>{button}</Fragment>
                        ) : (
                            <Tooltip key={value}>
                                <TooltipTrigger asChild>{button}</TooltipTrigger>
                                <TooltipContent side="bottom">{label}</TooltipContent>
                            </Tooltip>
                        );
                    })}
                </nav>
            </TooltipProvider>

            {/* RIGHT ZONE: Utilities + identity pin */}
            <div className="flex flex-1 min-w-0 items-center justify-end gap-2">
                {search}
                {themeSwitch}
                {notifications}
                {userMenu}

                {/* Mobile nav trigger */}
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
