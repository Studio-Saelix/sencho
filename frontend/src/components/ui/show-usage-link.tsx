import { ExternalLink } from 'lucide-react';
import { cn } from '@/lib/utils';

/** Where the unknown-host-usage state is explained (the cgroup mount lives here). */
export const HOST_USAGE_DOCS_URL =
  'https://docs.sencho.io/getting-started/configuration#docker-hosts-inside-an-lxc-or-another-container';

/**
 * Quiet docs link for a host whose CPU or memory usage cannot be measured.
 * The fix is a Compose edit on the Docker host, so there is nothing to run in
 * place; naming the docs section is the specific verb.
 */
export function ShowUsageLink({ className }: { className?: string }) {
  return (
    <a
      href={HOST_USAGE_DOCS_URL}
      target="_blank"
      rel="noopener noreferrer"
      className={cn(
        'inline-flex items-center gap-1 font-mono text-[10px] text-stat-subtitle underline-offset-2 hover:text-brand hover:underline',
        className,
      )}
    >
      Show usage…
      <ExternalLink className="h-2.5 w-2.5" strokeWidth={1.5} />
    </a>
  );
}
