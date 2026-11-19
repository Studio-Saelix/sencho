import { redactSensitiveText } from '../../utils/safeLog';

/**
 * The one Cloudflare API client. Every public exposure slice calls Cloudflare
 * through it; none adds another.
 *
 * It owns the transport rules Cloudflare's API needs: the response envelope
 * (`success`, `errors`, `messages`, `result_info`), complete pagination with a
 * page cap, bounded retries with full jitter that honour `Retry-After`,
 * permanent non-429 4xx, a timeout for each attempt and for the caller's
 * whole operation, refused redirects, and a process-wide request budget.
 *
 * The token is sent only in the Authorization header. It is never stored on an
 * error, logged, or echoed into a message.
 */

export const CLOUDFLARE_API_BASE = 'https://api.cloudflare.com/client/v4';

const MAX_ATTEMPTS = 3;
const ATTEMPT_TIMEOUT_MS = 10_000;
const RETRY_AFTER_CAP_MS = 20_000;
const BACKOFF_BASE_MS = 500;
const MAX_PAGES = 100;
const MAX_MESSAGE_LENGTH = 300;
/** A quarter of Cloudflare's 1200 requests per 5 minutes per user, leaving room for the operator's own tools. */
const BUDGET_LIMIT = 300;
const BUDGET_WINDOW_MS = 5 * 60_000;

/** Connection errors raised before a request reached Cloudflare, so a POST can be retried safely. */
const PRE_SEND_ERROR_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT']);

export type CloudflareErrorKind =
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'bad_request'
  | 'rate_limited'
  | 'server'
  | 'network'
  | 'timeout'
  | 'invalid_response'
  | 'budget_exhausted';

/** A failed Cloudflare call. Holds no request header or body, so it is safe to log through errorMessageForLog. */
export class CloudflareApiError extends Error {
  readonly kind: CloudflareErrorKind;
  readonly status: number | null;
  readonly cfCodes: number[];
  readonly retryAfterSeconds?: number;
  /** True only for a connection error raised before the request was sent. */
  readonly preSend: boolean;

  constructor(init: {
    kind: CloudflareErrorKind;
    message: string;
    status?: number | null;
    cfCodes?: number[];
    retryAfterSeconds?: number;
    preSend?: boolean;
  }) {
    super(init.message);
    this.name = 'CloudflareApiError';
    this.kind = init.kind;
    this.status = init.status ?? null;
    this.cfCodes = init.cfCodes ?? [];
    this.retryAfterSeconds = init.retryAfterSeconds;
    this.preSend = init.preSend ?? false;
  }
}

export type CloudflareMethod = 'GET' | 'POST' | 'DELETE';

export interface CloudflareResultInfo {
  page?: number;
  per_page?: number;
  total_pages?: number;
  count?: number;
  total_count?: number;
}

export interface CloudflareResponse<T> {
  result: T;
  resultInfo: CloudflareResultInfo | null;
  messages: string[];
}

export interface CloudflareCallOptions {
  /** The caller's operation signal. An aborted signal ends the call; no retry wait outlives it. */
  signal?: AbortSignal;
  /** Epoch ms the caller's operation must finish by; no retry wait runs past it. */
  deadlineAt?: number;
}

export interface CloudflareRequest extends CloudflareCallOptions {
  method: CloudflareMethod;
  path: string;
  query?: Record<string, string | number | boolean>;
  body?: unknown;
}

export interface CloudflareClientDeps {
  fetchImpl?: typeof fetch;
  now?: () => number;
  random?: () => number;
}

interface CloudflareEnvelope {
  success: boolean;
  errors?: Array<{ code?: unknown; message?: unknown }>;
  messages?: Array<{ message?: unknown } | string>;
  result?: unknown;
  result_info?: CloudflareResultInfo;
}

function isEnvelope(value: unknown): value is CloudflareEnvelope {
  return typeof value === 'object' && value !== null && typeof (value as { success?: unknown }).success === 'boolean';
}

/** Remove the token (if Cloudflare ever echoed it) and any credential-looking text, then bound the length. */
function safeMessage(text: string, token: string): string {
  const withoutToken = token ? text.split(token).join('[redacted]') : text;
  const redacted = redactSensitiveText(withoutToken);
  return redacted.length > MAX_MESSAGE_LENGTH ? `${redacted.slice(0, MAX_MESSAGE_LENGTH)}...` : redacted;
}

function envelopeErrors(envelope: CloudflareEnvelope | null): { codes: number[]; text: string } {
  const errors = Array.isArray(envelope?.errors) ? envelope.errors : [];
  const codes = errors.map((e) => (typeof e.code === 'number' ? e.code : Number.NaN)).filter((c) => Number.isFinite(c));
  const text = errors.map((e) => (typeof e.message === 'string' ? e.message : '')).filter(Boolean).join('; ');
  return { codes, text };
}

