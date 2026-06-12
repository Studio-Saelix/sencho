import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export type MastheadTone = 'live' | 'idle' | 'warn' | 'error';

export interface MastheadMetadataItem {
    label: string;
    value: string;
    tone?: 'value' | 'warn' | 'error' | 'subtitle';
}

export interface PageMastheadProps {
    kicker: string;
    state: string;
    tone: MastheadTone;
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
    dotClass: string;
    stateTextClass: string;
    tintClass: string;
}> = {
    live: {
        dotClass: 'bg-brand shadow-[0_0_0_3px_color-mix(in_oklch,var(--brand)_22%,transparent)]',
        stateTextClass: 'text-stat-value',
        tintClass: 'from-brand/[0.06] via-transparent to-transparent',
    },
    idle: {
        dotClass: 'bg-stat-subtitle',
        stateTextClass: 'text-stat-title',
        tintClass: 'from-transparent via-transparent to-transparent',
    },
    warn: {
        dotClass: 'bg-warning shadow-[0_0_0_3px_color-mix(in_oklch,var(--warning)_22%,transparent)]',
        stateTextClass: 'text-warning',
        tintClass: 'from-warning/[0.06] via-transparent to-transparent',
    },
    error: {
        dotClass: 'bg-destructive shadow-[0_0_0_3px_color-mix(in_oklch,var(--destructive)_24%,transparent)]',
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
    const shouldPulse = pulsing && (tone === 'live' || tone === 'warn');

    return (
        <div
            className={cn(
                'relative shrink-0 overflow-hidden border border-card-border border-t-card-border-top bg-card shadow-card-bevel transition-colors',
                className,
            )}
        >
            <div className={cn('pointer-events-none absolute inset-0 bg-gradient-to-r', config.tintClass)} />
            <div className="absolute inset-y-0 left-0 w-[3px] bg-brand" />
            <div className="relative grid grid-cols-[1fr_auto] items-center gap-6 py-5 pl-7 pr-6">
                <div className="flex min-w-0 items-center gap-4">
                    <span
                        aria-hidden="true"
                        className={cn(
                            'h-2.5 w-2.5 shrink-0 rounded-full',
                            config.dotClass,
                            shouldPulse && 'animate-[pulse_2.4s_ease-in-out_infinite]',
                        )}
                    />
                    <div className="flex min-w-0 flex-col gap-1">
                        <span className="font-mono text-[10px] leading-3 uppercase tracking-[0.18em] text-stat-subtitle">
                            {kicker}
                        </span>
                        <span
                            className={cn(
                                'font-display italic tracking-[-0.01em]',
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
