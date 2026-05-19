/**
 * Unit tests for describeSpawnError. Rewrites misleading spawn ENOENT errors
 * to attribute to host memory pressure when free memory is below the floor,
 * while preserving the existing "Docker CLI unavailable on this node" mapping
 * on healthy hosts. Covers the F-15 ENOMEM-masquerading-as-ENOENT behavior.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import os from 'os';

import { describeSpawnError, LOW_MEMORY_FLOOR_BYTES } from '../utils/spawnErrors';

const HIGH_FREE = 2 * 1024 * 1024 * 1024;  // 2 GiB free (healthy)
const LOW_FREE = 32 * 1024 * 1024;         // 32 MiB free (the F-15 repro point)
const TOTAL = 6612 * 1024 * 1024;          // workstation total in the repro

let freememSpy: ReturnType<typeof vi.spyOn>;
let totalmemSpy: ReturnType<typeof vi.spyOn>;

function setMemory(free: number): void {
  freememSpy.mockReturnValue(free);
  totalmemSpy.mockReturnValue(TOTAL);
}

beforeEach(() => {
  freememSpy = vi.spyOn(os, 'freemem');
  totalmemSpy = vi.spyOn(os, 'totalmem');
});

afterEach(() => {
  freememSpy.mockRestore();
  totalmemSpy.mockRestore();
});

describe('describeSpawnError', () => {
  it('rewrites explicit ENOMEM regardless of free memory', () => {
    setMemory(HIGH_FREE);
    const err = Object.assign(new Error('ENOMEM: not enough memory'), { code: 'ENOMEM' });
    const mapped = describeSpawnError(err, { command: 'docker' });
    expect(mapped.isLowMemory).toBe(true);
    expect(mapped.message).toContain('Out of memory while launching docker');
    expect(mapped.message).toMatch(/host free memory: \d+ MiB of \d+ MiB/);
  });

  it('rewrites ENOENT-for-docker as OOM when free memory is below the floor', () => {
    setMemory(LOW_FREE);
    const err = Object.assign(new Error('spawn docker ENOENT'), { code: 'ENOENT' });
    const mapped = describeSpawnError(err, { command: 'docker' });
    expect(mapped.isLowMemory).toBe(true);
    expect(mapped.message).toContain('Out of memory while launching docker');
    expect(mapped.message).toContain('reported as ENOENT under memory pressure');
  });

  it('preserves the existing "Docker CLI unavailable" wording on healthy memory', () => {
    setMemory(HIGH_FREE);
    const err = Object.assign(new Error('spawn docker ENOENT'), { code: 'ENOENT' });
    const mapped = describeSpawnError(err, { command: 'docker' });
    expect(mapped.isLowMemory).toBe(false);
    expect(mapped.message).toBe('Docker CLI unavailable on this node');
  });

  it('rewrites ENOENT for non-docker commands (e.g. /bin/sh) under memory pressure', () => {
    setMemory(LOW_FREE);
    const err = Object.assign(new Error('spawn /bin/sh ENOENT'), { code: 'ENOENT' });
    const mapped = describeSpawnError(err, { command: '/bin/sh' });
    expect(mapped.isLowMemory).toBe(true);
    expect(mapped.message).toContain('Out of memory while launching /bin/sh');
  });

  it('passes through ENOENT for non-docker commands on healthy memory', () => {
    setMemory(HIGH_FREE);
    const err = Object.assign(new Error('spawn /bin/sh ENOENT'), { code: 'ENOENT' });
    const mapped = describeSpawnError(err, { command: '/bin/sh' });
    expect(mapped.isLowMemory).toBe(false);
    expect(mapped.message).toBe('spawn /bin/sh ENOENT');
  });

  it('passes through unrelated errors unchanged', () => {
    setMemory(HIGH_FREE);
    const err = Object.assign(new Error('permission denied'), { code: 'EACCES' });
    const mapped = describeSpawnError(err, { command: 'docker' });
    expect(mapped.isLowMemory).toBe(false);
    expect(mapped.message).toBe('permission denied');
  });

  it('crosses the threshold exactly at LOW_MEMORY_FLOOR_BYTES', () => {
    setMemory(LOW_MEMORY_FLOOR_BYTES);
    const err = Object.assign(new Error('spawn docker ENOENT'), { code: 'ENOENT' });
    const mapped = describeSpawnError(err, { command: 'docker' });
    expect(mapped.isLowMemory).toBe(false);
    expect(mapped.message).toBe('Docker CLI unavailable on this node');

    setMemory(LOW_MEMORY_FLOOR_BYTES - 1);
    const mapped2 = describeSpawnError(err, { command: 'docker' });
    expect(mapped2.isLowMemory).toBe(true);
  });
});