/** `Retry-After` as seconds or as an HTTP date; null when absent or unreadable. */
export function parseRetryAfter(header: string | null, now: number): number | null {
  if (!header) return null;
  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return null;
  return Math.max(0, Math.ceil((date - now) / 1000));
}

function kindForStatus(status: number): CloudflareErrorKind {
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'server';
  return 'bad_request';
}

function errorCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string') return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

function isRedirectRefusal(error: unknown): boolean {
  const cause = (error as { cause?: { message?: unknown } }).cause;
  return typeof cause?.message === 'string' && /redirect/i.test(cause.message);
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new CloudflareApiError({ kind: 'timeout', message: 'The Cloudflare operation was cancelled or ran out of time.' }));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new CloudflareApiError({ kind: 'timeout', message: 'The Cloudflare operation was cancelled or ran out of time.' }));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** The body text, or a rejection as soon as the signal aborts (a stalled body never outlives its timer). */
function readBody(response: Response, signal: AbortSignal): Promise<string> {
  if (signal.aborted) return Promise.reject(new Error('aborted'));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new Error('aborted'));
    signal.addEventListener('abort', onAbort, { once: true });
    response.text().then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

export class CloudflareApiClient {
  private readonly fetchImpl: () => typeof fetch;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly sentAt: number[] = [];

  constructor(deps: CloudflareClientDeps = {}) {
    // Resolved per call so a test that stubs the global fetch reaches the shared client.
    this.fetchImpl = () => deps.fetchImpl ?? globalThis.fetch;
    this.now = deps.now ?? Date.now;
    this.random = deps.random ?? (() => Math.random());
  }

  /** Forget the request budget. Tests only. */
  resetBudgetForTests(): void {
    this.sentAt.length = 0;
  }

