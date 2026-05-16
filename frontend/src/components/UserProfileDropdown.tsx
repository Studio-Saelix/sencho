import { useState } from 'react';
import {
    Settings,
    LogOut,
    ExternalLink,
    Monitor,
    Sun,
    Moon,
    User,
    Loader2,
    BookOpen,
    MessageSquare,
    CreditCard,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { useAuth } from '@/context/AuthContext';
import { useLicense } from '@/context/LicenseContext';
import { apiFetch } from '@/lib/api';
import { toast } from '@/components/ui/toast-store';
import { cn } from '@/lib/utils';
import { TierBadge } from './TierBadge';

type Theme = 'light' | 'dark' | 'auto';

interface UserProfileDropdownProps {
    theme: Theme;
    setTheme: (theme: Theme) => void;
    onOpenSettings: () => void;
}

const THEME_OPTIONS = [
    { value: 'auto' as const, label: 'Auto', icon: Monitor },
    { value: 'light' as const, label: 'Light', icon: Sun },
    { value: 'dark' as const, label: 'Dark', icon: Moon },
];

function getInitials(username: string | undefined): string {
    if (!username) return '';
    const trimmed = username.trim();
    if (!trimmed) return '';
    const parts = trimmed.split(/[\s._-]+/).filter(Boolean);
    if (parts.length >= 2) {
        return (parts[0][0] + parts[1][0]).toUpperCase();
    }
    return trimmed.slice(0, 2).toUpperCase();
}

export function UserProfileDropdown({ theme, setTheme, onOpenSettings }: UserProfileDropdownProps) {
    const { logout, user, isAdmin } = useAuth();
    const { license } = useLicense();
    const [billingLoading, setBillingLoading] = useState(false);
    const [open, setOpen] = useState(false);

    const closeMenu = () => setOpen(false);

    const handleOpenSettings = () => {
        closeMenu();
        onOpenSettings();
    };

    const handleLogout = () => {
        closeMenu();
        logout();
    };

    const openBillingPortal = async () => {
        setBillingLoading(true);
        try {
            const res = await apiFetch('/license/billing-portal', { localOnly: true });
            const data = await res.json().catch(() => ({}));
            if (res.ok && data.url) {
                window.open(data.url, '_blank');
                return;
            }
            toast.error(data?.error || data?.message || data?.data?.error || 'Something went wrong.');
        } catch {
            toast.error('Failed to open billing portal.');
        } finally {
            setBillingLoading(false);
            closeMenu();
        }
    };

    const showBilling = license?.status === 'active' && !license?.isLifetime;
    const initials = getInitials(user?.username);
    const roleLabel = user?.role;

    return (
        <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
                <Button
                    variant="outline"
                    size="icon"
                    className="h-9 w-9 rounded-full p-0 font-mono text-[10px] font-semibold uppercase tracking-[0.18em]"
                    title="Profile"
                    aria-label="Profile"
                >
                    {initials ? initials : <User className="h-4 w-4" strokeWidth={1.5} />}
                </Button>
            </PopoverTrigger>
            <PopoverContent
                className="w-72 overflow-hidden rounded-md p-0"
                align="end"
                sideOffset={8}
            >
                {/* Identity header */}
                <div className="relative overflow-hidden">
                    <div className="pointer-events-none absolute inset-0 bg-gradient-to-r from-brand/[0.05] via-transparent to-transparent" />
                    <div className="absolute inset-y-0 left-0 w-[2px] bg-brand/60" />
                    <div className="relative flex items-center gap-3 px-[var(--density-row-x)] py-[var(--density-tile-y)]">
                        <div className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-full border border-brand/25 bg-brand/10">
                            {initials ? (
                                <span className="font-mono text-sm leading-none text-brand">
                                    {initials}
                                </span>
                            ) : (
                                <User className="h-5 w-5 text-brand" strokeWidth={1.5} />
                            )}
                        </div>
                        <div className="min-w-0 flex-1">
                            <p className="truncate text-sm font-medium text-stat-value">
                                {user?.username ?? 'admin'}
                            </p>
                            <div className="mt-1.5 flex items-center gap-1.5">
                                {roleLabel ? (
                                    <span
                                        className={cn(
                                            'rounded-sm px-1.5 py-0.5 font-mono text-[10px] leading-3 font-semibold uppercase tracking-[0.18em]',
                                            isAdmin
                                                ? 'bg-brand/10 text-brand'
                                                : 'bg-muted text-stat-subtitle',
                                        )}
                                    >
                                        {roleLabel}
                                    </span>
                                ) : null}
                                <TierBadge />
                            </div>
                        </div>
                    </div>
                </div>

                {/* Navigation strip */}
                <div className="border-t border-card-border/60">
                    <MenuRow icon={Settings} label="Settings" onClick={handleOpenSettings} />
                    {showBilling ? (
                        <MenuRow
                            icon={CreditCard}
                            label="Billing"
                            onClick={openBillingPortal}
                            disabled={billingLoading}
                            loading={billingLoading}
                            trailingIcon={ExternalLink}
                        />
                    ) : null}
                    <MenuRow
                        icon={BookOpen}
                        label="Documentation"
                        href="https://docs.sencho.io"
                        external
                        onClick={closeMenu}
                    />
                    <MenuRow
                        icon={MessageSquare}
                        label="Feedback"
                        href="https://github.com/studio-saelix/sencho/issues"
                        external
                        onClick={closeMenu}
                    />
                </div>

                {/* Appearance */}
                <div className="flex items-center justify-between gap-3 border-t border-card-border/60 px-[var(--density-row-x)] py-[var(--density-row-y)]">
                    <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-stat-subtitle">
                        Appearance
                    </span>
                    <SegmentedControl
                        value={theme}
                        options={THEME_OPTIONS}
                        onChange={setTheme}
                        iconOnly
                        ariaLabel="Theme"
                    />
                </div>

                {/* Logout */}
                <div className="border-t border-card-border/60">
                    <button
                        type="button"
                        onClick={handleLogout}
                        className="flex w-full items-center gap-2.5 px-[var(--density-row-x)] py-[var(--density-row-y)] text-left text-sm text-destructive transition-colors hover:bg-destructive/5 focus-visible:bg-destructive/5 focus-visible:outline-none"
                    >
                        <LogOut className="h-4 w-4" strokeWidth={1.5} />
                        Log Out
                    </button>
                </div>
            </PopoverContent>
        </Popover>
    );
}

interface MenuRowProps {
    icon: LucideIcon;
    label: string;
    onClick?: () => void;
    href?: string;
    external?: boolean;
    disabled?: boolean;
    loading?: boolean;
    trailingIcon?: LucideIcon;
}

function MenuRow({
    icon: Icon,
    label,
    onClick,
    href,
    external,
    disabled,
    loading,
    trailingIcon,
}: MenuRowProps) {
    const TrailingIcon = trailingIcon ?? (external ? ExternalLink : undefined);
    const classes = cn(
        'flex w-full items-center gap-2.5 px-[var(--density-row-x)] py-[var(--density-row-y)] text-left text-sm text-stat-value transition-colors hover:bg-accent focus-visible:bg-accent focus-visible:outline-none',
        disabled && 'pointer-events-none opacity-50',
    );

    const leadingIcon = loading ? (
        <Loader2 className="h-4 w-4 animate-spin text-stat-icon" strokeWidth={1.5} />
    ) : (
        <Icon className="h-4 w-4 text-stat-icon" strokeWidth={1.5} />
    );

    const body = (
        <>
            {leadingIcon}
            <span className="flex-1 truncate">{label}</span>
            {TrailingIcon ? (
                <TrailingIcon className="h-3 w-3 text-stat-icon" strokeWidth={1.5} />
            ) : null}
        </>
    );

    if (href) {
        return (
            <a
                href={href}
                target={external ? '_blank' : undefined}
                rel={external ? 'noopener noreferrer' : undefined}
                onClick={onClick}
                className={classes}
            >
                {body}
            </a>
        );
    }

    return (
        <button type="button" onClick={onClick} disabled={disabled} className={classes}>
            {body}
        </button>
    );
}
