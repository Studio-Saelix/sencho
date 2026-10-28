import type { ReactNode } from 'react';

import type { GitSource } from './GitSourcePanel';

const AUTH_LABEL: Record<GitSource['auth_type'], string> = {
  none: 'Public (no auth)',
  token: 'Personal access token',
  deploy_key: 'Deploy key (SSH)',
};

function Row({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div className="contents">
      <dt className="font-mono text-[10px] uppercase tracking-[0.14em] text-stat-subtitle">{term}</dt>
      <dd className="min-w-0 break-all font-mono text-xs text-foreground/90">{children}</dd>
    </div>
  );
}

/**
 * What a linked source is configured to do, read-only. Editing is a deliberate
 * step (the Edit button on the Source tab) so a sheet opened to look at a source
 * is not an open form. Secrets are never shown, only whether one is stored.
 */
export function GitSourceSummary({ source }: { source: GitSource }) {
  const composePaths = source.compose_paths?.length ? source.compose_paths : [source.compose_path];
  return (
    <dl data-testid="git-source-summary" className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2">
      <Row term="Repository">{source.repo_url}</Row>
      <Row term="Ref">{source.branch}</Row>
      <Row term={composePaths.length === 1 ? 'Compose file' : 'Compose files'}>
        {composePaths.map(path => <div key={path}>{path}</div>)}
      </Row>
      {source.context_dir && <Row term="Project directory">{source.context_dir}</Row>}
      <Row term="Sibling .env">{source.sync_env ? (source.env_path ?? 'synced') : 'not synced'}</Row>
      <Row term="Authentication">
        {AUTH_LABEL[source.auth_type]}
        {source.auth_type === 'token' && !source.has_token && ' (no token stored)'}
        {source.auth_type === 'deploy_key' && !source.has_deploy_key && ' (no key stored)'}
      </Row>
      {source.has_ca_bundle && <Row term="Custom CA">stored</Row>}
    </dl>
  );
}
