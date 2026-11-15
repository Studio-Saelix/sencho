import { useState } from 'react';
import {
    ChevronDown, ChevronRight, Layers, ExternalLink,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { apiFetch } from '@/lib/api';
import { readComposeInputsRefusal } from '@/lib/composeInputsRefusal';
import { toast } from '@/components/ui/toast-store';
import { LabelDot } from '../LabelPill';
import type { Label as StackLabel } from '../label-types';

interface StackContainer {
    Id?: string;
    Names?: string[];
    Image?: string;
    State?: string;
    Status?: string;
}

function containerName(c: StackContainer): string {
    if (c.Names && c.Names.length > 0) {
        return c.Names[0].replace(/^\//, '');
    }
    return c.Id?.slice(0, 12) ?? 'unknown';
}

function ContainerRow({ container, onNavigate }: {
    container: StackContainer;
    onNavigate: () => void;
}) {
    const name = containerName(container);
    const state = container.State?.toLowerCase() ?? 'unknown';
    const image = container.Image;
    const status = container.Status ?? '';

    const stateColor = state === 'running' ? 'bg-success' :
        state === 'restarting' ? 'bg-warning' : 'bg-destructive';

    return (
        <div className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-muted/50 transition-colors group">
            <div className={`w-1.5 h-1.5 rounded-full shrink-0 ${stateColor}`} />
            <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                    <span className="text-xs font-medium truncate">{name}</span>
                    <Badge variant="outline" className="text-[9px] px-1 py-0 h-3.5 shrink-0">{state}</Badge>
                </div>
                {(image || status) && (
                    <div className="flex items-center gap-2 mt-0.5">
                        {image && <span className="text-[10px] text-muted-foreground truncate">{image}</span>}
                        {status && <span className="text-[10px] text-muted-foreground shrink-0">{image ? '· ' : ''}{status}</span>}
                    </div>
                )}
            </div>
            <Button
                variant="ghost"
                size="sm"
                className="h-6 w-6 p-0 opacity-0 group-hover:opacity-100 transition-opacity"
                onClick={onNavigate}
                title="Open in editor"
            >
                <ExternalLink className="w-3 h-3" strokeWidth={1.5} />
            </Button>
        </div>
    );
}

export function StackSection({ stackName, nodeId, onNavigate, labelMap }: {
    stackName: string;
    nodeId: number;
    onNavigate: (nodeId: number, stackName: string) => void;
    labelMap?: Record<string, StackLabel[]>;
}) {
    const [expanded, setExpanded] = useState(false);
    const [containers, setContainers] = useState<StackContainer[] | null>(null);
    const [loading, setLoading] = useState(false);

    const handleExpand = async () => {
        if (loading) return;
        const next = !expanded;
        setExpanded(next);

        if (next && containers === null) {
            setLoading(true);
            try {
                const res = await apiFetch(`/fleet/node/${nodeId}/stacks/${encodeURIComponent(stackName)}/containers`, { localOnly: true });
                if (res.ok) {
                    setContainers(await res.json());
                } else {
                    const refusal = await readComposeInputsRefusal(res);
                    toast.error(refusal ?? 'Failed to load containers for ' + stackName);
                }
            } catch (error) {
                console.error('Failed to load containers for', stackName, error);
                toast.error('Failed to load containers for ' + stackName);
                setExpanded(false);
            } finally {
                setLoading(false);
            }
        }
    };

    const runningCount = containers?.filter(c => c.State?.toLowerCase() === 'running').length ?? 0;
    const totalCount = containers?.length ?? 0;

    return (
        <div>
            <button
                onClick={handleExpand}
                className="flex items-center gap-2 w-full px-3 py-1.5 rounded-md text-xs hover:bg-muted/50 transition-colors text-left group"
            >
                {expanded ? <ChevronDown className="w-3 h-3 shrink-0" /> : <ChevronRight className="w-3 h-3 shrink-0" />}
                <Layers className="w-3 h-3 text-muted-foreground shrink-0" />
                <span className="truncate flex-1">{stackName}</span>
                {labelMap?.[stackName]?.length ? (
                    <span className="flex items-center gap-0.5 shrink-0">
                        {labelMap[stackName].map(l => (
                            <LabelDot key={l.id} color={l.color} />
                        ))}
                    </span>
                ) : null}
                {containers !== null && (
                    <span className="text-[10px] text-muted-foreground shrink-0">
                        {runningCount}/{totalCount}
                    </span>
                )}
            </button>
            {expanded && (
                <div className="ml-4 mt-1 space-y-0.5">
                    {loading ? (
                        <div className="space-y-2 px-3 py-1">
                            <Skeleton className="h-5 w-full" />
                            <Skeleton className="h-5 w-3/4" />
                        </div>
                    ) : containers && containers.length > 0 ? (
                        containers.map(c => (
                            <ContainerRow
                                key={c.Id ?? containerName(c)}
                                container={c}
                                onNavigate={() => onNavigate(nodeId, stackName)}
                            />
                        ))
                    ) : (
                        <p className="text-[10px] text-muted-foreground px-3 py-1">No containers</p>
                    )}
                </div>
            )}
        </div>
    );
}