  async request<T>(token: string, req: CloudflareRequest): Promise<CloudflareResponse<T>> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.attempt<T>(token, req);
      } catch (error: unknown) {
        if (!(error instanceof CloudflareApiError)) throw error;
        const wait = this.retryWait(error, req, attempt);
        if (wait === null) throw error;
        await abortableSleep(wait, req.signal);
      }
    }
  }

  /** Every page of a listing, or a throw. Never a partial list. */
  async paginate<T>(
    token: string,
    path: string,
    query: Record<string, string | number | boolean> = {},
    perPage = 50,
    options: CloudflareCallOptions = {},
  ): Promise<T[]> {
    const items: T[] = [];
    for (let page = 1; ; page += 1) {
      if (page > MAX_PAGES) {
        throw new CloudflareApiError({ kind: 'invalid_response', message: `Cloudflare listed more than ${MAX_PAGES} pages; Sencho stopped reading.` });
      }
      const response = await this.request<unknown>(token, {
        ...options,
        method: 'GET',
        path,
        query: { ...query, page, per_page: perPage },
      });
      if (!Array.isArray(response.result)) {
        throw new CloudflareApiError({ kind: 'invalid_response', message: 'Cloudflare answered a listing without a list.' });
      }
      items.push(...(response.result as T[]));
      const totalPages = response.resultInfo?.total_pages;
      if (typeof totalPages === 'number') {
        if (page >= totalPages) return items;
      } else if (response.result.length < perPage) {
        return items;
      } else {
        throw new CloudflareApiError({ kind: 'invalid_response', message: 'Cloudflare answered a full page without paging details.' });
      }
    }
  }

  /** Milliseconds to wait before the next attempt, or null when the error is final. */
  private retryWait(error: CloudflareApiError, req: CloudflareRequest, attempt: number): number | null {
    // A cancelled or expired operation is final; retrying would only report a different error.
    if (attempt >= MAX_ATTEMPTS || req.signal?.aborted) return null;
    const remaining = req.deadlineAt === undefined ? Number.POSITIVE_INFINITY : req.deadlineAt - this.now();
    let wait: number;
    if (error.kind === 'rate_limited') {
      wait = error.retryAfterSeconds !== undefined
        ? error.retryAfterSeconds * 1000
        : this.random() * BACKOFF_BASE_MS * 2 ** (attempt - 1);
      if (wait > RETRY_AFTER_CAP_MS) return null;
    } else {
      const idempotent = req.method !== 'POST';
      const transient = error.kind === 'server' || error.kind === 'network' || error.kind === 'timeout';
      if (!transient) return null;
      // A POST that may have reached Cloudflare is never repeated: the record may exist.
      if (!idempotent && !error.preSend) return null;
      wait = this.random() * BACKOFF_BASE_MS * 2 ** (attempt - 1);
    }
    return wait < remaining ? wait : null;
  }

  private takeBudget(): void {
    const now = this.now();
    while (this.sentAt.length > 0 && this.sentAt[0] <= now - BUDGET_WINDOW_MS) this.sentAt.shift();
    if (this.sentAt.length >= BUDGET_LIMIT) {
      const retryAfterSeconds = Math.max(1, Math.ceil((this.sentAt[0] + BUDGET_WINDOW_MS - now) / 1000));
      throw new CloudflareApiError({ kind: 'budget_exhausted', message: "Sencho's own Cloudflare request limit was reached.", retryAfterSeconds });
    }
    this.sentAt.push(now);
  }

  private buildUrl(path: string, query?: Record<string, string | number | boolean>): string {
    const url = new URL(`${CLOUDFLARE_API_BASE}${path}`);
    for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, String(value));
    return url.toString();
  }

  private async attempt<T>(token: string, req: CloudflareRequest): Promise<CloudflareResponse<T>> {
    if (req.signal?.aborted) {
      // Nothing was sent, so a POST that stops here created nothing.
      throw new CloudflareApiError({ kind: 'timeout', message: 'The Cloudflare operation was cancelled or ran out of time.', preSend: true });
    }
    this.takeBudget();
    const attemptController = new AbortController();
    const timer = setTimeout(() => attemptController.abort(), ATTEMPT_TIMEOUT_MS);
    const signal = req.signal ? AbortSignal.any([req.signal, attemptController.signal]) : attemptController.signal;
    try {
      const response = await this.send(req, token, signal, attemptController.signal);
      // The body read stays under the same attempt timer as the headers.
      return await this.readResponse<T>(response, token, signal);
    } finally {
      clearTimeout(timer);
    }
  }

  private async send(req: CloudflareRequest, token: string, signal: AbortSignal, attemptSignal: AbortSignal): Promise<Response> {
    try {
      return await this.fetchImpl()(this.buildUrl(req.path, req.query), {
        method: req.method,
        redirect: 'error',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          ...(req.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: req.body !== undefined ? JSON.stringify(req.body) : undefined,
        signal,
      });
    } catch (error: unknown) {
      if (attemptSignal.aborted || req.signal?.aborted) {
        throw new CloudflareApiError({ kind: 'timeout', message: 'Cloudflare did not answer in time.' });
      }
      if (isRedirectRefusal(error)) {
        throw new CloudflareApiError({ kind: 'invalid_response', message: 'Cloudflare answered with a redirect, which Sencho does not follow.' });
      }
      const code = errorCode(error);
      throw new CloudflareApiError({
        kind: 'network',
        message: `Could not reach api.cloudflare.com${code ? ` (${code})` : ''}.`,
        preSend: code !== undefined && PRE_SEND_ERROR_CODES.has(code),
      });
    }
  }

  private async readResponse<T>(response: Response, token: string, signal: AbortSignal): Promise<CloudflareResponse<T>> {
    const status = response.status;
    if (status >= 300 && status < 400) {
      throw new CloudflareApiError({ kind: 'invalid_response', status, message: 'Cloudflare answered with a redirect, which Sencho does not follow.' });
    }
    let text: string;
    try {
      text = await readBody(response, signal);
    } catch {
      if (signal.aborted) throw new CloudflareApiError({ kind: 'timeout', status, message: 'Cloudflare did not finish its answer in time.' });
      throw new CloudflareApiError({ kind: 'network', status, message: 'The Cloudflare response was cut off.' });
    }
    let envelope: CloudflareEnvelope | null = null;
    try {
      const parsed: unknown = JSON.parse(text);
      if (isEnvelope(parsed)) envelope = parsed;
    } catch {
      envelope = null;
    }
    const { codes, text: errorText } = envelopeErrors(envelope);
    if (status === 429) {
      const retryAfter = parseRetryAfter(response.headers.get('retry-after'), this.now());
      throw new CloudflareApiError({
        kind: 'rate_limited',
        status,
        cfCodes: codes,
        message: 'Cloudflare is limiting requests.',
        retryAfterSeconds: retryAfter ?? undefined,
      });
    }
    if (status >= 500) {
      throw new CloudflareApiError({ kind: 'server', status, cfCodes: codes, message: safeMessage(errorText || `Cloudflare answered ${status}.`, token) });
    }
    if (!envelope) {
      throw new CloudflareApiError({ kind: 'invalid_response', status, message: 'Cloudflare sent a response Sencho could not read.' });
    }
    if (status >= 400 || !envelope.success) {
      throw new CloudflareApiError({
        kind: status >= 400 ? kindForStatus(status) : 'bad_request',
        status,
        cfCodes: codes,
        message: safeMessage(errorText || `Cloudflare refused the request (${status}).`, token),
      });
    }
    const messages = (envelope.messages ?? [])
      .map((m) => (typeof m === 'string' ? m : typeof m?.message === 'string' ? m.message : ''))
      .filter(Boolean)
      .map((m) => safeMessage(m, token));
    return { result: envelope.result as T, resultInfo: envelope.result_info ?? null, messages };
  }
}

/** The process-wide client; its request budget is shared by every caller. */
export const cloudflareApiClient = new CloudflareApiClient();
