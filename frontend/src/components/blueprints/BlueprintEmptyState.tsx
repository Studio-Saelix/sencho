import { LayoutTemplate, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface BlueprintEmptyStateProps {
    onCreate: () => void;
    canCreate: boolean;
}

export function BlueprintEmptyState({ onCreate, canCreate }: BlueprintEmptyStateProps) {
    return (
        <div className="mx-auto max-w-3xl rounded-xl border border-card-border border-t-card-border-top bg-card shadow-card-bevel">
            <div className="flex flex-col gap-5 p-8">
                <div className="flex items-center justify-between gap-3">
                    <div className="inline-flex items-center gap-2 text-brand">
                        <LayoutTemplate className="h-4 w-4" strokeWidth={1.5} />
                        <span className="font-mono text-[10px] uppercase tracking-[0.2em]">Deployments · Blueprints</span>
                    </div>
                </div>
                <h3 className="font-serif text-2xl italic leading-tight tracking-[-0.01em] text-stat-value">
                    Declare once. Distribute everywhere.
                </h3>
                <p className="font-sans text-sm leading-relaxed text-stat-subtitle">
                    A Blueprint is a docker-compose.yml plus a node selector. Sencho ensures the matching nodes always run that stack at the latest revision and tells you when reality drifts from the plan.
                </p>
                <div className="grid gap-3 md:grid-cols-3 border-t border-border pt-4">
                    <Step kicker="01 · Author" title="Paste your compose" copy="Or build it from scratch in the YAML editor. We classify it as stateless or stateful so the right safety rails apply." />
                    <Step kicker="02 · Target" title="Pick nodes by label or by ID" copy="Selector matches `production` nodes today and any node tagged `production` you add tomorrow." />
                    <Step kicker="03 · Reconcile" title="Sencho keeps it in sync" copy="Choose Observe, Suggest, or Enforce. Sencho still always detects drift, never silently." />
                </div>
                <div className="flex items-center justify-between gap-3 border-t border-border pt-4">
                    <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-stat-icon">
                        First blueprint, no fleet required
                    </span>
                    {canCreate && (
                        <Button size="sm" onClick={onCreate} className="gap-2">
                            <Sparkles className="h-4 w-4" strokeWidth={1.5} />
                            Create your first Blueprint
                        </Button>
                    )}
                </div>
            </div>
        </div>
    );
}

function Step({ kicker, title, copy }: { kicker: string; title: string; copy: string }) {
    return (
        <div className="flex flex-col gap-1.5">
            <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-brand">{kicker}</span>
            <span className="font-serif italic text-base text-stat-value">{title}</span>
            <span className="text-xs text-stat-subtitle leading-relaxed">{copy}</span>
        </div>
    );
}
