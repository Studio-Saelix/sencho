/**
 * Shared helpers for seeding server-backed per-user preferences in E2E tests.
 *
 * The preference API is identity-guarded: every request carries the
 * x-sencho-pref-user header, which the server compares against the
 * authenticated user. Helpers accept any authenticated APIRequestContext:
 * the per-test `request` fixture after its own login, or `page.request`
 * (which shares the browser context's auth cookie).
 */
import type { APIRequestContext } from '@playwright/test';
import { request as pwRequest } from '@playwright/test';
import { TEST_USERNAME, TEST_PASSWORD } from './helpers';

/** The full 16-field appearance document the server schema validates. */
export const APPEARANCE_DOC = {
  theme: 'oled', accent: 'violet', uiFont: 'Geist', monoFont: 'Geist Mono',
  visualStyle: 'calm', headingStyle: 'clean', chartStyle: 'muted',
  density: 'compact', logChipColorMode: 'unified',
  borderBoost: 0, glow: 0.16, contrast: 0, typeScale: 1,
  reducedEffects: true, reducedMotion: true, readability: false,
};

/** The four-field navigation document. */
export const NAVIGATION_DOC = {
  mode: 'compact', quickLinks: ['dashboard', 'networking', 'auto-updates'], labels: true, align: 'left',
};

export interface PreferenceEnvelope {
  schemaVersion: number;
  revision: number;
  updatedAt: number;
  data?: Record<string, unknown>;
  corrupt?: boolean;
}

/** A PUT response body: a live-document envelope without schemaVersion (the
 *  write path always produces a v1 live document, and the field is server
 *  metadata the writer does not echo). */
export interface PutResponseEnvelope {
  domain: string;
  revision: number;
  updatedAt: number;
  data: Record<string, unknown>;
}

export function prefHeaders(userId: number): Record<string, string> {
  return { 'x-sencho-pref-user': String(userId) };
}

/** The authenticated user's numeric id (from the session the request carries). */
export async function currentUserId(request: APIRequestContext): Promise<number> {
  const res = await request.get('/api/auth/check');
  if (!res.ok()) throw new Error(`auth/check failed with ${res.status()}`);
  const body = (await res.json()) as { user?: { userId?: number } };
  const userId = body.user?.userId;
  if (typeof userId !== 'number') throw new Error('auth/check returned no numeric userId');
  return userId;
}

/**
 * Create (or reuse) a dedicated suite account, so the suite's preference rows
 * are isolated from the shared admin account and from other suites. Returns
 * the account id; use `deleteE2EUser` in afterAll. Defaults to viewer (the
 * account must never mutate stacks, only its own preference rows); pass a
 * role when the behavior under test needs that role's reachable views (the
 * Smart bar's More group exists only where overflow-classified views survive
 * the role filter).
 */
export async function ensureE2EUser(
  request: APIRequestContext,
  username: string,
  password: string,
  role: 'admin' | 'viewer' = 'viewer',
): Promise<number> {
  const existing = await request.get('/api/users');
  if (existing.ok()) {
    const users = (await existing.json()) as Array<{ id: number; username: string }>;
    const found = users.find((u) => u.username === username);
    if (found) return found.id;
  }
  const create = await request.post('/api/users', {
    data: { username, password, role },
  });
  if (!create.ok()) throw new Error(`create ${username} failed with ${create.status()}`);
  const body = (await create.json()) as { id: number };
  return body.id;
}

/** Delete a dedicated suite account (best effort; the suite is over either way). */
export async function deleteE2EUser(request: APIRequestContext, userId: number): Promise<void> {
  await request.delete(`/api/users/${userId}`).catch(() => undefined);
}

/** Read both domain envelopes for the user (identity-guarded GET). */
export async function getPreferences(request: APIRequestContext, userId: number): Promise<{
  preferences: Record<string, PreferenceEnvelope | null>;
}> {
  const res = await request.get('/api/user-preferences', { headers: prefHeaders(userId) });
  if (!res.ok()) throw new Error(`GET preferences failed with ${res.status()}`);
  return (await res.json()) as { preferences: Record<string, PreferenceEnvelope | null> };
}

/**
 * Write a full domain document as a known baseline. The row's current revision
 * is read first, so the conditional PUT always targets it; a 409 is retried
 * because a concurrent boot migration can move the revision between the read
 * and the write.
 */
export async function putDomain(
  request: APIRequestContext,
  userId: number,
  domain: 'appearance' | 'navigation',
  doc: Record<string, unknown>,
): Promise<PutResponseEnvelope> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const rows = await getPreferences(request, userId);
    const row = rows.preferences[domain];
    const res = await request.put(`/api/user-preferences/${domain}`, {
      headers: prefHeaders(userId),
      data: row
        ? { expectedRevision: row.revision, ...doc }
        : { absent: true, ...doc },
    });
    if (res.ok()) return (await res.json()) as PutResponseEnvelope;
    if (res.status() !== 409) throw new Error(`PUT ${domain} failed with ${res.status()}`);
  }
  throw new Error(`PUT ${domain} kept conflicting after 3 attempts`);
}

/**
 * A suite-owned request context logged in as its own account, so suites that
 * need an appearance/navigation baseline can seed it without touching the
 * shared admin's rows. `disposePrefUser` cleans both up.
 */
export interface PrefUserContext {
  request: APIRequestContext;
  userId: number;
}

export async function seedPrefUser(
  username: string,
  password: string,
  role: 'admin' | 'viewer' = 'viewer',
): Promise<PrefUserContext> {
  const admin = await pwRequest.newContext({ baseURL: 'http://localhost:5173' });
  const login = await admin.post('/api/auth/login', {
    data: { username: TEST_USERNAME, password: TEST_PASSWORD },
  });
  if (!login.ok()) throw new Error(`admin login failed with ${login.status()}`);
  const userId = await ensureE2EUser(admin, username, password, role);
  await admin.dispose();

  const request = await pwRequest.newContext({ baseURL: 'http://localhost:5173' });
  const suiteLogin = await request.post('/api/auth/login', {
    data: { username, password },
  });
  if (!suiteLogin.ok()) throw new Error(`login ${username} failed with ${suiteLogin.status()}`);
  return { request, userId: await currentUserId(request) };
}

export async function disposePrefUser(
  ctx: PrefUserContext | undefined,
  admin: APIRequestContext | undefined,
): Promise<void> {
  if (ctx && admin) await deleteE2EUser(admin, ctx.userId).catch(() => undefined);
  if (ctx) await ctx.request.dispose().catch(() => undefined);
  if (admin) await admin.dispose().catch(() => undefined);
}

/**
 * An admin request context for suite-account lifecycle (create/delete users).
 */
export async function adminApiContext(): Promise<APIRequestContext> {
  const admin = await pwRequest.newContext({ baseURL: 'http://localhost:5173' });
  const login = await admin.post('/api/auth/login', {
    data: { username: TEST_USERNAME, password: TEST_PASSWORD },
  });
  if (!login.ok()) throw new Error(`admin login failed with ${login.status()}`);
  return admin;
}
