/**
 * Locks the frontend scheduled-action registry: the task-to-definition
 * resolution (including the update-fleet alias), and the parity between the
 * registry's backend actions and the wire action union.
 */
import { describe, it, expect } from 'vitest';
import {
  SCHEDULED_ACTIONS,
  SCHEDULED_ACTION_CATEGORIES,
  getActionById,
  resolveTaskAction,
  type BackendAction,
  type ScheduledActionCategory,
} from '../scheduledActions';

const BACKEND_ACTIONS: BackendAction[] = [
  'restart', 'snapshot', 'prune', 'update', 'scan',
  'auto_backup', 'auto_stop', 'auto_down', 'auto_start',
];

const CATEGORY_KEYS: ScheduledActionCategory[] = SCHEDULED_ACTION_CATEGORIES.map(c => c.key);

describe('scheduledActions registry', () => {
  it('every backendAction is a known wire action', () => {
    for (const def of SCHEDULED_ACTIONS) {
      expect(BACKEND_ACTIONS).toContain(def.backendAction);
    }
  });

  it('covers every wire action with at least one entry', () => {
    const covered = new Set(SCHEDULED_ACTIONS.map(d => d.backendAction));
    expect([...covered].sort()).toEqual([...BACKEND_ACTIONS].sort());
  });

  it('every entry uses a defined category lane', () => {
    for (const def of SCHEDULED_ACTIONS) {
      expect(CATEGORY_KEYS).toContain(def.category);
    }
  });

  it('getActionById resolves a known id and returns undefined otherwise', () => {
    expect(getActionById('restart')?.label).toBe('Restart Stack');
    expect(getActionById('nope')).toBeUndefined();
  });

  describe('resolveTaskAction', () => {
    it('maps update + fleet to the update-fleet UI entry', () => {
      const def = resolveTaskAction({ action: 'update', target_type: 'fleet' });
      expect(def?.id).toBe('update-fleet');
      expect(def?.backendAction).toBe('update');
    });

    it('maps update + stack to the direct update entry', () => {
      const def = resolveTaskAction({ action: 'update', target_type: 'stack' });
      expect(def?.id).toBe('update');
    });

    it('maps a non-aliased action to its direct entry', () => {
      expect(resolveTaskAction({ action: 'restart', target_type: 'stack' })?.id).toBe('restart');
      expect(resolveTaskAction({ action: 'snapshot', target_type: 'fleet' })?.id).toBe('snapshot');
    });

    it('returns undefined for an unknown action', () => {
      expect(resolveTaskAction({ action: 'bogus' as BackendAction, target_type: 'system' })).toBeUndefined();
    });
  });
});
