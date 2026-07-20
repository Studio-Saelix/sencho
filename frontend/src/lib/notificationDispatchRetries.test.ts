
import { describe, it, expect } from 'vitest';
import { parseNotificationDispatchRetries } from './notificationDispatchRetries';

describe('parseNotificationDispatchRetries', () => {
  it('accepts integers and digit strings 0-3', () => {
    expect(parseNotificationDispatchRetries(0)).toBe(0);
    expect(parseNotificationDispatchRetries(3)).toBe(3);
    expect(parseNotificationDispatchRetries('2')).toBe(2);
  });

  it('rejects out-of-range, decimals, and non-canonical strings', () => {
    expect(parseNotificationDispatchRetries(9)).toBeNull();
    expect(parseNotificationDispatchRetries('9')).toBeNull();
    expect(parseNotificationDispatchRetries(1.5)).toBeNull();
    expect(parseNotificationDispatchRetries('1.5')).toBeNull();
    expect(parseNotificationDispatchRetries(' 1')).toBeNull();
    expect(parseNotificationDispatchRetries(null)).toBeNull();
    expect(parseNotificationDispatchRetries(true)).toBeNull();
  });
});
