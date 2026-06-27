/**
 * Locks the frontend scheduled-action registry: the task-to-definition
 * resolution (including the update-fleet alias), and the parity between the
 * registry's backend actions and the wire action union.
 */
import { describe, it, expect } from 'vitest';
import {
  SCHEDULED_ACTIONS,
  SCHEDULED_ACTION_CATEGORIES,
  DEFAULT_SCHEDULED_ACTION_ID,
  getActionById,
  resolveTaskAction,
  scheduleTargetDescriptor,
  stripComposeExt,
  RISK_LABEL,
  RISK_TONE,
  RISK_BADGE_CLASSES,
  RISK_DOT_CLASSES,
  type BackendAction,
  type ScheduledActionCategory,
  type ScheduledActionRiskLevel,
} from '../scheduledActions';
import type { ScheduledTask } from '@/types/scheduling';

type TargetTask = Pick<ScheduledTask, 'action' | 'target_type' | 'target_id' | 'name'>;

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

  it('marks scan and prune as local-node actions', () => {
    expect(getActionById('scan')).toMatchObject({ requiresNode: true, nodeScope: 'local' });
    expect(getActionById('prune')).toMatchObject({ requiresNode: true, nodeScope: 'local' });
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

  it('exports DEFAULT_SCHEDULED_ACTION_ID as restart', () => {
    expect(DEFAULT_SCHEDULED_ACTION_ID).toBe('restart');
  });

  it('orders actions by category group', () => {
    const ids = SCHEDULED_ACTIONS.map(a => a.id);
    // Verify the exact order: lifecycle first, then updates, security, maintenance, backups.
    expect(ids).toEqual([
      'auto_backup', 'auto_start', 'restart', 'auto_stop', 'auto_down',
      'update', 'update-fleet',
      'scan',
      'prune',
      'snapshot',
    ]);
  });

  it('preserves the update-fleet alias after resorting', () => {
    const fleetUpdate = SCHEDULED_ACTIONS.find(a => a.id === 'update-fleet');
    expect(fleetUpdate).toBeDefined();
    expect(fleetUpdate!.backendAction).toBe('update');
    expect(fleetUpdate!.targetType).toBe('fleet');
  });

  describe('helperText', () => {
    const expected: Record<string, string> = {
      'auto_backup': 'Backs up compose and env files only. This does not back up application volumes.',
      'auto_start': 'Creates containers if they do not exist, or starts existing stopped containers.',
      'restart': 'Restarts containers in place. Running services are stopped and started again on the same configuration.',
      'auto_stop': 'Stops containers but keeps them in place for a faster start later.',
      'auto_down': 'Runs compose down. Containers are removed, but compose files remain on disk.',
      'update': "Checks this stack's images and recreates the stack only when newer images are available.",
      'update-fleet': 'Checks every stack on the selected node and updates stacks with newer images.',
      'scan': 'Runs Trivy against images on the selected local node and records the findings.',
      'prune': 'Removes unused Docker resources on the selected node. Be careful when pruning volumes.',
      'snapshot': 'Creates a versioned snapshot of compose and env files across the fleet.',
    };

    for (const [id, text] of Object.entries(expected)) {
      it(`${id} helper text matches the specified wording`, () => {
        expect(getActionById(id)?.helperText).toBe(text);
      });
    }
  });

  describe('riskLevel', () => {
    const expected: Record<string, ScheduledActionRiskLevel> = {
      'auto_backup': 'safe',
      'auto_start': 'runtime-change',
      'restart': 'interruptive',
      'auto_stop': 'interruptive',
      'auto_down': 'removes-containers',
      'update': 'runtime-change',
      'update-fleet': 'runtime-change',
      'scan': 'read-only',
      'prune': 'destructive',
      'snapshot': 'safe',
    };

    for (const [id, level] of Object.entries(expected)) {
      it(`${id} risk level is ${level}`, () => {
        expect(getActionById(id)?.riskLevel).toBe(level);
      });
    }

    it('every action has a RISK_LABEL entry', () => {
      for (const def of SCHEDULED_ACTIONS) {
        expect(RISK_LABEL[def.riskLevel]).toBeTruthy();
      }
    });
  });

  describe('risk metadata maps', () => {
    it('RISK_TONE maps every action risk level', () => {
      for (const def of SCHEDULED_ACTIONS) {
        expect(RISK_TONE[def.riskLevel]).toBeTruthy();
      }
    });

    it('RISK_BADGE_CLASSES maps every action risk level', () => {
      for (const def of SCHEDULED_ACTIONS) {
        expect(RISK_BADGE_CLASSES[def.riskLevel]).toBeTruthy();
      }
    });

    it('RISK_DOT_CLASSES maps every action risk level', () => {
      for (const def of SCHEDULED_ACTIONS) {
        expect(RISK_DOT_CLASSES[def.riskLevel]).toBeTruthy();
      }
    });
  });

  it('resolveTaskAction for update+fleet returns correct metadata', () => {
    const def = resolveTaskAction({ action: 'update', target_type: 'fleet' });
    expect(def?.id).toBe('update-fleet');
    expect(def?.riskLevel).toBe('runtime-change');
    expect(def?.helperText).toBe('Checks every stack on the selected node and updates stacks with newer images.');
  });

  describe('stripComposeExt', () => {
    it('drops a trailing .yml or .yaml and leaves other names alone', () => {
      expect(stripComposeExt('web')).toBe('web');
      expect(stripComposeExt('web.yml')).toBe('web');
      expect(stripComposeExt('web.yaml')).toBe('web');
      expect(stripComposeExt('')).toBe('');
      expect(stripComposeExt('my.app')).toBe('my.app');
    });
  });

  describe('scheduleTargetDescriptor', () => {
    it('shows the stack name (without compose extension) for stack actions', () => {
      const task: TargetTask = { action: 'restart', target_type: 'stack', target_id: 'web.yml', name: 'Nightly restart' };
      expect(scheduleTargetDescriptor(task, 'hub')).toBe('web');
    });

    it('falls back to the task name when a stack target_id is missing', () => {
      const task: TargetTask = { action: 'restart', target_type: 'stack', target_id: null, name: 'api.yaml' };
      expect(scheduleTargetDescriptor(task)).toBe('api');
    });

    it('shows the node for a fleet auto-update, or a generic label without one', () => {
      const task: TargetTask = { action: 'update', target_type: 'fleet', target_id: null, name: 'Fleet update' };
      expect(scheduleTargetDescriptor(task, 'edge-1')).toBe('All stacks · edge-1');
      expect(scheduleTargetDescriptor(task)).toBe('All stacks');
    });

    it('shows Entire fleet for a fleet snapshot regardless of node', () => {
      const task: TargetTask = { action: 'snapshot', target_type: 'fleet', target_id: null, name: 'Nightly Snapshot' };
      expect(scheduleTargetDescriptor(task, 'edge-1')).toBe('Entire fleet');
      expect(scheduleTargetDescriptor(task)).toBe('Entire fleet');
    });

    it('shows the node for system actions (prune / scan), with a fallback', () => {
      const scan: TargetTask = { action: 'scan', target_type: 'system', target_id: null, name: 'Vul Scan' };
      const prune: TargetTask = { action: 'prune', target_type: 'system', target_id: null, name: 'Nightly Prune' };
      expect(scheduleTargetDescriptor(scan, 'hub')).toBe('hub');
      expect(scheduleTargetDescriptor(prune, 'edge-1')).toBe('edge-1');
      expect(scheduleTargetDescriptor(scan)).toBe('Selected node');
    });
  });
});
