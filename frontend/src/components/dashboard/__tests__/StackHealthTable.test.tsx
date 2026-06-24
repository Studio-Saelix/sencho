import { describe, it, expect } from 'vitest';
import { classifyRow } from '../classifyRow';

describe('classifyRow', () => {
  it('marks a partially-crashed stack as warn (degraded), not healthy', () => {
    expect(classifyRow('partial', 0)).toBe('warn');
  });

  it('marks an exited stack as error', () => {
    expect(classifyRow('exited', 0)).toBe('error');
  });

  it('marks a running stack with low CPU as healthy', () => {
    expect(classifyRow('running', 0)).toBe('healthy');
  });

  it('escalates a partial stack with critical CPU to error', () => {
    expect(classifyRow('partial', 95)).toBe('error');
  });
});
