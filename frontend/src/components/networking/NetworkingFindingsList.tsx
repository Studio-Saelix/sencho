import { Button } from '@/components/ui/button';
import type { useAuth } from '@/context/AuthContext';
import type { NetworkingFinding, NetworkingRecommendedAction } from '@/types/networking';
export type { NetworkingFinding } from '@/types/networking';

const SEVERITY_ORDER = ['critical', 'high', 'medium', 'info'] as const;

const SEVERITY_CLASS: Record<NetworkingFinding['severity'], string> = {
  info: 'text-stat-subtitle',
  medium: 'text-warning',
  high: 'text-destructive',
  critical: 'text-destructive',
};

export function isNetworkingActionVisible(
  action: NetworkingRecommendedAction,
  canEdit: ReturnType<typeof useAuth>['can'],
  isAdmin: boolean,
): boolean {
  if (action.kind === 'create-network') return isAdmin;
  if (action.kind === 'set-exposure-intent') return canEdit('stack:edit', 'stack', action.stack);
  return true;
}

export function NetworkingFindingsList({
  findings,
  loading,
  canEdit,
  isAdmin,
  onAction,
  disabled = false,
}: {
  findings: NetworkingFinding[];
  loading: boolean;
  canEdit: ReturnType<typeof useAuth>['can'];
  isAdmin: boolean;
  onAction: (action: NetworkingRecommendedAction) => void | Promise<void>;
  disabled?: boolean;
}) {
  if (loading) return <p className="text-sm text-muted-foreground">Loading findings…</p>;
  if (findings.length === 0) {
    return <p className="text-sm text-muted-foreground">No networking findings on this node.</p>;
  }

  return (
    <div className="space-y-4">
      {SEVERITY_ORDER.map((severity) => {
        const group = findings.filter((finding) => finding.severity === severity);
        if (!group.length) return null;
        return (
          <section key={severity}>
            <p className={`mb-2 font-mono text-[10px] uppercase tracking-[0.18em] ${SEVERITY_CLASS[severity]}`}>
              {severity} · {group.length}
            </p>
            <ul className="space-y-2">
              {group.map((finding) => (
                <li
                  key={finding.id}
                  className="rounded-lg border border-card-border border-t-card-border-top bg-card shadow-card-bevel px-3 py-2.5"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={`font-mono text-[10px] uppercase tracking-wide ${SEVERITY_CLASS[finding.severity]}`}>
                      {finding.kind}
                    </span>
                    <span className="text-sm font-medium text-stat-value">{finding.title}</span>
                  </div>
                  <p className="mt-1 text-sm text-stat-subtitle">{finding.message}</p>
                  {finding.evidence.length > 0 && (
                    <dl className="mt-2 grid gap-1 text-xs sm:grid-cols-2">
                      {finding.evidence.map((item) => (
                        <div key={`${item.label}-${item.value}`}>
                          <dt className="font-mono uppercase text-stat-subtitle">{item.label}</dt>
                          <dd className="font-mono text-stat-value">{item.value}</dd>
                        </div>
                      ))}
                    </dl>
                  )}
                  {!disabled && finding.recommendedActions.length > 0 && (
                    <div className="mt-3 flex flex-wrap gap-2">
                      {finding.recommendedActions
                        .filter((action) => isNetworkingActionVisible(action, canEdit, isAdmin))
                        .map((action) => (
                          <Button
                            key={`${finding.id}-${action.kind}-${action.label}`}
                            variant="outline"
                            size="sm"
                            onClick={() => void onAction(action)}
                          >
                            {action.label}
                          </Button>
                        ))}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
