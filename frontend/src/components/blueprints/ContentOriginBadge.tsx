import type { ContentOrigin } from '@/lib/blueprintsApi';

export function ContentOriginBadge({ origin }: { origin: ContentOrigin }) {
  const gitManaged = origin === 'git';
  return (
    <span className="inline-flex items-center rounded border border-card-border px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.2em] text-stat-icon">
      <span className={`mr-1.5 inline-block h-1.5 w-1.5 rounded-full ${gitManaged ? 'bg-brand' : 'bg-muted-foreground'}`} aria-hidden />
      {gitManaged ? 'Git-managed' : 'Inline'}
    </span>
  );
}
