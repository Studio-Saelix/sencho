import { describe, expect, it } from 'vitest';
import { sameServiceUrlTarget } from './serviceUrlTarget';

describe('sameServiceUrlTarget', () => {
  const opened = { nodeId: 2, stackName: 'b.yaml' };

  it('rejects a different stack that reuses the service name', () => {
    expect(sameServiceUrlTarget(opened, { nodeId: 2, stackName: 'a.yaml' })).toBe(false);
  });

  it('rejects a node change', () => {
    expect(sameServiceUrlTarget(opened, { nodeId: 1, stackName: 'b.yaml' })).toBe(false);
  });

  it('accepts the stack the dialog was opened on', () => {
    expect(sameServiceUrlTarget(opened, { nodeId: 2, stackName: 'b.yaml' })).toBe(true);
  });
});
