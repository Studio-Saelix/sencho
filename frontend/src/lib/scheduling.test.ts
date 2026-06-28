import { describe, it, expect } from 'vitest';
import {
  getCronFieldError,
  buildCron,
  parseCron,
  getSimpleScheduleError,
  type SimpleSchedule,
} from './scheduling';

function schedule(overrides: Partial<SimpleSchedule> = {}): SimpleSchedule {
  return {
    frequency: 'daily',
    minute: 0,
    hour: 3,
    weekdays: [],
    dayOfMonth: 1,
    date: null,
    ...overrides,
  };
}

describe('getCronFieldError', () => {
  it('accepts a standard 5-field expression', () => {
    expect(getCronFieldError('0 3 * * *')).toBeNull();
  });

  it('rejects a 6-field expression with a seconds field', () => {
    expect(getCronFieldError('30 0 3 * * *')).toMatch(/5 fields/);
  });

  it('rejects expressions with extra fields beyond six', () => {
    expect(getCronFieldError('0 0 3 * * * 2026')).toMatch(/5 fields/);
  });

  it('accepts cron nicknames such as @daily', () => {
    expect(getCronFieldError('@daily')).toBeNull();
  });

  it('ignores empty or whitespace-only input', () => {
    expect(getCronFieldError('')).toBeNull();
    expect(getCronFieldError('   ')).toBeNull();
  });

  it('tolerates irregular spacing between five fields', () => {
    expect(getCronFieldError('  0   3 *  * * ')).toBeNull();
  });
});

describe('buildCron', () => {
  it('hourly emits a literal minute against every hour', () => {
    expect(buildCron(schedule({ frequency: 'hourly', minute: 15 }))).toBe('15 * * * *');
  });

  it('daily emits minute and hour', () => {
    expect(buildCron(schedule({ frequency: 'daily', minute: 0, hour: 3 }))).toBe('0 3 * * *');
  });

  it('weekly emits a sorted, de-duplicated weekday list', () => {
    expect(buildCron(schedule({ frequency: 'weekly', minute: 0, hour: 3, weekdays: [5, 1, 3] }))).toBe('0 3 * * 1,3,5');
    expect(buildCron(schedule({ frequency: 'weekly', minute: 0, hour: 3, weekdays: [1, 3, 1] }))).toBe('0 3 * * 1,3');
  });

  it('monthly emits the day of month', () => {
    expect(buildCron(schedule({ frequency: 'monthly', minute: 30, hour: 14, dayOfMonth: 15 }))).toBe('30 14 15 * *');
  });

  it('once pins the day and month from the date', () => {
    expect(buildCron(schedule({ frequency: 'once', minute: 0, hour: 9, date: new Date(2026, 5, 30) }))).toBe('0 9 30 6 *');
  });

  it('once returns an empty string when no date is set (total, never throws)', () => {
    expect(buildCron(schedule({ frequency: 'once', date: null }))).toBe('');
  });

  it('weekly returns an empty string when no weekdays are selected (no malformed cron)', () => {
    expect(buildCron(schedule({ frequency: 'weekly', weekdays: [] }))).toBe('');
  });

  it('every frequency with valid input produces a 5-field expression', () => {
    const cases: SimpleSchedule[] = [
      schedule({ frequency: 'hourly', minute: 5 }),
      schedule({ frequency: 'daily' }),
      schedule({ frequency: 'weekly', weekdays: [2] }),
      schedule({ frequency: 'monthly', dayOfMonth: 10 }),
      schedule({ frequency: 'once', date: new Date(2026, 0, 1) }),
    ];
    for (const c of cases) {
      expect(buildCron(c).split(/\s+/)).toHaveLength(5);
    }
  });
});

