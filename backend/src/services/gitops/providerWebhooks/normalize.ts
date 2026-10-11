import {
  canonicalRepoKey,
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
      // GitLab's X-Gitlab-Event header is a display label ("Push Hook",
      // "Merge Request Hook"); the payload's object_kind is the canonical id,
      // with the label normalized as a fallback when it is absent.
      const headerEvent = eventTypeHeader?.trim().toLowerCase().replace(/\s+hook$/, '').replace(/\s+/g, '_');
      const eventType = (typeof body.object_kind === 'string' && body.object_kind
        ? body.object_kind
        : headerEvent ?? '').toLowerCase();
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

/**
 * Whether a delivery names the repository its endpoint's source is configured for.
 *
 * This is the repository counterpart to `refsMatchConfigured`, and it has to be
 * looser than the configured string for the same reason that one is: the operator
 * writes one spelling and the provider sends another. A stored `https` clone URL
 * with a `.git` suffix against a provider `html_url` without one is not an edge
 * case, it is what every push to a source configured that way looks like, and
 * reading it as a different repository silently dropped the delivery while the
 * source kept polling as if no webhook existed. Transport differs for the same
 * reason: a source with a deploy key is configured with an ssh URL, and the
 * provider only ever sends an `https` one.
 *
 * The comparison is the canonical repository key, so those spellings collapse
 * instead of being normalized at each site. The pathname is case-folded before
 * the key is built, which `canonicalRepoKey` deliberately does not do, and the
 * fold has to happen before the `.git` suffix is stripped rather than after the
 * key is finished, or `repo.GIT` would fold to `repo.git` and match neither
 * `repo` nor `repo.git`.
 *
 * The fold stays local because the two consumers carry opposite risks. Folding
 * in the Blueprint claim guard would add refusals: it would merge two paths that
 * a case-sensitive host can hold as genuinely different repositories, so the
 * second claim would be rejected. Here, an endpoint already binds exactly one
 * source and the delivery has passed signature verification for that endpoint's
 * secret, so the check reads a signed statement about the endpoint's own
 * repository rather than looking a repository up.
 *
 * Folding path case is a deliberate trade. Providers send the case they have
 * stored, and nothing requires the operator to have configured that same case,
 * so exact path case would reinstate the silent drop this function exists to
 * fix. On a self-hosted forge that treats paths case-sensitively and happens to
 * host two repositories differing only in path case, a delivery for one is
 * accepted on the other's endpoint, and the consequence is bounded: the pull
 * that follows uses the configured source URL, never the delivered one, so it
 * costs a reconciliation of the configured repository, not content from the
 * other one. The key also drops the port, so two repositories on different
 * ports of one host with the same path merge the same way, under the same
 * bound.
 *
 * An identity that names no repository on either side is a refusal, never a match:
 * an unparseable URL must not read as "same repository".
 */
export function deliveryRepoMatchesConfigured(
  delivered: RepoIdentity,
  configured: RepoIdentity,
): boolean {
  const deliveredKey = canonicalRepoKey({
    host: delivered.host,
    pathname: delivered.pathname.toLowerCase(),
  });
  const configuredKey = canonicalRepoKey({
    host: configured.host,
    pathname: configured.pathname.toLowerCase(),
  });
  if (deliveredKey === null || configuredKey === null) return false;
  return deliveredKey === configuredKey;
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
