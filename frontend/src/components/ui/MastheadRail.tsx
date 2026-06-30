import { cn } from '@/lib/utils';

export type MastheadRailVariant = 'shimmer' | 'glow';

interface MastheadRailProps {
    variant: MastheadRailVariant;
    className?: string;
}

export function MastheadRail({ variant, className }: MastheadRailProps) {
    return (
        <div
            aria-hidden
            className={cn('absolute inset-y-0 left-0 w-[3px] overflow-hidden', className)}
        >
            {variant === 'shimmer' ? (
                <div className="masthead-rail-shimmer absolute inset-x-0 h-1/3 bg-gradient-to-b from-transparent via-white/25 to-transparent" />
            ) : (
                <div className="masthead-rail-glow absolute inset-0" />
            )}
        </div>
    );
}
