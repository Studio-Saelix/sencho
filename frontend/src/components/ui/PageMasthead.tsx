import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { MastheadRail } from '@/components/ui/MastheadRail';

export type MastheadTone = 'live' | 'idle' | 'warn' | 'error';

export interface MastheadMetadataItem {
    label: string;
    value: string;
    tone?: 'value' | 'warn' | 'error' | 'subtitle';
}

export interface PageMastheadProps {
    /** Small uppercase label above the state word. Omit to show only the state. */
    kicker?: string;
    state: string;
    tone: MastheadTone;
    /** When true with tone `live`, the left rail shimmers; otherwise the rail glows subtly. */
    pulsing?: boolean;
    metadata?: MastheadMetadataItem[];
    /** Optional meta line under the state word (e.g. a one-line posture summary). */
    subtitle?: ReactNode;
    children?: ReactNode;
    className?: string;
    /**
     * `hero` matches the larger title of the primary nav pages (Home, Fleet);
     * `default` is the compact title used by the secondary tool pages (Settings,
     * Console, Logs).
     */
    size?: 'default' | 'hero';
}

const toneConfig: Record<MastheadTone, {
    railClass: string;
    stateTextClass: string;
    tintClass: string;
}> = {
    live: {
        railClass: 'bg-brand',
        stateTextClass: 'text-stat-value',
        tintClass: 'from-brand/[0.06] via-transparent to-transparent',
    },
    idle: {
        railClass: 'bg-stat-subtitle',
        stateTextClass: 'text-stat-title',
        tintClass: 'from-transparent via-transparent to-transparent',
    },
    warn: {
        railClass: 'bg-warning',
        stateTextClass: 'text-warning',
        tintClass: 'from-warning/[0.06] via-transparent to-transparent',
    },
    error: {
        railClass: 'bg-destructive',
        stateTextClass: 'text-destructive',
        tintClass: 'from-destructive/[0.06] via-transparent to-transparent',
    },
};

const metadataToneClass: Record<NonNullable<MastheadMetadataItem['tone']>, string> = {
    value: 'text-stat-value',
    warn: 'text-warning',
    error: 'text-destructive',
    subtitle: 'text-stat-subtitle',
};

export function PageMasthead({
    kicker,
    state,
    tone,
    pulsing = false,
    metadata,
    subtitle,
    children,
    className,
    size = 'default',
}: PageMastheadProps) {
    const config = toneConfig[tone];
    const railVariant = tone === 'live' && pulsing ? 'shimmer' : 'glow';

    return (
        <div
            className={cn(
                'relative shrink-0 overflow-hidden border border-card-border border-t-card-border-top bg-card shadow-card-bevel transition-colors',
                className,
            )}
        >
            <div className={cn('pointer-events-none absolute inset-0 bg-gradient-to-r', config.tintClass)} />
            <MastheadRail variant={railVariant} className={config.railClass} />
            <div className="relative grid grid-cols-[1fr_auto] items-center gap-6 py-5 pl-7 pr-6">
                <div className="flex min-w-0 items-center gap-4">
                    <div className="flex min-w-0 flex-col gap-1">
                        {kicker ? (
                            <span className="font-mono text-[10px] leading-3 uppercase tracking-[0.18em] text-stat-subtitle">
                                {kicker}
                            </span>
                        ) : null}
                        <span
                            className={cn(
                                'font-heading tracking-[-0.01em]',
                                size === 'hero' ? 'text-3xl leading-none' : 'text-[22px] leading-7',
                                config.stateTextClass,
                            )}
                        >
                            {state}
                        </span>
                        {subtitle ? (
                            <span className="font-mono text-[11px] leading-tight text-stat-subtitle/90 truncate">
                                {subtitle}
                            </span>
                        ) : null}
                    </div>
                    {children ? <div className="ml-2 min-w-0">{children}</div> : null}
                </div>

                {metadata && metadata.length > 0 ? (
                    <div className="hidden items-stretch justify-end gap-0 md:flex">
                        {metadata.map((item, idx) => (
                            <div
                                key={item.label}
                                className={cn(
                                    'flex flex-col gap-1 px-5',
                                    idx > 0 && 'border-l border-border/60',
                                )}
                            >
                                <span className="font-mono text-[10px] leading-3 uppercase tracking-[0.18em] text-stat-subtitle">
                                    {item.label}
                                </span>
                                <span
                                    className={cn(
                                        'font-mono font-medium tabular-nums text-xl leading-none',
                                        metadataToneClass[item.tone ?? 'value'],
                                    )}
                                >
                                    {item.value}
                                </span>
                            </div>
                        ))}
                    </div>
                ) : null}
            </div>
        </div>
    );
}
