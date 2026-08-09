import { useState } from 'react';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { ConfirmModal } from '@/components/ui/modal';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { Unlock } from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { toast } from '@/components/ui/toast-store';
import { SENCHO_OPEN_STACK_EVENT, type SenchoOpenStackDetail } from '@/lib/events';
import { TableSkeleton } from './TableSkeleton';

export interface RollbackGeneration {
    id: string;
    shortId: string;
    stackName: string;
    status: 'active' | 'restored_current' | 'superseded' | 'recovery_required';
    isCurrent: boolean;
    phase: string;
    createdAt: number;
    artifactExpiresAt: number | null;
    /** Best-effort UI hint only; the server revalidates eligibility on release. */
    releasable: boolean;
}

interface RollbackGenerationsTabProps {
    generations: RollbackGeneration[];
    isLoading: boolean;
    isAdmin: boolean;
    nodeId?: number;
    /** Refetches the Resources page's data after a successful release. */
    onReleased: () => void | Promise<void>;
}

function formatExpiry(gen: RollbackGeneration): string {
    if (gen.isCurrent) return 'Protected while current';
    if (gen.status === 'recovery_required') return 'Recovery required';
    if (gen.artifactExpiresAt === null) return 'Pending';
    const days = (gen.artifactExpiresAt - Date.now()) / (24 * 60 * 60 * 1000);
    if (days <= 0) return 'Expiring now';
    if (days < 1) return `Expires in ${Math.max(1, Math.round(days * 24))}h`;
    return `Expires in ${Math.round(days)}d`;
}

function StateBadge({ gen }: { gen: RollbackGeneration }) {
    switch (gen.status) {
        case 'recovery_required':
            return <Badge variant="destructive" className="text-[10px] h-5">Recovery required</Badge>;
        case 'superseded':
            return <Badge variant="secondary" className="text-[10px] h-5">Superseded</Badge>;
        case 'active':
        case 'restored_current':
            return gen.isCurrent
                ? <Badge variant="default" className="text-[10px] h-5">Current</Badge>
                : <Badge variant="secondary" className="text-[10px] h-5">Superseded</Badge>;
        default: {
            const unhandled: never = gen.status;
            return <Badge variant="secondary" className="text-[10px] h-5">{String(unhandled)}</Badge>;
        }
    }
}

/**
 * Full-stack rollback generations (the sencho-rb/<id>/<service>:hold images
 * StackUpdateRecoveryService creates). Kept in its own tab rather than the
 * generic Images list: this is durable recovery state with its own lifecycle
 * (stack, generation, retention, release), not ordinary Docker image inventory.
 */
