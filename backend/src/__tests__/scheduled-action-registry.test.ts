/**
 * Locks the backend scheduled-action registry: the action list stays in sync
 * with what the route layer validates, and validateActionTarget reproduces the
 * exact per-action error messages that are part of the API contract.
 */
import { describe, it, expect } from 'vitest';
import {
  VALID_ACTIONS,
  BACKEND_SCHEDULED_ACTIONS,
  INVALID_ACTION_MESSAGE,
  getScheduledActionDefinition,
  validateActionTarget,
  type BackendScheduledAction,
  type TargetType,
} from '../services/scheduledActionRegistry';

const EXPECTED_ACTIONS: BackendScheduledAction[] = [
  'restart', 'snapshot', 'prune', 'update', 'scan',
  'auto_backup', 'auto_stop', 'auto_down', 'auto_start',
];

const ALL_TARGET_TYPES: TargetType[] = ['stack', 'fleet', 'system'];

describe('scheduledActionRegistry', () => {
  it('exposes exactly the known backend actions, in order', () => {
    expect([...VALID_ACTIONS]).toEqual(EXPECTED_ACTIONS);
  });

  it('every valid action has a registry entry and vice versa', () => {
    const entryIds = BACKEND_SCHEDULED_ACTIONS.map(a => a.id);
    expect([...entryIds].sort()).toEqual([...VALID_ACTIONS].sort());
  });

  it('derives the invalid-action message from the action list', () => {
    expect(INVALID_ACTION_MESSAGE).toBe(
      'Invalid action. Must be restart, snapshot, prune, update, scan, auto_backup, auto_stop, auto_down, or auto_start.',
    );
  });

  it('marks node-scoped and local-only actions in backend metadata', () => {
    expect(getScheduledActionDefinition('scan')).toMatchObject({ requiresNode: true, nodeScope: 'local' });
    expect(getScheduledActionDefinition('prune')).toMatchObject({ requiresNode: true, nodeScope: 'local' });
    expect(getScheduledActionDefinition('update')).toMatchObject({ requiresNode: true });
    expect(getScheduledActionDefinition('snapshot')).toMatchObject({ requiresNode: false });
  });

  describe('validateActionTarget', () => {
    const validPairs: Record<BackendScheduledAction, TargetType[]> = {
      restart: ['stack'],
      snapshot: ['fleet'],
      prune: ['system'],
      update: ['stack', 'fleet'],
      scan: ['system'],
      auto_backup: ['stack'],
      auto_stop: ['stack'],
      auto_down: ['stack'],
      auto_start: ['stack'],
    };

    const mismatchMessage: Record<BackendScheduledAction, string> = {
      restart: 'Restart action requires target_type "stack".',
      snapshot: 'Snapshot action requires target_type "fleet".',
      prune: 'Prune action requires target_type "system".',
      update: 'Update action requires target_type "stack" or "fleet".',
      scan: 'Scan action requires target_type "system".',
      auto_backup: 'auto_backup action requires target_type "stack".',
      auto_stop: 'auto_stop action requires target_type "stack".',
      auto_down: 'auto_down action requires target_type "stack".',
      auto_start: 'auto_start action requires target_type "stack".',
    };

    for (const action of EXPECTED_ACTIONS) {
      it(`accepts valid and rejects invalid target types for ${action}`, () => {
        for (const targetType of ALL_TARGET_TYPES) {
          const result = validateActionTarget(action, targetType);
          if (validPairs[action].includes(targetType)) {
            expect(result).toBeNull();
          } else {
            expect(result).toBe(mismatchMessage[action]);
          }
        }
      });
    }
  });
});
