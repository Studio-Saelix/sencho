import { describe, it, expect } from 'vitest';
import {
  statusText,
  statusColor,
  isDownStatus,
  classifyContainersStatus,
  isBulkStatusObjectFormat,
  isValidBulkPayload,
  parseBulkStatusPayload,
} from '../stack-status-utils';

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

  describe('classifyContainersStatus', () => {
    it('returns unknown for an empty container list', () => {
      expect(classifyContainersStatus([])).toBe('unknown');
    });

    it('returns running when every container is up', () => {
      expect(classifyContainersStatus([
        { State: 'running', Status: 'Up 2 hours' },
        { State: 'running', Status: 'Up 2 hours' },
      ])).toBe('running');
    });

    it('returns partial when a container has crashed alongside a running one', () => {
      expect(classifyContainersStatus([
        { State: 'running', Status: 'Up 2 hours' },
        { State: 'exited', Status: 'Exited (1) 5 minutes ago' },
      ])).toBe('partial');
    });

    it('treats a dead container as a crash even with a running sibling', () => {
      expect(classifyContainersStatus([
        { State: 'running', Status: 'Up 2 hours' },
        { State: 'dead', Status: 'Dead' },
      ])).toBe('partial');
    });

    it('treats a crash-looping container as partial', () => {
      expect(classifyContainersStatus([
        { State: 'running', Status: 'Up 1 minute' },
        { State: 'restarting', Status: 'Restarting (1) 3 seconds ago' },
      ])).toBe('partial');
    });

    it('does not degrade a stack for a cleanly finished one-shot container', () => {
      expect(classifyContainersStatus([
        { State: 'running', Status: 'Up 2 hours' },
        { State: 'exited', Status: 'Exited (0) 1 hour ago' },
      ])).toBe('running');
    });

    it('treats an exited container with an unreadable code as a crash', () => {
      expect(classifyContainersStatus([
        { State: 'running', Status: 'Up 2 hours' },
        { State: 'exited', Status: 'Exited' },
      ])).toBe('partial');
    });

    it('ignores a non-running, non-failed container (created) when a sibling runs', () => {
      expect(classifyContainersStatus([
        { State: 'running', Status: 'Up 2 hours' },
        { State: 'created', Status: 'Created' },
      ])).toBe('running');
    });

    it('returns exited when no container is running', () => {
      expect(classifyContainersStatus([
        { State: 'exited', Status: 'Exited (1) 5 minutes ago' },
        { State: 'created', Status: 'Created' },
      ])).toBe('exited');
    });
  });

  describe('isBulkStatusObjectFormat', () => {
    it('accepts the current object format', () => {
      expect(isBulkStatusObjectFormat({
        web: { status: 'running', running: 2, total: 2 },
        db: { status: 'partial', running: 1, total: 2 },
      })).toBe(true);
    });

    it('treats an empty object (node with no stacks) as the current format', () => {
      expect(isBulkStatusObjectFormat({})).toBe(true);
    });

    it('rejects the legacy plain-string format', () => {
      expect(isBulkStatusObjectFormat({ web: 'running', db: 'exited' })).toBe(false);
    });

    it('rejects a mixed response with any plain-string entry', () => {
      expect(isBulkStatusObjectFormat({
        web: { status: 'running' },
        db: 'running',
      })).toBe(false);
    });

    it('rejects an object entry missing a status field', () => {
      expect(isBulkStatusObjectFormat({ web: { running: 1, total: 1 } })).toBe(false);
    });

    it('rejects null', () => {
      expect(isBulkStatusObjectFormat(null)).toBe(false);
    });
  });

  describe('bulk payload parsing', () => {
    it('accepts and carries the runtime main-port service', () => {
      const payload = { 'web.yml': { status: 'running' as const, mainPort: 49152, mainPortService: 'app' } };
      expect(isValidBulkPayload(payload)).toBe(true);
      expect(parseBulkStatusPayload(payload, ['web.yml'])).toEqual({
        statuses: { 'web.yml': 'running' },
        ports: { 'web.yml': 49152 },
        portServices: { 'web.yml': 'app' },
        self: {},
        counts: {},
        coveredFileCount: 1,
      });
    });

    it('rejects a mistyped main-port service and omits a missing one', () => {
      expect(isValidBulkPayload({ 'web.yml': { status: 'running', mainPortService: 7 } })).toBe(false);
      const parsed = parseBulkStatusPayload({ 'web.yml': { status: 'running', mainPort: 49152 } }, ['web.yml']);
      expect(parsed.portServices).toEqual({});
    });
  });
});
