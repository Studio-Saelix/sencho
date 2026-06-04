import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { Menu } from 'lucide-react';
import { Button } from './ui/button';
import { Sheet, SheetContent, SheetTrigger } from './ui/sheet';
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
}: TopBarProps) {
    return (
        <div
            className={cn(
                'relative flex h-14 items-center gap-3 px-4',
                'border-b border-glass-border bg-sidebar backdrop-blur-md',
                'shadow-chrome-top',
            )}
        >
            {/* LEFT ZONE: reserved spacer (keeps nav visually centered) */}
            <div className="flex-1 min-w-0" />

            {/* CENTER ZONE: Navigation (hidden on mobile) */}
            <nav aria-label="Primary" className="hidden md:flex self-stretch items-stretch">
                {navItems.map(({ value, label, icon: Icon }) => {
                    const isActive = activeView === value;
                    return (
                        <button
                            key={value}
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
                            <span className="hidden xl:inline">{label}</span>
                            {isActive && (
                                <span
                                    aria-hidden
                                    className="pointer-events-none absolute inset-x-0 -bottom-px h-[2px] bg-brand"
                                />
                            )}
                        </button>
                    );
                })}
            </nav>

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
