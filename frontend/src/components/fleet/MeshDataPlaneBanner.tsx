import { AlertTriangle } from 'lucide-react';
import type { MeshDataPlaneStatus } from '@/types/mesh';

type Reason = MeshDataPlaneStatus['reason'];
type ActionableReason = Exclude<Reason, 'ok' | 'not_started' | 'not_in_docker'>;

const HEADLINES: Record<ActionableReason, (status: MeshDataPlaneStatus) => string> = {
    subnet_invalid: () => 'SENCHO_MESH_SUBNET is not a valid CIDR.',
    subnet_overlap: (s) => `Mesh subnet ${s.subnet} overlaps an existing Docker network on this host.`,
    subnet_mismatch: (s) => `sencho_mesh already exists with a different subnet than ${s.subnet}.`,
    ip_in_use: (s) => `Another container is using Sencho's address on ${s.subnet}.`,
    attach_failed: () => 'Sencho could not attach to its own mesh network.',
};

function isActionable(reason: Reason): reason is ActionableReason {
    return reason !== 'ok' && reason !== 'not_started' && reason !== 'not_in_docker';
}

export type MeshDataPlaneBannerVariant = 'tab' | 'card';

/**
 * Surfaces the local mesh data-plane failure with the operator-actionable
 * recovery hint. Suppresses the dev-mode `not_in_docker` and the transient
 * `not_started` states so the operator only sees a banner when there is
 * something to fix.
 *
 * - `tab` variant: the full block shown at the top of the Routing tab.
 * - `card` variant: a single-line strip designed to sit inside a dashboard
 *   card (e.g. Fleet Heartbeat).
 */
export function MeshDataPlaneBanner({
    status,
    variant = 'tab',
}: {
    status: MeshDataPlaneStatus | null;
    variant?: MeshDataPlaneBannerVariant;
}) {
    if (!status || status.ok || !isActionable(status.reason)) return null;
    const headline = HEADLINES[status.reason](status);

    if (variant === 'card') {
        // Compact single-row strip for inside the Fleet Heartbeat card.
        // Headline only — the full recovery hint lives on the Routing tab
        // banner and in /docs/features/sencho-mesh.mdx#troubleshooting.
        return (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 px-2.5 py-1.5 mb-2 text-xs text-destructive flex items-center gap-2">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0" strokeWidth={1.75} />
                <span className="font-medium shrink-0">Mesh data plane down</span>
                <span className="text-destructive/60 shrink-0">·</span>
                <span className="font-mono text-[11px] shrink-0">{status.reason}</span>
                <span className="text-destructive/60 shrink-0">·</span>
                <span className="truncate min-w-0">{headline}</span>
            </div>
        );
    }

    return (
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive flex items-start gap-3 shadow-card-bevel">
            <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" strokeWidth={1.75} />
            <div className="min-w-0 space-y-1">
                <div className="font-medium">Mesh data plane is down</div>
                <div className="text-xs leading-relaxed text-destructive/90">
                    {headline}
                    {' '}
                    Set <code className="font-mono bg-destructive/15 px-1 py-0.5 rounded text-[11px]">SENCHO_MESH_SUBNET</code> to a free <code className="font-mono bg-destructive/15 px-1 py-0.5 rounded text-[11px]">/24</code> (for example <code className="font-mono bg-destructive/15 px-1 py-0.5 rounded text-[11px]">10.42.0.0/24</code>) and restart the Sencho container.
                </div>
                {status.message ? (
                    <div className="text-[11px] font-mono text-destructive/80 truncate">{status.message}</div>
                ) : null}
            </div>
        </div>
    );
}
