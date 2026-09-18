import {
  parseHttpsRepoUrl,
  parseLegacyRepoUrl,
  serializeRepoIdentity,
  type RepoIdentity,
} from '../repoIdentity';
import type { GitProviderKind } from './types';

function identityFromUrl(url: string): RepoIdentity | null {
  const parsed = parseHttpsRepoUrl(url);
  if (parsed.ok) return serializeRepoIdentity(parsed.url);
  const legacy = parseLegacyRepoUrl(url);
  if (!legacy.ok) return null;
  return serializeRepoIdentity(legacy.url);
}

function eventActionFromBody(body: Record<string, unknown>): string | null {
  return typeof body.action === 'string' ? body.action : null;
}

export type ParsedProviderPayload = {
  eventType: string;
  eventAction: string | null;
  repoIdentity: RepoIdentity | null;
  ref: string | null;
  candidateSha: string | null;
  pullRequestId: string | null;
};

function repoFromGithub(body: Record<string, unknown>): RepoIdentity | null {
  const repo = body.repository as { html_url?: string; clone_url?: string } | undefined;
  const url = repo?.html_url ?? repo?.clone_url;
  if (!url || typeof url !== 'string') return null;
  return identityFromUrl(url);
}

function repoFromGitlab(body: Record<string, unknown>): RepoIdentity | null {
  const project = body.project as { web_url?: string; http_url?: string } | undefined;
  const url = project?.web_url ?? project?.http_url;
  if (!url || typeof url !== 'string') return null;
  return identityFromUrl(url);
}

function repoFromGiteaFamily(body: Record<string, unknown>): RepoIdentity | null {
  const repo = body.repository as { html_url?: string; clone_url?: string } | undefined;
  const url = repo?.html_url ?? repo?.clone_url;
  if (!url || typeof url !== 'string') return null;
  return identityFromUrl(url);
}

function repoFromBitbucket(body: Record<string, unknown>): RepoIdentity | null {
  const repo = body.repository as { links?: { html?: { href?: string } } } | undefined;
  const url = repo?.links?.html?.href;
  if (!url || typeof url !== 'string') return null;
  return identityFromUrl(url);
}

export function parseProviderPayload(
  provider: GitProviderKind,
  body: Record<string, unknown>,
  eventTypeHeader: string | undefined,
): ParsedProviderPayload | null {
  switch (provider) {
    case 'github': {
      const eventType = (eventTypeHeader ?? (typeof body.zen === 'string' ? 'ping' : '')).toLowerCase();
      const ref = typeof body.ref === 'string' ? body.ref : null;
      const after = typeof body.after === 'string' ? body.after : null;
      const pr = body.pull_request as { number?: number } | undefined;
      return {
        eventType,
        eventAction: eventActionFromBody(body),
        repoIdentity: repoFromGithub(body),
        ref,
        candidateSha: after,
        pullRequestId: pr?.number !== undefined ? String(pr.number) : null,
      };
    }
    case 'gitlab': {
      const eventType = (eventTypeHeader ?? (typeof body.object_kind === 'string' ? body.object_kind : '')).toLowerCase();
      const ref = typeof body.ref === 'string' ? body.ref : null;
      const after = typeof body.after === 'string' ? body.after : null;
      const attrs = body.object_attributes as { action?: string; iid?: number } | undefined;
      return {
        eventType,
        eventAction: attrs?.action ?? null,
        repoIdentity: repoFromGitlab(body),
        ref,
        candidateSha: after,
        pullRequestId: attrs?.iid !== undefined ? String(attrs.iid) : null,
      };
    }
    case 'gitea':
    case 'forgejo': {
      const eventType = (eventTypeHeader ?? '').toLowerCase();
      const ref = typeof body.ref === 'string' ? body.ref : null;
      const after = typeof body.after === 'string' ? body.after : null;
      const pr = body.pull_request as { number?: number } | undefined;
      return {
        eventType,
        eventAction: eventActionFromBody(body),
        repoIdentity: repoFromGiteaFamily(body),
        ref,
        candidateSha: after,
        pullRequestId: pr?.number !== undefined ? String(pr.number) : null,
      };
    }
    case 'bitbucket_cloud': {
      const eventType = (eventTypeHeader ?? (typeof body.eventKey === 'string' ? body.eventKey : '')).toLowerCase();
      const push = body.push as { changes?: Array<{ new?: { name?: string; target?: { hash?: string } } }> } | undefined;
      const change = push?.changes?.[0];
      const ref = change?.new?.name ? `refs/heads/${change.new.name}` : null;
      const candidateSha = change?.new?.target?.hash ?? null;
      return {
        eventType,
        eventAction: null,
        repoIdentity: repoFromBitbucket(body),
        ref,
        candidateSha,
        pullRequestId: null,
      };
    }
    default:
      return null;
  }
}

export function refsMatchConfigured(configuredRef: string, eventRef: string | null): boolean {
  if (!eventRef) return false;
  const normConfigured = configuredRef.replace(/^refs\/(heads|tags)\//, '');
  const normEvent = eventRef.replace(/^refs\/(heads|tags)\//, '');
  return normConfigured === normEvent || eventRef === configuredRef;
}

export function isPingEvent(eventType: string): boolean {
  const t = eventType.toLowerCase();
  return t === 'ping' || t === 'pong' || t === 'hook';
}

export function isPushLikeEvent(provider: GitProviderKind, eventType: string): boolean {
  const t = eventType.toLowerCase();
  if (provider === 'gitlab') return t === 'push' || t === 'tag_push';
  if (provider === 'bitbucket_cloud') return t.includes('repo:push');
  return t === 'push' || t === 'create' || t === 'delete';
}

export function isPullRequestLikeEvent(provider: GitProviderKind, eventType: string): boolean {
  const t = eventType.toLowerCase();
  if (provider === 'gitlab') return t === 'merge_request';
  if (provider === 'bitbucket_cloud') return t.includes('pullrequest');
  return t === 'pull_request';
}

const ACTIONABLE_PR_ACTIONS = new Set([
  'open',
  'opened',
  'reopen',
  'reopened',
  'synchronize',
  'synchronized',
  'update',
  'updated',
  'close',
  'closed',
  'merge',
  'merged',
]);

/** PR sub-actions that can change the configured ref. Providers that omit an action still queue. */
export function isActionablePullRequestAction(action: string | null): boolean {
  return !action || ACTIONABLE_PR_ACTIONS.has(action.toLowerCase());
}
