import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

interface FleetTabHeadingProps {
    title: string;
    subtitle: string;
    action?: ReactNode;
}

/**
 * Standardized Fleet tab header: italic-serif title and muted subtitle on the
 * left, an optional primary action on the right. Rendered in both empty and
 * populated states so the tab chrome stays consistent.
 */
export function FleetTabHeading({ title, subtitle, action }: FleetTabHeadingProps) {
    return (
        <div className="flex items-center justify-between gap-3">
            <div>
                <h2 className="font-display italic text-[1.5rem] leading-tight text-stat-value">{title}</h2>
                <p className="text-sm text-stat-subtitle">{subtitle}</p>
            </div>
            {action}
        </div>
    );
}

/**
 * Vertical-centering shell that floats an empty-state card in the middle of the
 * tab body, below the heading.
 */
export function FleetEmptyState({ children }: { children: ReactNode }) {
    return (
        <div className="flex flex-col items-center justify-center min-h-[55vh]">
            {children}
        </div>
    );
}

interface FleetEmptyCardProps {
    icon: LucideIcon;
    title: string;
    description: string;
    action?: ReactNode;
}

/**
 * Minimal empty-state card: centered icon, italic headline, muted one-line
 * description, optional CTA.
 */
export function FleetEmptyCard({ icon: Icon, title, description, action }: FleetEmptyCardProps) {
    return (
        <div className="mx-auto max-w-xl rounded-xl border border-card-border/60 bg-popover/30 p-8 text-center space-y-4">
            <Icon className="mx-auto w-8 h-8 text-stat-subtitle" />
            <div>
                <h3 className="font-display italic text-[1.25rem] text-stat-value">{title}</h3>
                <p className="text-sm text-stat-subtitle leading-relaxed mt-1">{description}</p>
            </div>
            {action}
        </div>
    );
}
