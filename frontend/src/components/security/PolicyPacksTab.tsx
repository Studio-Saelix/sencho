import { useEffect, useState } from 'react';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { apiFetch } from '@/lib/api';
import type { PolicyPack, PolicyPackRule } from '@/types/security';

const SEVERITY_TEXT: Record<PolicyPackRule['severity'], string> = {
  CRITICAL: 'text-destructive',
  HIGH: 'text-warning',
  MEDIUM: 'text-warning',
  LOW: 'text-muted-foreground',
};

function EnforcementBadge({ enforcement }: { enforcement: PolicyPackRule['enforcement'] }) {
  const enforceable = enforcement === 'enforceable';
  return (
    <span
      className={cn(
        'inline-flex items-center rounded border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.18em]',
        enforceable
          ? 'border-brand/30 bg-brand/10 text-brand'
          : 'border-card-border bg-muted/30 text-stat-subtitle',
      )}
    >
      {enforceable ? 'Enforceable' : 'Warning'}
    </span>
  );
}

export function PolicyPacksTab() {
  const [packs, setPacks] = useState<PolicyPack[] | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // The catalog is global/static, so target the local control regardless
        // of which node is active.
        const res = await apiFetch('/security/policy-packs', { localOnly: true });
        if (!res.ok) throw new Error('Failed to load policy packs');
        const data = (await res.json()) as PolicyPack[];
        if (!cancelled) setPacks(Array.isArray(data) ? data : []);
      } catch (err) {
        // The catalog is a static, always-available route, so a failure here is a
        // real bug (routing/proxy/auth) worth a breadcrumb, not a silent empty state.
        console.error('[Security] Failed to load policy packs:', err);
        if (!cancelled) setError(true);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  if (error) {
    return (
      <p className="text-sm text-muted-foreground py-16 text-center">
        Policy packs could not be loaded.
      </p>
    );
  }

  if (!packs) {
    return (
      <div className="space-y-3" aria-busy="true">
        <Skeleton className="h-40 w-full rounded-lg" />
        <Skeleton className="h-40 w-full rounded-lg" />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <p className="text-sm text-muted-foreground max-w-2xl">
        Policy packs are curated security expectations for a deployment posture. Packs are advisory in
        Community: they explain what good looks like. Block-on-deploy enforcement is an Admiral capability.
      </p>

      {packs.map((pack) => (
        <div key={pack.id} className="rounded-lg border border-card-border border-t-card-border-top bg-card shadow-card-bevel overflow-hidden">
          <div className="border-b border-card-border px-4 py-3">
            <h3 className="font-display italic text-[18px] leading-6 text-stat-value">{pack.name}</h3>
            <p className="text-sm text-muted-foreground">{pack.tagline}</p>
            <p className="text-xs text-stat-subtitle mt-1">{pack.tierCopy}</p>
          </div>
          <ul className="divide-y divide-card-border/40">
            {pack.rules.map((rule) => (
              <li key={rule.id} className="px-4 py-3">
                <div className="flex items-center justify-between gap-3 flex-wrap">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="font-medium text-sm">{rule.name}</span>
                    <span className={cn('font-mono text-[10px] uppercase tracking-[0.18em]', SEVERITY_TEXT[rule.severity])}>
                      {rule.severity}
                    </span>
                  </div>
                  <EnforcementBadge enforcement={rule.enforcement} />
                </div>
                <dl className="mt-2 grid gap-1.5 text-xs sm:grid-cols-[7rem_1fr]">
                  <dt className="font-mono uppercase tracking-[0.18em] text-stat-subtitle">Checks</dt>
                  <dd className="text-stat-subtitle">{rule.whatItChecks}</dd>
                  <dt className="font-mono uppercase tracking-[0.18em] text-stat-subtitle">Why</dt>
                  <dd className="text-stat-subtitle">{rule.why}</dd>
                  <dt className="font-mono uppercase tracking-[0.18em] text-stat-subtitle">Fix</dt>
                  <dd className="text-stat-subtitle">{rule.howToFix}</dd>
                </dl>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
