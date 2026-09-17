import type { BindingPreview, BindingMarkerClassification } from '@/lib/blueprintsApi';

const MARKER_META: Record<BindingMarkerClassification, { label: string; tone: string }> = {
    managed: { label: 'Managed by this Blueprint', tone: 'text-stat-subtitle' },
    unmanaged: { label: 'No Blueprint marker', tone: 'text-stat-subtitle' },
    conflicting: { label: 'Marker belongs to another Blueprint', tone: 'text-destructive' },
    unproven: { label: 'Marker could not be verified', tone: 'text-warning' },
};

interface BindingPreviewPanelProps {
    preview: BindingPreview;
}

export function BindingPreviewPanel({ preview }: BindingPreviewPanelProps) {
    const changes = preview.blueprintPreview?.changes ?? [];
    const markersByNode = new Map(preview.markers.map((marker) => [marker.nodeId, marker]));
    const hasConflicts = preview.markers.some((marker) => marker.classification === 'conflicting');
    const showRepo = preview.transition === 'adopt' || preview.transition === 'convert';

    return (
        <div className="space-y-3 rounded-lg border border-card-border bg-card p-3">
            <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-stat-icon">Preview</p>
            {showRepo && (
                <p className="text-xs text-stat-subtitle">
                    {preview.application.repoUrl ?? 'repository unknown'} · {preview.application.ref ?? 'ref unknown'}
                </p>
            )}
            {changes.length > 0 && (
                <div className="space-y-2">
                    <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-stat-icon">Target nodes</p>
                    <ul className="space-y-2">
                        {changes.map((change) => {
                            const marker = markersByNode.get(change.nodeId);
                            const markerMeta = marker ? MARKER_META[marker.classification] : null;
                            return (
                                <li key={change.nodeId} className="rounded-md border border-card-border/70 px-2.5 py-2">
                                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                                        <span className="text-sm text-foreground">{change.nodeName}</span>
                                        <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-stat-icon">
                                            {change.action}
                                        </span>
                                    </div>
                                    <p className="mt-1 text-xs text-stat-subtitle leading-relaxed">{change.detail}</p>
                                    {markerMeta && (
                                        <p className={`mt-1 text-xs leading-relaxed ${markerMeta.tone}`}>
                                            {markerMeta.label}
                                        </p>
                                    )}
                                </li>
                            );
                        })}
                    </ul>
                </div>
            )}
            {hasConflicts && (
                <p className="text-xs text-destructive leading-relaxed">
                    At least one targeted node already carries another Blueprint marker. Review before continuing.
                </p>
            )}
            {preview.rollbackLimitations.map((item) => (
                <p key={item} className="text-xs text-stat-subtitle leading-relaxed">{item}</p>
            ))}
        </div>
    );
}
