import type { Agent, NotificationRoute } from '../services/DatabaseService';

export { cleanStackPatterns } from './stackPattern';

export const NOTIFICATION_CHANNEL_TYPES = ['discord', 'slack', 'webhook', 'apprise', 'ntfy'] as const;
export type NotificationChannelType = typeof NOTIFICATION_CHANNEL_TYPES[number];

/** Write payload for Apprise agents/routes (never public DTO fields). */
export type AppriseWriteConfig = { tags?: string } | { urls: string };

/** Persisted JSON shape after normalize (keyed empty is `{}`). */
export type AppriseStoredConfig = { tags?: string } | { urls: string };

export type PublicAppriseConfig = {
  mode: 'keyed' | 'stateless';
  tags?: string;
  has_urls: boolean;
  providers?: string[];
  url_count?: number;
};

export type PublicAgent = Omit<Agent, 'config' | 'type'> & {
  type: NotificationChannelType;
  config: PublicAppriseConfig | null;
  /** True only when Apprise masking was applied; Discord/Slack/webhook still return raw URLs. */
  secrets_redacted: boolean;
};

export type PublicNotificationRoute = Omit<NotificationRoute, 'config' | 'channel_type'> & {
  channel_type: NotificationChannelType;
  config: PublicAppriseConfig | null;
  secrets_redacted: boolean;
};

/** Apprise notify key: 1–128 alphanumeric, underscore, or dash (official API notes). */
export const APPRISE_NOTIFY_KEY = /^[A-Za-z0-9_-]{1,128}$/;

export type ParsedAppriseConfig =
  | { ok: true; mode: 'keyed'; tags?: string }
  | { ok: true; mode: 'stateless'; urls: string[]; urlsJoined: string }
  | { ok: false; reason: string };

const APPRISE_SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const KEYED_KEYS = new Set(['tags']);
const STATELESS_KEYS = new Set(['urls']);
const INVALID_STORED = 'Apprise configuration is missing or invalid';

/** Path segment after `/notify/` when the path is `/notify/{key}` (key not yet validated). */
function notifyKeyFromPath(path: string): string | null {
  const match = path.match(/^\/notify\/([^/]+)$/);
  return match ? match[1] : null;
}

export function validateHttpsUrl(value: unknown): string | null {
  if (!value || typeof value !== 'string' || !value.startsWith('https://')) return 'must be a valid HTTPS URL';
  try { new URL(value); } catch { return 'is not a valid URL'; }
  return null;
}

export function classifyAppriseEndpoint(endpoint: string): 'keyed' | 'stateless' | null {
  try {
    const path = new URL(endpoint).pathname.replace(/\/$/, '');
    const key = notifyKeyFromPath(path);
    if (key !== null) return APPRISE_NOTIFY_KEY.test(key) ? 'keyed' : null;
    if (path === '/notify') return 'stateless';
    return null;
  } catch {
    return null;
  }
}

/** Thin classifier for tests; write validation uses validateNotificationChannel. */
export function classifyAppriseConfig(endpoint: string, config: unknown): { mode: 'keyed' | 'stateless'; urls?: string[] } | null {
  const mode = classifyAppriseEndpoint(endpoint);
  if (!mode) return null;
  if (mode === 'keyed') {
    if (config !== undefined && config !== null && (typeof config !== 'object' || Array.isArray(config))) return null;
    return { mode: 'keyed' };
  }
  if (!config || typeof config !== 'object' || Array.isArray(config)) return null;
  const urls = typeof (config as { urls?: unknown }).urls === 'string'
    ? splitServiceUrls((config as { urls: string }).urls)
    : [];
  return urls.length > 0 ? { mode: 'stateless', urls } : null;
}

export function isPublicAppriseConfigShape(config: unknown): boolean {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return false;
  const record = config as Record<string, unknown>;
  return 'has_urls' in record || 'providers' in record || 'url_count' in record || 'mode' in record || 'secrets_redacted' in record;
}

function unknownKeyError(record: Record<string, unknown>, allowed: Set<string>): string | null {
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) return `unknown Apprise config field: ${key}`;
  }
  return null;
}

function splitServiceUrls(urls: string): string[] {
  return urls.split(/[\s,]+/).map(url => url.trim()).filter(Boolean);
}

function validateServiceUrlToken(token: string): string | null {
  if (token.length > 2000) return 'Apprise service URLs must be 2000 characters or fewer';
  if (!APPRISE_SCHEME.test(token)) return 'each Apprise service URL must include a URI scheme';
  return null;
}

function asRecord(config: unknown): Record<string, unknown> | null {
  if (config === undefined || config === null) return {};
  if (typeof config !== 'object' || Array.isArray(config)) return null;
  return config as Record<string, unknown>;
}

