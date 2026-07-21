/**
 * Weekly UTC maintenance windows for notification suppression rules.
 * days are start days (Date#getUTCDay); start inclusive, end exclusive.
 */

export interface NotificationSchedule {
  days: number[];
  start_minute: number;
  end_minute: number;
  tz: 'UTC';
}

export type ParseNotificationScheduleResult =
  | { ok: true; schedule: NotificationSchedule }
  | { ok: false; error: string };

const SCHEDULE_KEYS = new Set(['days', 'start_minute', 'end_minute', 'tz']);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Strict write-boundary parser. Accepts days in any order; returns sorted unique days. */
export function parseNotificationSchedule(raw: unknown): ParseNotificationScheduleResult {
  if (!isPlainObject(raw)) {
    return { ok: false, error: 'schedule must be an object or null' };
  }
  const keys = Object.keys(raw);
  if (keys.length !== 4 || keys.some((k) => !SCHEDULE_KEYS.has(k))) {
    return { ok: false, error: 'schedule must have exactly days, start_minute, end_minute, and tz' };
  }
  if (raw.tz !== 'UTC') {
    return { ok: false, error: 'schedule.tz must be UTC' };
  }
  if (!Array.isArray(raw.days) || raw.days.length === 0) {
    return { ok: false, error: 'schedule.days must be a nonempty array' };
  }
  if (raw.days.some((d) => typeof d !== 'number' || !Number.isInteger(d) || d < 0 || d > 6)) {
    return { ok: false, error: 'schedule.days must be integers 0..6' };
  }
  const days = [...new Set(raw.days as number[])].sort((a, b) => a - b);
  if (days.length !== raw.days.length) {
    return { ok: false, error: 'schedule.days must not contain duplicates' };
  }
  if (
    typeof raw.start_minute !== 'number'
    || !Number.isInteger(raw.start_minute)
    || raw.start_minute < 0
    || raw.start_minute > 1439
  ) {
    return { ok: false, error: 'schedule.start_minute must be an integer 0..1439' };
  }
  if (
    typeof raw.end_minute !== 'number'
    || !Number.isInteger(raw.end_minute)
    || raw.end_minute < 0
    || raw.end_minute > 1439
  ) {
    return { ok: false, error: 'schedule.end_minute must be an integer 0..1439' };
  }
  if (raw.start_minute === raw.end_minute) {
    return { ok: false, error: 'schedule.start_minute and end_minute must differ' };
  }
  return {
    ok: true,
    schedule: {
      days,
      start_minute: raw.start_minute,
      end_minute: raw.end_minute,
      tz: 'UTC',
    },
  };
}

/**
 * Parse a DB column value. Only SQL null / undefined → legacy null (always in window).
 * Empty string, whitespace, or any non-null corrupt value → invalid (must not suppress).
 */
export function parseStoredNotificationSchedule(
  raw: unknown,
): { kind: 'null' } | { kind: 'ok'; schedule: NotificationSchedule } | { kind: 'invalid' } {
  if (raw == null) return { kind: 'null' };
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed === '') return { kind: 'invalid' };
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return { kind: 'invalid' };
    }
    // JSON null is not SQL NULL; treat as corrupt rather than legacy always-on.
    if (parsed == null) return { kind: 'invalid' };
    const result = parseNotificationSchedule(parsed);
    if (!result.ok) return { kind: 'invalid' };
    return { kind: 'ok', schedule: result.schedule };
  }
  const result = parseNotificationSchedule(raw);
  if (!result.ok) return { kind: 'invalid' };
  return { kind: 'ok', schedule: result.schedule };
}

/** True when the schedule window covers atMs (UTC). Null schedule is always active. */
export function isScheduleActive(schedule: NotificationSchedule | null, atMs: number): boolean {
  if (schedule == null) return true;
  const date = new Date(atMs);
  const day = date.getUTCDay();
  const minute = date.getUTCHours() * 60 + date.getUTCMinutes();
  const { days, start_minute: start, end_minute: end } = schedule;
  if (start < end) {
    return days.includes(day) && minute >= start && minute < end;
  }
  const prevDay = (day + 6) % 7;
  return (days.includes(day) && minute >= start)
    || (days.includes(prevDay) && minute < end);
}

/** Whether a loaded rule may suppress at atMs (filters already matched). */
export function scheduleAllowsSuppression(
  schedule: NotificationSchedule | null,
  scheduleInvalid: boolean,
  atMs: number,
): boolean {
  if (scheduleInvalid) return false;
  return isScheduleActive(schedule, atMs);
}
