import { describe, expect, it, vi } from 'vitest';
import { canDismissFinding } from './canDismissFinding';

const stackFinding = { domain: 'workloads', stack: 'web', nodeId: 3 } as const;
const nodeFinding = { domain: 'connectivity', stack: null, nodeId: 3 } as const;
const controlFinding = { domain: 'control', stack: null, nodeId: 3 } as const;

describe('canDismissFinding', () => {
  it('asks for deploy on that stack and node for a stack finding', () => {
    const can = vi.fn().mockReturnValue(true);
    expect(canDismissFinding(can, false, stackFinding)).toBe(true);
    expect(can).toHaveBeenCalledWith('stack:deploy', 'stack', 'web', 3);
  });

  it('asks for node management of that node for a node-level finding', () => {
    const can = vi.fn().mockReturnValue(true);
    expect(canDismissFinding(can, false, nodeFinding)).toBe(true);
    expect(can).toHaveBeenCalledWith('node:manage', 'node', '3');
  });

  it('follows the answer it is given, so a refused account sees no Dismiss', () => {
    expect(canDismissFinding(() => false, false, stackFinding)).toBe(false);
    expect(canDismissFinding(() => false, false, nodeFinding)).toBe(false);
  });

  it('needs an admin for a Control finding, whatever else the account may do', () => {
    const can = vi.fn().mockReturnValue(true);
    expect(canDismissFinding(can, false, controlFinding)).toBe(false);
    expect(canDismissFinding(can, true, controlFinding)).toBe(true);
    expect(can).not.toHaveBeenCalled();
  });
});