describe('parseCron', () => {
  it('round-trips every buildCron output at the cron-string level', () => {
    const cases: SimpleSchedule[] = [
      schedule({ frequency: 'hourly', minute: 5 }),
      schedule({ frequency: 'daily', minute: 0, hour: 3 }),
      schedule({ frequency: 'weekly', minute: 0, hour: 0, weekdays: [1, 3, 5] }),
      schedule({ frequency: 'monthly', minute: 30, hour: 14, dayOfMonth: 1 }),
      schedule({ frequency: 'once', minute: 0, hour: 9, date: new Date(new Date().getFullYear(), 5, 30) }),
    ];
    for (const c of cases) {
      const cron = buildCron(c);
      const parsed = parseCron(cron, c.frequency === 'once');
      expect(parsed).not.toBeNull();
      expect(buildCron(parsed as SimpleSchedule)).toBe(cron);
    }
  });

  it('returns null for non-matching shapes', () => {
    expect(parseCron('*/15 * * * *', false)).toBeNull();
    expect(parseCron('@daily', false)).toBeNull();
    expect(parseCron('0 3 * * 1-5', false)).toBeNull(); // range in weekday field
    expect(parseCron('0 3 1 * 1', false)).toBeNull(); // both day-of-month and weekday pinned
    expect(parseCron('30 0 3 * * *', false)).toBeNull(); // 6 fields
  });

  it('reads a daily expression', () => {
    expect(parseCron('0 0 * * *', false)).toMatchObject({ frequency: 'daily', minute: 0, hour: 0 });
  });

  it('reads a weekly expression with a weekday list', () => {
    expect(parseCron('0 0 * * 1,3,5', false)).toMatchObject({ frequency: 'weekly', minute: 0, hour: 0, weekdays: [1, 3, 5] });
  });

  it('reads a monthly expression', () => {
    expect(parseCron('30 14 1 * *', false)).toMatchObject({ frequency: 'monthly', minute: 30, hour: 14, dayOfMonth: 1 });
  });

  it('reads a one-time expression only when delete-after-run is set', () => {
    expect(parseCron('0 0 1 1 *', false)).toBeNull();
    const parsed = parseCron('0 0 1 1 *', true);
    expect(parsed).toMatchObject({ frequency: 'once', minute: 0, hour: 0, dayOfMonth: 1 });
    expect(parsed?.date?.getMonth()).toBe(0); // January
    expect(parsed?.date?.getDate()).toBe(1);
  });

  it('rejects an impossible day/month combination for once', () => {
    expect(parseCron('0 0 31 2 *', true)).toBeNull(); // Feb 31
  });
});

describe('getSimpleScheduleError', () => {
  const now = new Date(2026, 5, 28);

  it('passes a valid daily schedule', () => {
    expect(getSimpleScheduleError(schedule({ frequency: 'daily' }), now)).toBeNull();
  });

  it('blocks weekly with no weekdays', () => {
    expect(getSimpleScheduleError(schedule({ frequency: 'weekly', weekdays: [] }), now)).toBe('Choose at least one weekday.');
  });

  it('blocks an out-of-range day of month', () => {
    expect(getSimpleScheduleError(schedule({ frequency: 'monthly', dayOfMonth: 0 }), now)).toBe('Day of month must be 1-31.');
    expect(getSimpleScheduleError(schedule({ frequency: 'monthly', dayOfMonth: 32 }), now)).toBe('Day of month must be 1-31.');
  });

  it('blocks once with no date', () => {
    expect(getSimpleScheduleError(schedule({ frequency: 'once', date: null }), now)).toBe('Select a date.');
  });

  it('blocks once with a past date', () => {
    expect(getSimpleScheduleError(schedule({ frequency: 'once', date: new Date(2026, 5, 1) }), now))
      .toBe('The selected date is in the past and this schedule would never fire.');
  });

  it('passes once with a future date', () => {
    expect(getSimpleScheduleError(schedule({ frequency: 'once', date: new Date(2026, 11, 25) }), now)).toBeNull();
  });

  it('blocks an invalid time', () => {
    expect(getSimpleScheduleError(schedule({ frequency: 'daily', minute: Number.NaN }), now)).toBe('Enter a valid time.');
  });

  it('ignores the hour for hourly schedules', () => {
    expect(getSimpleScheduleError(schedule({ frequency: 'hourly', hour: 25, minute: 0 }), now)).toBeNull();
  });
});
