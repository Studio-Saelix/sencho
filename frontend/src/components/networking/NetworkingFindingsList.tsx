export interface NetworkingFinding {
  id: string;
  kind: string;
  severity: 'info' | 'warning' | 'error';
  title: string;
  message: string;
  stack?: string;
  network?: string;
  service?: string;
}

const SEVERITY_CLASS: Record<NetworkingFinding['severity'], string> = {
  info: 'text-stat-subtitle',
  warning: 'text-warning',
  error: 'text-destructive',
};

export function NetworkingFindingsList({
  findings,
  loading,
}: {
  findings: NetworkingFinding[];
  loading: boolean;
}) {
  if (loading) return <p className="text-sm text-muted-foreground">Loading findings…</p>;
  if (findings.length === 0) return <p className="text-sm text-muted-foreground">No networking findings on this node.</p>;

  return (
    <ul className="space-y-2">
      {findings.map(f => (
        <li key={f.id} className="rounded-lg border border-card-border bg-card/30 px-3 py-2.5">
          <div className="flex flex-wrap items-center gap-2">
            <span className={`font-mono text-[10px] uppercase tracking-wide ${SEVERITY_CLASS[f.severity]}`}>
              {f.kind}
            </span>
            <span className="text-sm font-medium text-stat-value">{f.title}</span>
          </div>
          <p className="mt-1 text-sm text-stat-subtitle">{f.message}</p>
        </li>
      ))}
    </ul>
  );
}
