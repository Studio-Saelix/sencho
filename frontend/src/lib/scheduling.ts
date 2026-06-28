import cronstrue from 'cronstrue';

export function getCronDescription(expression: string): string {
  try {
    return cronstrue.toString(expression);
  } catch {
    return 'Invalid expression';
  }
}

/**
 * Reject cron expressions with a leading seconds field (6 or more fields). The
 * scheduler is minute-granular, so the seconds field could never be honored.
 * Nicknames like `@daily` (one token) pass. Returns an error message or null
 * when the field count is acceptable.
 */
export function getCronFieldError(expression: string): string | null {
  const trimmed = expression.trim();
  if (trimmed && trimmed.split(/\s+/).length >= 6) {
    return 'Use 5 fields (minute hour day month weekday). The seconds field is not supported.';
  }
  return null;
}

export function formatTimestamp(ts: number | null): string {
  if (ts == null) return '-';
  return new Date(ts).toLocaleString();
}

/**
 * Simple schedule mode: a friendly, structured way to describe a schedule that
 * compiles down to the same 5-field `cron_expression` the backend already
 * stores. Anything outside these five shapes is edited as raw cron (Advanced).
 */
export type SimpleFrequency = 'once' | 'hourly' | 'daily' | 'weekly' | 'monthly';

export interface SimpleSchedule {
  frequency: SimpleFrequency;
  minute: number; // 0-59
  hour: number; // 0-23, ignored for 'hourly'
  weekdays: number[]; // 0-6 (Sun-Sat), used for 'weekly'
  dayOfMonth: number; // 1-31, used for 'monthly'
  date: Date | null; // used for 'once' (supplies day + month)
}

/**
 * Generate the 5-field cron expression for a simple schedule. Never throws: an
 * incomplete schedule (a 'once' with no date, or a 'weekly' with no days)
 * returns an empty string, so a render that reaches it before validation cannot
 * crash and a malformed expression is never produced.
 */
export function buildCron(s: SimpleSchedule): string {
  const m = s.minute;
  const h = s.hour;
  switch (s.frequency) {
    case 'hourly':
      return `${m} * * * *`;
    case 'daily':
      return `${m} ${h} * * *`;
    case 'weekly': {
      if (s.weekdays.length === 0) return '';
      const days = [...new Set(s.weekdays)].sort((a, b) => a - b).join(',');
      return `${m} ${h} * * ${days}`;
    }
    case 'monthly':
      return `${m} ${h} ${s.dayOfMonth} * *`;
    case 'once':
      if (!s.date) return '';
      return `${m} ${h} ${s.date.getDate()} ${s.date.getMonth() + 1} *`;
  }
}

/**
 * Absolute epoch-ms fire time for a one-time ('once') schedule: the picked date
 * at the chosen hour and minute. Returns null when the schedule is not 'once' or
 * has no date. A 5-field cron cannot encode a year, so a one-shot sends this
 * explicit timestamp to the backend to pin the exact run (year and time of day);
 * relying on the cron alone fires on the next annual occurrence, which can be a
 * different year than the date the admin selected.
 */
export function getOnceRunAt(s: SimpleSchedule): number | null {
  if (s.frequency !== 'once' || !s.date) return null;
  return new Date(s.date.getFullYear(), s.date.getMonth(), s.date.getDate(), s.hour, s.minute, 0, 0).getTime();
}

function parseIntField(field: string, min: number, max: number): number | null {
  if (!/^\d+$/.test(field)) return null;
  const n = Number(field);
  return n >= min && n <= max ? n : null;
}

function parseWeekdayList(field: string): number[] | null {
  const days: number[] = [];
  for (const token of field.split(',')) {
    const n = parseIntField(token, 0, 6);
    if (n === null) return null;
    days.push(n);
  }
  return days;
}

/**
 * Reverse of `buildCron`. Returns the structured schedule when `cron` matches
 * one of the five generatable shapes, or null when it doesn't (so the editor
 * falls back to Advanced cron). A fully pinned `M H D MO *` is only read as a
 * one-time schedule when `deleteAfterRun` is set, since cron has no year field
 * and Simple mode has no recurring "yearly" frequency. Strict and total.
 */
export function parseCron(cron: string, deleteAfterRun: boolean): SimpleSchedule | null {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [minF, hrF, domF, monF, dowF] = parts;

  const minute = parseIntField(minF, 0, 59);
  if (minute === null) return null;

  const base: SimpleSchedule = {
    frequency: 'daily', minute, hour: 0, weekdays: [], dayOfMonth: 1, date: null,
  };

  // hourly: M * * * *
  if (hrF === '*' && domF === '*' && monF === '*' && dowF === '*') {
    return { ...base, frequency: 'hourly' };
  }

  const hour = parseIntField(hrF, 0, 23);
  if (hour === null) return null;

  // daily: M H * * *
  if (domF === '*' && monF === '*' && dowF === '*') {
    return { ...base, frequency: 'daily', hour };
  }

  // weekly: M H * * <weekday list>
  if (domF === '*' && monF === '*' && dowF !== '*') {
    const weekdays = parseWeekdayList(dowF);
    if (!weekdays) return null;
    return { ...base, frequency: 'weekly', hour, weekdays };
  }

  // monthly: M H D * *
  if (domF !== '*' && monF === '*' && dowF === '*') {
    const dayOfMonth = parseIntField(domF, 1, 31);
    if (dayOfMonth === null) return null;
    return { ...base, frequency: 'monthly', hour, dayOfMonth };
  }

  // once: M H D MO * (only a one-time schedule when delete-after-run is set)
  if (domF !== '*' && monF !== '*' && dowF === '*') {
    if (!deleteAfterRun) return null;
    const dayOfMonth = parseIntField(domF, 1, 31);
    const month = parseIntField(monF, 1, 12);
    if (dayOfMonth === null || month === null) return null;
    const date = new Date(new Date().getFullYear(), month - 1, dayOfMonth);
    // Reject impossible day/month combos (JS Date rolls Feb 31 into March).
    if (date.getMonth() !== month - 1 || date.getDate() !== dayOfMonth) return null;
    return { ...base, frequency: 'once', hour, dayOfMonth, date };
  }

  return null;
}

/**
 * Validate a simple schedule. Returns a human-readable, save-blocking message
 * when the fields can't produce a schedule that will fire, or null when valid.
 * Returns the same `string | null` shape `getCronFieldError` uses for Advanced.
 */
export function getSimpleScheduleError(s: SimpleSchedule, now: Date = new Date()): string | null {
  if (!Number.isInteger(s.minute) || s.minute < 0 || s.minute > 59) {
    return 'Enter a valid time.';
  }
  if (s.frequency !== 'hourly' && (!Number.isInteger(s.hour) || s.hour < 0 || s.hour > 23)) {
    return 'Enter a valid time.';
  }
  if (s.frequency === 'weekly' && s.weekdays.length === 0) {
    return 'Choose at least one weekday.';
  }
  if (s.frequency === 'monthly' && (!Number.isInteger(s.dayOfMonth) || s.dayOfMonth < 1 || s.dayOfMonth > 31)) {
    return 'Day of month must be 1-31.';
  }
  if (s.frequency === 'once') {
    if (!s.date) return 'Select a date.';
    // Compare the full chosen instant (date + time), not just the day: a time
    // earlier today has already passed. The backend also rejects a past run_at
    // with a 400; this is the friendlier, save-blocking guard surfaced before
    // the request is sent.
    const when = getOnceRunAt(s);
    if (when !== null && when <= now.getTime()) {
      return 'The selected date and time are in the past and this schedule would never fire.';
    }
  }
  return null;
}
