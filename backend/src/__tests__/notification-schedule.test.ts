import { describe, it, expect } from 'vitest';
import {
  isScheduleActive,
  parseNotificationSchedule,
  parseStoredNotificationSchedule,
  scheduleAllowsSuppression,
  type NotificationSchedule,
} from '../helpers/notificationSchedule';

/** Build a UTC epoch for a known weekday. 2026-07-18 is Saturday (getUTCDay()===6). */
function utcMs(iso: string): number {
  return Date.parse(iso);
}

const satWindow: NotificationSchedule = {
  days: [6],
  start_minute: 22 * 60,
  end_minute: 2 * 60,
  tz: 'UTC',
};

const sameDay: NotificationSchedule = {
  days: [1],
  start_minute: 2 * 60,
  end_minute: 6 * 60,
  tz: 'UTC',
};

describe('parseNotificationSchedule', () => {
  it('accepts unique days in any order and returns sorted', () => {
    const result = parseNotificationSchedule({
      days: [3, 1, 6],
      start_minute: 0,
      end_minute: 60,
      tz: 'UTC',
    });
    expect(result).toEqual({
      ok: true,
      schedule: { days: [1, 3, 6], start_minute: 0, end_minute: 60, tz: 'UTC' },
    });
  });

  it('rejects duplicates, empty days, equal endpoints, and non-UTC tz', () => {
    expect(parseNotificationSchedule({
      days: [1, 1], start_minute: 0, end_minute: 1, tz: 'UTC',
    }).ok).toBe(false);
    expect(parseNotificationSchedule({
      days: [], start_minute: 0, end_minute: 1, tz: 'UTC',
    }).ok).toBe(false);
    expect(parseNotificationSchedule({
      days: [1], start_minute: 30, end_minute: 30, tz: 'UTC',
    }).ok).toBe(false);
    expect(parseNotificationSchedule({
      days: [1], start_minute: 0, end_minute: 1, tz: 'America/New_York',
    }).ok).toBe(false);
  });
});

describe('isScheduleActive', () => {
  it('treats null schedule as always active', () => {
    expect(isScheduleActive(null, utcMs('2026-07-20T12:00:00.000Z'))).toBe(true);
  });

  it('same-day: start inclusive, end exclusive', () => {
    // Monday 2026-07-20
    expect(isScheduleActive(sameDay, utcMs('2026-07-20T02:00:00.000Z'))).toBe(true);
    expect(isScheduleActive(sameDay, utcMs('2026-07-20T05:59:00.000Z'))).toBe(true);
    expect(isScheduleActive(sameDay, utcMs('2026-07-20T06:00:00.000Z'))).toBe(false);
    expect(isScheduleActive(sameDay, utcMs('2026-07-20T01:59:00.000Z'))).toBe(false);
  });

  it('cross-midnight Saturday window: Sat evening and Sun morning only', () => {
    expect(isScheduleActive(satWindow, utcMs('2026-07-18T22:00:00.000Z'))).toBe(true); // Sat
    expect(isScheduleActive(satWindow, utcMs('2026-07-18T23:30:00.000Z'))).toBe(true);
    expect(isScheduleActive(satWindow, utcMs('2026-07-19T01:59:00.000Z'))).toBe(true); // Sun
    expect(isScheduleActive(satWindow, utcMs('2026-07-19T02:00:00.000Z'))).toBe(false);
    expect(isScheduleActive(satWindow, utcMs('2026-07-18T21:59:00.000Z'))).toBe(false);
    expect(isScheduleActive(satWindow, utcMs('2026-07-19T22:00:00.000Z'))).toBe(false); // Sun evening
    expect(isScheduleActive(satWindow, utcMs('2026-07-20T01:00:00.000Z'))).toBe(false); // Mon morning
  });

  it('supports multiple start days', () => {
    const multi: NotificationSchedule = {
      days: [1, 3],
      start_minute: 10 * 60,
      end_minute: 11 * 60,
      tz: 'UTC',
    };
    expect(isScheduleActive(multi, utcMs('2026-07-20T10:30:00.000Z'))).toBe(true); // Mon
    expect(isScheduleActive(multi, utcMs('2026-07-22T10:30:00.000Z'))).toBe(true); // Wed
    expect(isScheduleActive(multi, utcMs('2026-07-21T10:30:00.000Z'))).toBe(false); // Tue
  });

  it('uses UTC independent of host-local timezone interpretation of fixed instants', () => {
    const ms = utcMs('2026-07-18T22:00:00.000Z');
    expect(new Date(ms).getUTCDay()).toBe(6);
    expect(isScheduleActive(satWindow, ms)).toBe(true);
  });
});

describe('scheduleAllowsSuppression / stored parse', () => {
  it('fails closed for invalid stored schedule', () => {
    expect(scheduleAllowsSuppression(null, true, Date.now())).toBe(false);
    expect(parseStoredNotificationSchedule('{not-json')).toEqual({ kind: 'invalid' });
    expect(parseStoredNotificationSchedule(null)).toEqual({ kind: 'null' });
    expect(parseStoredNotificationSchedule(undefined)).toEqual({ kind: 'null' });
  });

  it('treats empty and whitespace strings as invalid, not legacy null', () => {
    expect(parseStoredNotificationSchedule('')).toEqual({ kind: 'invalid' });
    expect(parseStoredNotificationSchedule('   ')).toEqual({ kind: 'invalid' });
    expect(parseStoredNotificationSchedule('null')).toEqual({ kind: 'invalid' });
  });
});
