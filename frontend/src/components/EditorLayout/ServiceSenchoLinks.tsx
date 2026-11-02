import { ArrowUpRight } from 'lucide-react';
import {
  applicationLink,
  ignoredLabels,
  namedLinks,
  unverifiedLinkCount,
  type SenchoLabelResolution,
} from '@/lib/senchoLabels';

const LINK_CLASS = 'inline-flex min-w-0 max-w-full items-center gap-1 text-brand hover:underline max-md:min-h-11';

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

interface ServiceSenchoLinksProps {
  resolution: SenchoLabelResolution | null | undefined;
  service: string | undefined;
  /** A published-port link already opens the application link, so it is not repeated. */
  applicationLinkShown: boolean;
}

/**
 * Links and diagnostics declared for a service with `io.sencho.*` labels: the
 * named links, the application link when no published port carries it, and a
 * quiet count of labels Sencho ignored. Every anchor target was validated by
 * the node and is checked again on read.
 */
export function ServiceSenchoLinks({ resolution, service, applicationLinkShown }: ServiceSenchoLinksProps) {
  const application = applicationLinkShown ? undefined : applicationLink(resolution, service);
  const named = namedLinks(resolution, service);
  const ignored = ignoredLabels(resolution, service);
  const unverified = unverifiedLinkCount(resolution, service);
  const notShown = ignored.length + unverified;
  if (!application && named.length === 0 && notShown === 0) return null;

  return (
    <div className="flex min-w-0 max-w-full flex-wrap items-center gap-x-3 gap-y-0.5 font-mono text-[11px]" data-testid="service-sencho-links">
      {application && (
        <a href={application.url} target="_blank" rel="noopener noreferrer" title={application.url} className={LINK_CLASS}>
          <span className="min-w-0 truncate">{hostOf(application.url)}</span>
          <ArrowUpRight className="h-3 w-3 shrink-0" strokeWidth={1.5} />
        </a>
      )}
      {named.map(link => (
        <a key={link.name} href={link.url} target="_blank" rel="noopener noreferrer" title={link.url} className={LINK_CLASS}>
          <span className="min-w-0 truncate">{link.name}</span>
          <ArrowUpRight className="h-3 w-3 shrink-0" strokeWidth={1.5} />
        </a>
      ))}
      {notShown > 0 && (
        <span
          className="text-warning"
          title={[
            ...ignored.map(entry => `${entry.key}: ${entry.reason ?? 'ignored'}`),
            ...(unverified > 0 ? [`${unverified} link${unverified === 1 ? '' : 's'} this version of Sencho could not verify`] : []),
          ].join('\n')}
          data-testid="service-sencho-ignored"
        >
          {notShown} Sencho label{notShown === 1 ? '' : 's'} ignored
        </span>
      )}
    </div>
  );
}
