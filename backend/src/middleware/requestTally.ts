/**
 * TEMPORARY DIAGNOSTIC. Not for merge.
 *
 * Tallies requests per (route, rate-limit key) so a CI run can be mined for
 * which routes actually consume the globalApiLimiter budget. Mounted after
 * cookieParser (so the cookie is parsed and rateLimitKeyGenerator works) and
 * before globalApiLimiter (so rejected 429s are attributed to their route).
 *
 * Enabled only when SENCHO_REQUEST_TALLY=1. Prints a report every 60s and on
 * SIGTERM so the tail of the run is not lost.
 */
import type { NextFunction, Request, Response } from 'express';
import { rateLimitKeyGenerator } from './rateLimiters';

interface Bucket {
  total: number;
  byStatus: Map<number, number>;
  byKey: Map<string, number>;
  /** Requests per wall-clock minute, so a burst is visible and not averaged away. */
  byMinute: Map<number, number>;
}

const buckets = new Map<string, Bucket>();
let timer: NodeJS.Timeout | null = null;
let dirty = false;

/** Collapse path params so /api/stacks/foo counts with /api/stacks/bar. */
function routePattern(originalUrl: string): string {
  const path = originalUrl.split('?')[0];
  return path
    .split('/')
    .map((seg) => {
      if (/^\d+$/.test(seg)) return ':n';
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg)) return ':uuid';
      if (/^[0-9a-f]{32,}$/i.test(seg)) return ':hash';
      if (/^\d{10,}$/.test(seg)) return ':ts';
      return seg;
    })
    .join('/');
}

function report(): void {
  if (!dirty) return;
  dirty = false;
  const rows = [...buckets.entries()]
    .map(([pattern, b]) => {
      let peakMinute = 0;
      for (const n of b.byMinute.values()) if (n > peakMinute) peakMinute = n;
      return {
        pattern,
        total: b.total,
        peakMinute,
        statuses: [...b.byStatus.entries()].map(([s, n]) => `${s}:${n}`).join(' '),
        topKey: [...b.byKey.entries()].sort((a, c) => c[1] - a[1])[0]?.[0] ?? '-',
      };
    })
    .sort((a, b) => b.peakMinute - a.peakMinute || b.total - a.total)
    .slice(0, 40);
  console.log(
    `\n===== REQUEST TALLY (cumulative) =====\n${rows
      .map((r) => `${String(r.total).padStart(6)}  peak/min ${String(r.peakMinute).padStart(5)}  ${r.statuses.padEnd(16)} ${r.topKey.padEnd(22)} ${r.pattern}`)
      .join('\n')}\n===== END REQUEST TALLY =====\n`,
  );
}

export function requestTally(req: Request, res: Response, next: NextFunction): void {
  const pattern = `${req.method} ${routePattern(req.originalUrl)}`;
  res.on('finish', () => {
    let bucket = buckets.get(pattern);
    if (!bucket) {
      bucket = { total: 0, byStatus: new Map(), byKey: new Map(), byMinute: new Map() };
      buckets.set(pattern, bucket);
    }
    bucket.total += 1;
    dirty = true;
    bucket.byStatus.set(res.statusCode, (bucket.byStatus.get(res.statusCode) ?? 0) + 1);
    const minute = Math.floor(Date.now() / 60_000);
    bucket.byMinute.set(minute, (bucket.byMinute.get(minute) ?? 0) + 1);
    const key = rateLimitKeyGenerator(req);
    bucket.byKey.set(key, (bucket.byKey.get(key) ?? 0) + 1);
  });
  next();
}

export function startRequestTally(): void {
  // On by default under NODE_ENV=test (which is what CI runs), so the E2E job
  // needs no extra wiring. SENCHO_REQUEST_TALLY=1 forces it on elsewhere.
  const enabled = process.env.SENCHO_REQUEST_TALLY === '1' || process.env.NODE_ENV === 'test';
  if (!enabled) return;
  if (timer) return;
  timer = setInterval(report, 60_000);
  timer.unref();
  process.on('SIGTERM', report);
  process.on('SIGINT', report);
}
