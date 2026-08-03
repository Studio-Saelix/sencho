import { isPermissionAction, type PermissionAction } from '../middleware/permissions';
import { isValidStackName } from '../utils/validation';

export type StackRouteClassify =
  | { kind: 'named-stack'; stackName: string; action: PermissionAction }
  | { kind: 'static' }
  | { kind: 'unknown-named' };

/** Static collection / create paths under /stacks (no stack-scoped resource). */
const STATIC_STACK_PATHS = new Set([
  '/stacks',
  '/stacks/',
  '/stacks/statuses',
  '/stacks/discovery',
  '/stacks/import/scan',
  '/stacks/import/move',
  '/stacks/bulk',
  '/stacks/from-git',
]);

/**
 * Exact relative suffixes under `/stacks/:name` mapped to the primary hub
 * pre-check action. Service-name paths are matched separately via regex.
 */
type SuffixRule = { method: string; suffix: string; action: PermissionAction };

const EXACT_SUFFIX_RULES: readonly SuffixRule[] = [
  // Read
  { method: 'GET', suffix: '', action: 'stack:read' },
  { method: 'GET', suffix: '/envs', action: 'stack:read' },
  { method: 'GET', suffix: '/env', action: 'stack:read' },
  { method: 'GET', suffix: '/project-env-files', action: 'stack:read' },
  { method: 'GET', suffix: '/project-env-files/candidates', action: 'stack:read' },
  { method: 'GET', suffix: '/dossier', action: 'stack:read' },
  { method: 'GET', suffix: '/containers', action: 'stack:read' },
  { method: 'GET', suffix: '/services', action: 'stack:read' },
  { method: 'GET', suffix: '/drift', action: 'stack:read' },
  { method: 'GET', suffix: '/preflight', action: 'stack:read' },
  { method: 'GET', suffix: '/missing-external-networks', action: 'stack:read' },
  { method: 'GET', suffix: '/preflight/acknowledgements', action: 'stack:read' },
  { method: 'GET', suffix: '/networking', action: 'stack:read' },
  { method: 'GET', suffix: '/storage', action: 'stack:read' },
  { method: 'GET', suffix: '/effective-anatomy', action: 'stack:read' },
  { method: 'GET', suffix: '/effective-services', action: 'stack:read' },
  { method: 'GET', suffix: '/env-inventory', action: 'stack:read' },
  { method: 'GET', suffix: '/label-inventory', action: 'stack:read' },
  { method: 'GET', suffix: '/exposure', action: 'stack:read' },
  { method: 'GET', suffix: '/update-readiness', action: 'stack:read' },
  { method: 'GET', suffix: '/rollback-readiness', action: 'stack:read' },
  { method: 'GET', suffix: '/health-gate', action: 'stack:read' },
  { method: 'GET', suffix: '/update-preview', action: 'stack:read' },
  { method: 'GET', suffix: '/backup', action: 'stack:read' },
  { method: 'GET', suffix: '/scan-status', action: 'stack:read' },
  { method: 'GET', suffix: '/file-roots', action: 'stack:read' },
  { method: 'GET', suffix: '/files', action: 'stack:read' },
  { method: 'GET', suffix: '/files/content', action: 'stack:read' },
  { method: 'GET', suffix: '/files/download', action: 'stack:read' },
  { method: 'GET', suffix: '/files/bulk-download', action: 'stack:read' },
  { method: 'GET', suffix: '/files/permissions', action: 'stack:read' },
  { method: 'GET', suffix: '/activity', action: 'stack:read' },
  { method: 'GET', suffix: '/git-source', action: 'stack:read' },

  // Edit
  { method: 'PUT', suffix: '', action: 'stack:edit' },
  { method: 'PUT', suffix: '/env', action: 'stack:edit' },
  { method: 'PUT', suffix: '/project-env-files', action: 'stack:edit' },
  { method: 'PUT', suffix: '/dossier', action: 'stack:edit' },
  { method: 'POST', suffix: '/drift/recheck', action: 'stack:read' },
  { method: 'POST', suffix: '/preflight/run', action: 'stack:read' },
  { method: 'POST', suffix: '/preflight/acknowledgements', action: 'stack:edit' },
  { method: 'PUT', suffix: '/exposure', action: 'stack:edit' },
  { method: 'POST', suffix: '/files/upload', action: 'stack:edit' },
  { method: 'PUT', suffix: '/files/content', action: 'stack:edit' },
  { method: 'DELETE', suffix: '/files', action: 'stack:edit' },
  { method: 'POST', suffix: '/files/folder', action: 'stack:edit' },
  { method: 'PATCH', suffix: '/files/rename', action: 'stack:edit' },
  { method: 'POST', suffix: '/files/copy', action: 'stack:edit' },
  { method: 'POST', suffix: '/files/bulk-delete', action: 'stack:edit' },
  { method: 'POST', suffix: '/files/bulk-move', action: 'stack:edit' },
  { method: 'PUT', suffix: '/files/permissions', action: 'stack:edit' },
  { method: 'PUT', suffix: '/labels', action: 'stack:edit' },
  { method: 'PUT', suffix: '/git-source', action: 'stack:edit' },
  { method: 'DELETE', suffix: '/git-source', action: 'stack:edit' },
  { method: 'POST', suffix: '/git-source/pull', action: 'stack:edit' },
  { method: 'POST', suffix: '/git-source/apply', action: 'stack:edit' },
  { method: 'POST', suffix: '/git-source/webhook-pull', action: 'stack:edit' },
  { method: 'POST', suffix: '/git-source/dismiss-pending', action: 'stack:edit' },
  { method: 'POST', suffix: '/git-source/browse', action: 'stack:edit' },

  // Deploy
  { method: 'POST', suffix: '/deploy', action: 'stack:deploy' },
  { method: 'POST', suffix: '/down', action: 'stack:deploy' },
  { method: 'POST', suffix: '/restart', action: 'stack:deploy' },
  { method: 'POST', suffix: '/stop', action: 'stack:deploy' },
  { method: 'POST', suffix: '/start', action: 'stack:deploy' },
  { method: 'POST', suffix: '/update-preview', action: 'stack:deploy' },
  { method: 'POST', suffix: '/update', action: 'stack:deploy' },
  { method: 'POST', suffix: '/rollback', action: 'stack:deploy' },
  { method: 'POST', suffix: '/backup', action: 'stack:deploy' },

  // Delete
  { method: 'DELETE', suffix: '', action: 'stack:delete' },
];

