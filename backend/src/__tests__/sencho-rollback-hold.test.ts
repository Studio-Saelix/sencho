import { describe, it, expect } from 'vitest';
import {
  isFullySyntheticHoldImage,
  isSenchoRollbackHoldRef,
  SENCHO_ROLLBACK_HOLD_PREFIX,
  SENCHO_ROLLBACK_HOLD_SQL_LIKE,
} from '../utils/senchoRollbackHold';

describe('senchoRollbackHold constants', () => {
  it('keeps the SQL LIKE pattern aligned with the JS prefix', () => {
    expect(SENCHO_ROLLBACK_HOLD_SQL_LIKE).toBe(`${SENCHO_ROLLBACK_HOLD_PREFIX}%`);
  });
});

describe('isSenchoRollbackHoldRef', () => {
  it('matches Sencho synthetic rollback-hold tags', () => {
    expect(isSenchoRollbackHoldRef('sencho-rb/aaaaaaaaaaaa/web:hold')).toBe(true);
    expect(isSenchoRollbackHoldRef('sencho-rb/x/svc:hold')).toBe(true);
  });

  it('rejects ordinary registry refs', () => {
    expect(isSenchoRollbackHoldRef('nginx:1.25')).toBe(false);
    expect(isSenchoRollbackHoldRef('ghcr.io/org/app:latest')).toBe(false);
    expect(isSenchoRollbackHoldRef('stack:web')).toBe(false);
  });
});

describe('isFullySyntheticHoldImage', () => {
  it('is true when every tag is a hold tag', () => {
    expect(isFullySyntheticHoldImage(['sencho-rb/aaaaaaaaaaaa/web:hold'])).toBe(true);
  });

  it('is false when a registry tag is present alongside a hold tag', () => {
    expect(isFullySyntheticHoldImage([
      'myregistry/app:1.4',
      'sencho-rb/aaaaaaaaaaaa/app:hold',
    ])).toBe(false);
  });

  it('is false for empty tag lists', () => {
    expect(isFullySyntheticHoldImage([])).toBe(false);
  });
});
