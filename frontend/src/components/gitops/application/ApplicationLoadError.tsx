import { Button } from '@/components/ui/button';
import type { GitOpsApplicationError } from './useGitOpsApplication';

function errorCopy(error: GitOpsApplicationError): { title: string; line: string } {
  switch (error.kind) {
    case 'not_readable':
      return {
        title: 'This application is not available',
        line: 'It no longer exists, your account cannot read it, or its owning node is not reporting it right now.',
      };
    case 'invalid_link':
      return {
        title: 'This link does not point to a GitOps application',
        line: 'Open the application from the portfolio list instead.',
      };
    case 'unsupported':
      return {
        title: 'The owning node cannot show this application',
        line: `Its Sencho version cannot serve application reads; run the same version there as on this node (${error.message}).`,
      };
    case 'unreachable':
      return {
        title: 'The owning node did not answer',
        line: `The application's state is unknown until the node reports again (${error.message}).`,
      };
    case 'evidence_unavailable':
      return {
        title: 'Evidence for this application is unavailable',
        line: `Its owning node reports it, but not yet with state this node can read; retry once it reports again (${error.message}).`,
      };
    case 'failed':
      return { title: 'The application could not be read', line: error.message };
  }
}

export function ApplicationLoadError({ error, onRetry }: { error: GitOpsApplicationError; onRetry: () => void }) {
  const copy = errorCopy(error);
  return (
    <div data-testid="gitops-application-error" data-error={error.kind} className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
      <p className="font-heading text-xl text-stat-value">{copy.title}</p>
      <p className="max-w-md font-mono text-xs text-stat-subtitle">{copy.line}</p>
      {error.kind !== 'invalid_link' && error.kind !== 'unsupported' && (
        <Button variant="outline" size="sm" className="max-md:min-h-11" onClick={onRetry}>Retry</Button>
      )}
    </div>
  );
}
