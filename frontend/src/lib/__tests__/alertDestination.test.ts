import { describe, it, expect } from 'vitest';
import type { NotificationItem } from '@/components/dashboard/types';
import { resolveAlertDestination } from '../alertDestination';

const KNOWN = new Set([1, 2]);

function notif(overrides: Partial<NotificationItem>): NotificationItem {
  return { id: 1, level: 'warning', message: 'm', timestamp: 0, is_read: 0, nodeId: 1, ...overrides };
}

describe('resolveAlertDestination', () => {
  it('opens the stack on its own node', () => {
    expect(resolveAlertDestination(notif({ nodeId: 2, stack_name: 'web', category: 'monitor_alert' }), KNOWN)).toEqual({
      kind: 'stack', nodeId: 2, stackName: 'web', tab: 'stack', containerName: null,
    });
  });

  it('carries the container so a crash row lands on its logs', () => {
    expect(resolveAlertDestination(notif({ stack_name: 'web', container_name: 'web-1' }), KNOWN)).toMatchObject({
      kind: 'stack', containerName: 'web-1',
    });
  });

  it('opens the Drift tab for a drift row', () => {
    expect(resolveAlertDestination(notif({ stack_name: 'web', category: 'drift_detected' }), KNOWN)).toMatchObject({
      kind: 'stack', tab: 'drift',
    });
  });

  it('sends a stackless scan finding to that node scan history', () => {
    expect(resolveAlertDestination(notif({ nodeId: 2, category: 'scan_finding' }), KNOWN)).toEqual({
      kind: 'security', nodeId: 2, tab: 'history',
    });
  });

  it('prefers the stack for a scan finding that names one', () => {
    expect(resolveAlertDestination(notif({ category: 'scan_finding', stack_name: 'web' }), KNOWN)).toMatchObject({ kind: 'stack' });
  });

  it.each([
    ['node_update_available', 'nodes'],
    ['dev_build_update_available', 'changelog'],
  ] as const)('routes %s to the Fleet update sheet (%s)', (category, tab) => {
    expect(resolveAlertDestination(notif({ category, level: 'info' }), KNOWN)).toEqual({ kind: 'fleet-updates', tab });
  });

  it('refuses a node-owned destination for a node outside the registry', () => {
    expect(resolveAlertDestination(notif({ nodeId: 99, stack_name: 'web' }), KNOWN)).toBeNull();
    expect(resolveAlertDestination(notif({ nodeId: undefined, stack_name: 'web' }), KNOWN)).toBeNull();
  });

  it.each(['monitor_alert', 'system', 'health_gate_failed'])('leaves a stackless %s row without a destination', category => {
    expect(resolveAlertDestination(notif({ category }), KNOWN)).toBeNull();
  });
});