export function RollbackGenerationsTab({ generations, isLoading, isAdmin, nodeId, onReleased }: RollbackGenerationsTabProps) {
    const [confirmRelease, setConfirmRelease] = useState<RollbackGeneration | null>(null);
    const [isReleasing, setIsReleasing] = useState(false);

    const handleRelease = async () => {
        if (!confirmRelease) return;
        setIsReleasing(true);
        const loadingId = toast.loading(`Releasing rollback protection for ${confirmRelease.shortId}...`);
        try {
            const res = await apiFetch(`/system/rollback/generations/${confirmRelease.id}/release`, { method: 'POST' });
            const data = await res.json().catch(() => null);
            if (!res.ok) {
                throw new Error(data?.error || 'Failed to release rollback protection');
            }
            toast.success(data?.message || 'Rollback protection released');
            await onReleased();
        } catch (error) {
            const err = error as Record<string, unknown>;
            toast.error(String(err?.message || 'Failed to release rollback protection'));
        } finally {
            toast.dismiss(loadingId);
            setIsReleasing(false);
            setConfirmRelease(null);
        }
    };

    return (
        <>
            <p className="mb-3 text-sm leading-relaxed text-stat-subtitle">
                Rollback-protected images from full-stack updates. Each generation is kept so a failed update can be
                automatically rolled back, and clears on its own once it is superseded and its retention window
                passes (configurable under Settings → Infrastructure → Stacks → Deploy Guardrails).
            </p>
            <div className="rounded-lg border border-card-border border-t-card-border-top bg-card shadow-card-bevel overflow-hidden">
            <ScrollArea className="h-[62vh] max-md:h-auto">
                <Table>
                    <TableHeader>
                        <TableRow>
                            <TableHead>Stack</TableHead>
                            <TableHead>Generation</TableHead>
                            <TableHead className="text-center">State</TableHead>
                            <TableHead>Retention</TableHead>
                            <TableHead className="text-right">Actions</TableHead>
                        </TableRow>
                    </TableHeader>
                    {isLoading ? <TableSkeleton cols={5} /> : (
                    <TableBody>
                        {generations.length === 0 ? (
                            <TableRow>
                                <TableCell colSpan={5} className="text-center py-8 text-muted-foreground text-sm">
                                    No rollback-protected generations on this node.
                                </TableCell>
                            </TableRow>
                        ) : generations.map((gen, i) => (
                            <TableRow
                                key={gen.id}
                                className="animate-in fade-in-0 duration-200 hover:bg-muted/30 transition-colors"
                                style={{ animationDelay: `${Math.min(i * 20, 200)}ms` }}
                            >
                                <TableCell className="font-medium">
                                    <button
                                        type="button"
                                        disabled={nodeId === undefined}
                                        className="hover:underline underline-offset-2 disabled:no-underline disabled:cursor-default"
                                        onClick={() => nodeId !== undefined && window.dispatchEvent(
                                            new CustomEvent<SenchoOpenStackDetail>(SENCHO_OPEN_STACK_EVENT, { detail: { nodeId, stackName: gen.stackName } }),
                                        )}
                                    >
                                        {gen.stackName}
                                    </button>
                                </TableCell>
                                <TableCell className="font-mono text-xs text-muted-foreground">{gen.shortId}</TableCell>
                                <TableCell className="text-center"><StateBadge gen={gen} /></TableCell>
                                <TableCell className="text-xs text-stat-subtitle">{formatExpiry(gen)}</TableCell>
                                <TableCell className="text-right">
                                    {isAdmin && (
                                        <TooltipProvider>
                                            <Tooltip>
                                                <TooltipTrigger asChild>
                                                    <Button
                                                        variant="ghost"
                                                        size="icon"
                                                        className="h-7 w-7 text-muted-foreground hover:text-destructive transition-colors"
                                                        disabled={!gen.releasable}
                                                        onClick={() => setConfirmRelease(gen)}
                                                        aria-label={`Release rollback protection for ${gen.shortId}`}
                                                    >
                                                        <Unlock className="w-3.5 h-3.5" strokeWidth={1.5} />
                                                    </Button>
                                                </TooltipTrigger>
                                                <TooltipContent>
                                                    {gen.releasable
                                                        ? 'Release rollback protection'
                                                        : 'Not releasable right now (mid-recovery or observing a health gate)'}
                                                </TooltipContent>
                                            </Tooltip>
                                        </TooltipProvider>
                                    )}
                                </TableCell>
                            </TableRow>
                        ))}
                    </TableBody>
                    )}
                </Table>
            </ScrollArea>
            </div>

            <ConfirmModal
                open={!!confirmRelease}
                onOpenChange={(open) => !open && setConfirmRelease(null)}
                variant="destructive"
                kicker="ROLLBACK · RELEASE · IRREVERSIBLE"
                title={`Release rollback protection for ${confirmRelease?.stackName ?? ''}`}
                confirmLabel={isReleasing ? 'Releasing...' : 'Release'}
                confirming={isReleasing}
                onConfirm={handleRelease}
            >
                <p className="text-sm text-stat-subtitle">
                    {confirmRelease?.isCurrent ? (
                        <>
                            This is <span className="font-medium text-stat-value">{confirmRelease?.stackName}</span>'s
                            current rollback point. Releasing it now means Sencho will not be able to automatically
                            roll this stack back until its next successful full-stack update.
                        </>
                    ) : (
                        <>
                            Permanently removes the held rollback image for generation{' '}
                            <span className="font-mono font-medium text-stat-value">{confirmRelease?.shortId}</span>{' '}
                            ahead of its normal retention window.
                        </>
                    )}
                </p>
            </ConfirmModal>
        </>
    );
}