const EXACT_SUFFIX_INDEX = new Map<string, PermissionAction>(
  EXACT_SUFFIX_RULES.map((r) => [`${r.method} ${r.suffix}`, r.action]),
);

/** `/services/:serviceName/{restart|stop|start|update|restore|recovery}` */
const SERVICE_SUFFIX_RE =
  /^\/services\/[^/]+\/(restart|stop|start|update|restore|recovery)$/;

/** `/preflight/acknowledgements/:id` */
const PREFLIGHT_ACK_DELETE_RE = /^\/preflight\/acknowledgements\/[^/]+$/;

function normalizePath(pathAfterApiStrip: string): string {
  const withoutQuery = pathAfterApiStrip.split('?')[0] ?? pathAfterApiStrip;
  if (withoutQuery.length > 1 && withoutQuery.endsWith('/')) {
    return withoutQuery.slice(0, -1);
  }
  return withoutQuery;
}

function decodeStackSegment(raw: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return null;
  }
  if (!isValidStackName(decoded)) return null;
  return decoded;
}

/**
 * Classify a post-/api path for hub stack RBAC gating and evidence.
 * Paths outside `/stacks` and `/image-updates/refresh/` (and static
 * `/stacks` collection routes) are `static`. Known named-stack families
 * return the primary pre-check action. An unrecognized
 * `/stacks/<name>/...` path fails closed as `unknown-named`.
 */
