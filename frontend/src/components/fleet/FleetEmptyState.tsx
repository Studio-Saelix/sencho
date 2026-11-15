import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

interface FleetTabHeadingProps {
    title: string;
    subtitle: string;
    action?: ReactNode;
}

/**
 * Title block for the Security and Settings panels that still carry one:
 * heading-styled title and muted subtitle on the left, an optional primary
 * action on the right. Fleet tabs do not use it; they use FleetTabActions.
 * The title follows the theme heading style (signature italic or calm) via
 * .font-heading.
 */
export function FleetTabHeading({ title, subtitle, action }: FleetTabHeadingProps) {
    return (
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div>
                <h2 className="font-heading text-[1.5rem] leading-tight text-stat-value">{title}</h2>
                <p className="text-sm text-stat-subtitle">{subtitle}</p>
            </div>
            {action}
        </div>
    );
}

/**
 * Action row for a Fleet tab. The Fleet masthead already names the page and the
 * tab strip names the tab, so tab content carries only its own primary action,
 * right-aligned, and no title block.
 */
export function FleetTabActions({ children }: { children: ReactNode }) {
    return <div className="flex flex-wrap items-center justify-end gap-2">{children}</div>;
}

/**
 * Vertical-centering shell that floats an empty-state card in the middle of the
 * tab body.
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
 * Minimal empty-state card: centered icon, heading-styled headline, muted
 * one-line description, optional CTA.
 */
export function FleetEmptyCard({ icon: Icon, title, description, action }: FleetEmptyCardProps) {
    return (
        <div className="mx-auto max-w-xl rounded-xl border border-card-border/60 bg-popover/30 p-8 text-center space-y-4">
            <Icon className="mx-auto w-8 h-8 text-stat-subtitle" />
            <div>
                <h3 className="font-heading text-[1.25rem] text-stat-value">{title}</h3>
                <p className="text-sm text-stat-subtitle leading-relaxed mt-1">{description}</p>
            </div>
            {action}
        </div>
    );
}
