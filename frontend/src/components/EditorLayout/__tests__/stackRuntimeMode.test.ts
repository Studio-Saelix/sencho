import { describe, it, expect } from 'vitest';
import { getStackRuntimeMode, isServiceStoppable } from '../stackRuntimeMode';

describe('getStackRuntimeMode', () => {
  it('is running when any container is up', () => {
    expect(getStackRuntimeMode([{ State: 'running' }])).toBe('running');
  });

  it('is running when a running container has a restarting sibling', () => {
    expect(getStackRuntimeMode([{ State: 'restarting' }, { State: 'running' }])).toBe('running');
  });

  it('is looping when nothing is up and a container is restarting', () => {
    expect(getStackRuntimeMode([{ State: 'restarting' }])).toBe('looping');
  });

  it('is stopped when every container has exited', () => {
    expect(getStackRuntimeMode([{ State: 'exited' }, { State: 'exited' }])).toBe('stopped');
  });

  it('is stopped for an empty or missing container list', () => {
    expect(getStackRuntimeMode([])).toBe('stopped');
    expect(getStackRuntimeMode(undefined)).toBe('stopped');
  });

  it('treats paused-only as stopped, matching the header before', () => {
    expect(getStackRuntimeMode([{ State: 'paused' }])).toBe('stopped');
  });

  it('is looping when a loop sits beside an exited sibling', () => {
    expect(getStackRuntimeMode([{ State: 'exited' }, { State: 'restarting' }])).toBe('looping');
  });
});

describe('isServiceStoppable', () => {
  it('is stoppable while running, paused, or restarting', () => {
    expect(isServiceStoppable([{ State: 'running' }])).toBe(true);
    expect(isServiceStoppable([{ State: 'paused' }])).toBe(true);
    expect(isServiceStoppable([{ State: 'restarting' }])).toBe(true);
  });

  it('is not stoppable when everything has exited', () => {
    expect(isServiceStoppable([{ State: 'exited' }])).toBe(false);
    expect(isServiceStoppable([])).toBe(false);
    expect(isServiceStoppable(undefined)).toBe(false);
  });
});
