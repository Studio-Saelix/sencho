import { describe, it, expect } from 'vitest';
import { statusText, statusColor, isDownStatus } from '../stack-status-utils';

describe('stack-status-utils', () => {
  describe('statusText', () => {
    it('maps each status to its pill label', () => {
      expect(statusText('running')).toBe('UP');
      expect(statusText('exited')).toBe('DN');
      expect(statusText('partial')).toBe('PT');
      expect(statusText('unknown')).toBe('--');
    });
  });

  describe('statusColor', () => {
    it('maps partial to the amber warning token', () => {
      expect(statusColor('partial', false)).toBe('text-warning');
    });
    it('uses the muted spinner color while busy regardless of status', () => {
      expect(statusColor('partial', true)).toBe('text-muted-foreground');
    });
  });

  describe('isDownStatus', () => {
    it('treats exited and partial as needing attention', () => {
      expect(isDownStatus('exited')).toBe(true);
      expect(isDownStatus('partial')).toBe(true);
    });
    it('does not treat running, unknown, or a missing status as down', () => {
      expect(isDownStatus('running')).toBe(false);
      expect(isDownStatus('unknown')).toBe(false);
      expect(isDownStatus(undefined)).toBe(false);
    });
  });
});