export function classifyStackApiPath(method: string, pathAfterApiStrip: string): StackRouteClassify {
  const methodUpper = method.toUpperCase();
  const path = normalizePath(pathAfterApiStrip);

  if (!path.startsWith('/stacks') && !path.startsWith('/image-updates/refresh/')) {
    return { kind: 'static' };
  }

  if (STATIC_STACK_PATHS.has(path) || (methodUpper === 'POST' && path === '/stacks')) {
    return { kind: 'static' };
  }

  // Reserved first segments that look like names but are collection routes.
  if (
    path === '/stacks/statuses'
    || path === '/stacks/discovery'
    || path.startsWith('/stacks/import/')
    || path === '/stacks/bulk'
    || path === '/stacks/from-git'
  ) {
    return { kind: 'static' };
  }

  // /image-updates/refresh/:stackName → per-stack image check (stack:deploy).
  // This branch runs before the /stacks/-only regex, which would never match.
  // Unknown sub-paths under this prefix fail closed (unknown-named), matching
  // the fail-closed behavior for unknown /stacks/<name>/... paths.
  if (path.startsWith('/image-updates/refresh/')) {
    const imageRefreshMatch = /^\/image-updates\/refresh\/([^/]+)$/.exec(path);
    if (imageRefreshMatch) {
      const stackName = decodeStackSegment(imageRefreshMatch[1]);
      if (!stackName) return { kind: 'unknown-named' };
      return { kind: 'named-stack', stackName, action: 'stack:deploy' };
    }
    return { kind: 'unknown-named' };
  }

  const match = /^\/stacks\/([^/]+)(.*)$/.exec(path);
  if (!match) {
    return { kind: 'static' };
  }

  const stackName = decodeStackSegment(match[1]);
  if (!stackName) {
    return { kind: 'unknown-named' };
  }

  const suffix = match[2] ?? '';

  const exact = EXACT_SUFFIX_INDEX.get(`${methodUpper} ${suffix}`);
  if (exact) {
    return { kind: 'named-stack', stackName, action: exact };
  }

  if (methodUpper === 'POST' && SERVICE_SUFFIX_RE.test(suffix)) {
    const op = SERVICE_SUFFIX_RE.exec(suffix)?.[1];
    if (op === 'recovery') {
      // recovery is GET-only in stacks.ts; POST recovery is unknown
      return { kind: 'unknown-named' };
    }
    return { kind: 'named-stack', stackName, action: 'stack:deploy' };
  }

  if (methodUpper === 'GET' && /^\/services\/[^/]+\/recovery$/.test(suffix)) {
    return { kind: 'named-stack', stackName, action: 'stack:deploy' };
  }

  if (methodUpper === 'DELETE' && PREFLIGHT_ACK_DELETE_RE.test(suffix)) {
    return { kind: 'named-stack', stackName, action: 'stack:edit' };
  }

  return { kind: 'unknown-named' };
}

/**
 * Parse the comma-separated scoped-actions header. Returns null when empty
 * or when any token is not a known PermissionAction.
 */
export function parseScopedStackActionsHeader(value: string): PermissionAction[] | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parts = trimmed.split(',').map((p) => p.trim()).filter((p) => p.length > 0);
  if (parts.length === 0) return null;
  const actions: PermissionAction[] = [];
  const seen = new Set<PermissionAction>();
  for (const part of parts) {
    if (!isPermissionAction(part)) return null;
    if (seen.has(part)) continue;
    seen.add(part);
    actions.push(part);
  }
  return actions;
}

/** Serialize PermissionAction values for the scoped-actions proxy header. */
export function formatScopedStackActionsHeader(actions: Iterable<PermissionAction>): string {
  return [...new Set(actions)].join(',');
}