/** Validates an ntfy server + topic URL. Allows http/https, rejects userinfo, fragments, and root paths. */
export function validateNtfyUrl(value: unknown): string | null {
  if (!value || typeof value !== 'string') return 'must be a valid ntfy URL';
  let parsed: URL;
  try { parsed = new URL(value); } catch { return 'is not a valid URL'; }
  if (!['http:', 'https:'].includes(parsed.protocol)) return 'must use HTTP or HTTPS';
  if (!parsed.host) return 'must include a host';
  if (parsed.username || parsed.password) return 'must not include credentials in the URL';
  if (parsed.hash) return 'must not include a fragment';
  const path = parsed.pathname.replace(/\/$/, '');
  if (!path || path === '/') return 'must include a topic path (e.g. /mytopic)';
  return null;
}

export function validateNotificationChannel(type: unknown, url: unknown, config?: unknown): string | null {
  if (typeof type !== 'string' || !(NOTIFICATION_CHANNEL_TYPES as readonly string[]).includes(type)) {
    return `type must be ${NOTIFICATION_CHANNEL_TYPES.join(', ')}`;
  }
  if (type === 'ntfy') return validateNtfyUrl(url);
  if (type !== 'apprise') return validateHttpsUrl(url);
  if (typeof url !== 'string') return 'must be a valid Apprise URL';
  let parsed: URL;
  try { parsed = new URL(url); } catch { return 'is not a valid URL'; }
  if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.host || parsed.username || parsed.password || parsed.hash) {
    return 'must be an HTTP or HTTPS Apprise URL without credentials or a fragment';
  }
  if (isPublicAppriseConfigShape(config)) {
    return 'must use raw Apprise config ({ urls } or { tags }), not a public summary';
  }
  const path = parsed.pathname.replace(/\/$/, '');
  const notifyKey = notifyKeyFromPath(path);
  if (notifyKey !== null && !APPRISE_NOTIFY_KEY.test(notifyKey)) {
    return 'Apprise notify key must be 1–128 characters of letters, digits, underscore, or dash';
  }
  const mode = classifyAppriseEndpoint(url);
  if (!mode) return 'must use /notify or /notify/{key} with valid configuration';
  const record = asRecord(config);
  if (!record) return 'must use /notify or /notify/{key} with valid configuration';

  if (mode === 'keyed') {
    const keyErr = unknownKeyError(record, KEYED_KEYS);
    if (keyErr) return keyErr;
    if (record.urls !== undefined) return 'keyed Apprise endpoints cannot include urls';
    if (record.tags !== undefined && typeof record.tags !== 'string') return 'Apprise tags must be a string';
    return null;
  }

  const keyErr = unknownKeyError(record, STATELESS_KEYS);
  if (keyErr) return keyErr;
  if (record.tags !== undefined) return 'stateless Apprise endpoints cannot include tags';
  if (typeof record.urls !== 'string' || !record.urls.trim()) {
    return 'stateless Apprise endpoints require a nonempty urls string';
  }
  const urls = splitServiceUrls(record.urls);
  if (urls.length === 0) return 'stateless Apprise endpoints require a nonempty urls string';
  for (const token of urls) {
    const tokenErr = validateServiceUrlToken(token);
    if (tokenErr) return tokenErr;
  }
  return null;
}

/** Persist shape: keyed empty → `{}`; omit empty tags; stateless → `{ urls }`. */
export function normalizeAppriseStoredJson(endpoint: string, config: unknown): string {
  const mode = classifyAppriseEndpoint(endpoint);
  if (mode === 'keyed') {
    const record = asRecord(config) ?? {};
    const tags = typeof record.tags === 'string' ? record.tags.trim() : '';
    return tags ? JSON.stringify({ tags }) : '{}';
  }
  const record = asRecord(config) ?? {};
  const urls = typeof record.urls === 'string' ? record.urls.trim() : '';
  return JSON.stringify({ urls });
}

export function parseStoredAppriseConfig(endpoint: string, configJson: string | null | undefined): ParsedAppriseConfig {
  const mode = classifyAppriseEndpoint(endpoint);
  if (!mode) return { ok: false, reason: INVALID_STORED };

  if (configJson == null || configJson === '') {
    if (mode === 'keyed') return { ok: true, mode: 'keyed' };
    return { ok: false, reason: INVALID_STORED };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(configJson);
  } catch {
    return { ok: false, reason: INVALID_STORED };
  }

  const err = validateNotificationChannel('apprise', endpoint, parsed);
  if (err) return { ok: false, reason: INVALID_STORED };

  // validateNotificationChannel already confirmed parsed is a plain object
  // whose only fields match the mode (tags for keyed, urls for stateless),
  // so no further shape narrowing is needed here.
  if (mode === 'keyed') {
    const tags = typeof (parsed as { tags?: string }).tags === 'string' ? (parsed as { tags: string }).tags.trim() : '';
    return tags ? { ok: true, mode: 'keyed', tags } : { ok: true, mode: 'keyed' };
  }

  const urlsJoined = (parsed as { urls: string }).urls.trim();
  const urls = splitServiceUrls(urlsJoined);
  return { ok: true, mode: 'stateless', urls, urlsJoined };
}

export function storedAppriseToWriteConfig(parsed: Extract<ParsedAppriseConfig, { ok: true }>): AppriseWriteConfig {
  if (parsed.mode === 'keyed') {
    return parsed.tags ? { tags: parsed.tags } : {};
  }
  return { urls: parsed.urlsJoined };
}

/** Reconstruct the write config to preserve on an agent/route write that omits `config`. */
export function resolvePreservedAppriseConfig(
  endpoint: string,
  existingConfigJson: string | null | undefined,
): { ok: true; config: AppriseWriteConfig } | { ok: false; error: string } {
  const stored = parseStoredAppriseConfig(endpoint, existingConfigJson);
  if (!stored.ok) {
    return {
      ok: false,
      error: 'Stored Apprise configuration is invalid for this endpoint; provide a complete replacement',
    };
  }
  return { ok: true, config: storedAppriseToWriteConfig(stored) };
}

/**
 * Shared preserve-on-write guard for agent/route Apprise writes: blocks a
 * write that echoes a redacted public URL, config, or DTO shape back as raw
 * input. Identical across `agents.ts` POST and `notification-routes` PUT.
 */
export function redactedChannelWriteError(
  type: string,
  effectiveUrl: unknown,
  effectiveConfig: unknown,
  rawConfig: unknown,
): string | null {
  const configText = effectiveConfig === undefined ? '' : JSON.stringify(effectiveConfig) ?? '';
  if (
    (typeof effectiveUrl === 'string' && effectiveUrl.includes('<redacted>'))
    || configText.includes('<redacted>')
    || (type === 'apprise' && rawConfig !== undefined && isPublicAppriseConfigShape(rawConfig))
  ) {
    return 'Provide raw channel credentials to replace redacted values';
  }
  return null;
}

function providerSchemes(urls: string[]): string[] {
  const schemes: string[] = [];
  for (const value of urls) {
    if (!APPRISE_SCHEME.test(value)) continue;
    const scheme = value.split(':', 1)[0].toLowerCase();
    if (scheme && !schemes.includes(scheme)) schemes.push(scheme);
  }
  return schemes;
}

function publicAppriseConfig(url: string, config: string | null): PublicAppriseConfig | null {
  const parsed = parseStoredAppriseConfig(url, config);
  if (!parsed.ok) {
    console.warn(`[apprise] stored config unreadable for public DTO (${parsed.reason})`);
    return null;
  }
  if (parsed.mode === 'keyed') {
    return { mode: 'keyed', tags: parsed.tags, has_urls: false };
  }
  const providers = providerSchemes(parsed.urls);
  return {
    mode: 'stateless',
    has_urls: parsed.urls.length > 0,
    ...(providers.length > 0 ? { providers } : {}),
    url_count: parsed.urls.length,
  };
}

export function maskAppriseEndpoint(value: string): string {
  try {
    const parsed = new URL(value);
    const path = parsed.pathname.replace(/\/$/, '');
    const key = notifyKeyFromPath(path);
    if (key !== null && APPRISE_NOTIFY_KEY.test(key)) return `${parsed.origin}/notify/<redacted>`;
    return `${parsed.origin}/notify`;
  } catch {
    return '<invalid url>';
  }
}

export function serializePublicAgent(agent: Agent): PublicAgent {
  const isApprise = agent.type === 'apprise';
  return {
    ...agent,
    type: agent.type,
    url: isApprise ? maskAppriseEndpoint(agent.url) : agent.url,
    config: isApprise ? publicAppriseConfig(agent.url, agent.config ?? null) : null,
    secrets_redacted: isApprise,
  };
}

export function serializePublicNotificationRoute(route: NotificationRoute): PublicNotificationRoute {
  const isApprise = route.channel_type === 'apprise';
  return {
    ...route,
    channel_type: route.channel_type,
    channel_url: isApprise ? maskAppriseEndpoint(route.channel_url) : route.channel_url,
    config: isApprise ? publicAppriseConfig(route.channel_url, route.config ?? null) : null,
    secrets_redacted: isApprise,
  };
}

/**
 * Mask a channel webhook URL for logging. Discord/Slack/custom webhook URLs
 * embed their auth token in the path (and sometimes the query), so only the
 * origin is safe to emit. Returns `https://host/<redacted>` or a generic
 * placeholder if the value is not a parseable URL.
 */
export function maskWebhookUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) return '<no url>';
  try {
    const { origin, pathname, search } = new URL(value);
    const hasSecret = pathname !== '/' || search !== '';
    return hasSecret ? `${origin}/<redacted>` : origin;
  } catch {
    return '<invalid url>';
  }
}
