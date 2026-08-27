import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ResourceGauges } from './ResourceGauges';
import type { SystemStats } from './types';

const GiB = 1024 ** 3;
const MiB = 1024 ** 2;

function baseStats(memory: SystemStats['memory']): SystemStats {
  return {
    cpu: { usage: '4.0', cores: 8 },
    memory,
    disk: { fs: '/', mount: '/', total: 100 * GiB, used: 40 * GiB, free: 60 * GiB, usagePercent: '40' },
  };
}

// Fixture mirrors the backend contract (adjustForBalloon): effectiveTotal ===
// total and effectiveUsed === max(used - ballooned, 0). Numbers follow the
// issue report: 753.8 MB effective of a 5.3 GB VM with 4 GB ballooned.
function balloonedMemory(opts: { total: number; effectiveUsed: number; ballooned: number }): SystemStats['memory'] {
  const { total, effectiveUsed, ballooned } = opts;
  const used = Math.min(effectiveUsed + ballooned, total);
  return {
    total,
    used,
    free: Math.max(total - used, 0),
    usagePercent: ((used / total) * 100).toFixed(1),
    ballooned,
    effectiveUsed,
    effectiveTotal: total,
    effectiveFree: Math.min(total - effectiveUsed, total),
    effectiveUsagePercent: ((effectiveUsed / total) * 100).toFixed(1),
  };
}

function memoryTile(): HTMLElement {
  const label = screen.getByText('MEMORY');
  const tile = label.parentElement;
  if (!tile) throw new Error('MEMORY tile parent missing');
  return tile;
}

function memoryHero(tile: HTMLElement): HTMLElement {
  const hero = tile.querySelector('.text-2xl');
  if (!(hero instanceof HTMLElement)) throw new Error('MEMORY hero missing');
  return hero;
}

function memoryBar(tile: HTMLElement): HTMLElement | null {
  return tile.querySelector('.h-1 > div');
}

describe('ResourceGauges memory tile', () => {
  it('shows balloon context lines and uses the adjusted percent for hero, tone, and bar', () => {
    // Rendered values derived from this fixture: effective 13.9% -> hero 14%,
    // retained 1.3 GB, pressure 753.8 MB / 1.3 GB = 57%.
    render(
      <ResourceGauges
        systemStats={baseStats(balloonedMemory({ total: 5.3 * GiB, effectiveUsed: 753.8 * MiB, ballooned: 4 * GiB }))}
        cpuHistory={[]}
        netHistory={[]}
        historyEndAt={null}
      />,
    );

    const tile = memoryTile();
    const hero = memoryHero(tile);
    expect(hero.textContent).toBe('14%');
    expect(hero.className).toContain('text-stat-value');
    expect(hero.className).not.toContain('text-destructive');
    expect(hero.className).not.toContain('text-warning');

    expect(tile.textContent).toContain('753.8 MB / 5.3 GB');
    expect(tile.textContent).toMatch(/Current VM Memory: 1\.3 GB/);
    expect(tile.textContent).toMatch(/Current pressure: 57%/);
    expect(tile.textContent).toContain('Balloon reclaimable: 4 GB');
    expect(tile.textContent).not.toContain('Ballooned to host');
    expect(tile.textContent).not.toMatch(/effective\s+14%/i);
    expect(tile.textContent).not.toMatch(/NaN/);

    const bar = memoryBar(tile);
    expect(bar).not.toBeNull();
    expect(bar?.style.width).toBe('13.9%');
    expect(bar?.style.backgroundColor).toBe('var(--brand)');
  });

  it('hides retained-memory lines when the denominator is nonpositive but keeps the reclaimable line', () => {
    render(
      <ResourceGauges
        systemStats={baseStats(balloonedMemory({ total: 2 * GiB, effectiveUsed: 0, ballooned: 4 * GiB }))}
        cpuHistory={[]}
        netHistory={[]}
        historyEndAt={null}
      />,
    );

    const tile = memoryTile();
    expect(tile.textContent).not.toContain('Current VM Memory:');
    expect(tile.textContent).not.toContain('Current pressure:');
    expect(tile.textContent).toContain('Balloon reclaimable: 4 GB');
    expect(tile.textContent).not.toMatch(/NaN/);
  });

  it('treats ballooned equal to total as fully reclaimed and hides retained-memory lines', () => {
    render(
      <ResourceGauges
        systemStats={baseStats(balloonedMemory({ total: 2 * GiB, effectiveUsed: 0, ballooned: 2 * GiB }))}
        cpuHistory={[]}
        netHistory={[]}
        historyEndAt={null}
      />,
    );

    const tile = memoryTile();
    expect(tile.textContent).not.toContain('Current VM Memory:');
    expect(tile.textContent).not.toContain('Current pressure:');
    expect(tile.textContent).toContain('Balloon reclaimable: 2 GB');
  });

  it('renders zero pressure when the guest uses none of its retained memory', () => {
    // Retained 1.5 GiB, nothing effectively used: pressure line must read 0%.
    render(
      <ResourceGauges
        systemStats={baseStats(balloonedMemory({ total: 4 * GiB, effectiveUsed: 0, ballooned: 2.5 * GiB }))}
        cpuHistory={[]}
        netHistory={[]}
        historyEndAt={null}
      />,
    );

    const tile = memoryTile();
    expect(tile.textContent).toMatch(/Current VM Memory: 1\.5 GB/);
    expect(tile.textContent).toMatch(/Current pressure: 0%/);
    expect(tile.textContent).toContain('Balloon reclaimable: 2.5 GB');
    expect(tile.textContent).not.toMatch(/NaN/);
  });

  it('omits pressure but shows retained bytes when effectiveUsed is absent', () => {
    const memory = balloonedMemory({ total: 5.3 * GiB, effectiveUsed: 753.8 * MiB, ballooned: 4 * GiB });
    delete memory.effectiveUsed;
    delete memory.effectiveUsagePercent;
    render(
      <ResourceGauges systemStats={baseStats(memory)} cpuHistory={[]} netHistory={[]} historyEndAt={null} />,
    );

    const tile = memoryTile();
    // Hero falls back to the raw working-set percent (89.4 -> 89).
    expect(memoryHero(tile).textContent).toBe('89%');
    expect(tile.textContent).toMatch(/Current VM Memory: 1\.3 GB/);
    expect(tile.textContent).not.toContain('Current pressure:');
    expect(tile.textContent).toContain('Balloon reclaimable: 4 GB');
    expect(tile.textContent).not.toMatch(/NaN/);
  });

  it('renders ZFS raw current-memory line as used plus arcReclaimable', () => {
    render(
      <ResourceGauges
        systemStats={baseStats({
          total: 125.5 * GiB,
          used: 19.1 * GiB,
          free: 106.4 * GiB,
          usagePercent: '15.2',
          arcReclaimable: 98.1 * GiB,
        })}
        cpuHistory={[]}
        netHistory={[]}
        historyEndAt={null}
      />,
    );

    const tile = memoryTile();
    // Raw in use is reconstructed (used + reclaimable), not repeated from used.
    expect(tile.textContent).toMatch(/Current memory in use: 117\.2 GB/);
    expect(tile.textContent).toContain('ZFS ARC reclaimable: 98.1 GB');
    expect(tile.textContent).not.toContain('Current pressure:');
    expect(tile.textContent).not.toContain('Balloon reclaimable');
    expect(tile.textContent).not.toMatch(/NaN/);
  });

  it('renders balloon and ZFS context blocks independently', () => {
    const memory = {
      ...balloonedMemory({ total: 5.3 * GiB, effectiveUsed: 753.8 * MiB, ballooned: 4 * GiB }),
      arcReclaimable: 98.1 * GiB,
    };
    render(
      <ResourceGauges systemStats={baseStats(memory)} cpuHistory={[]} netHistory={[]} historyEndAt={null} />,
    );

    const tile = memoryTile();
    expect(tile.textContent).toMatch(/Current VM Memory: 1\.3 GB/);
    expect(tile.textContent).toMatch(/Current pressure: 57%/);
    expect(tile.textContent).toContain('Balloon reclaimable: 4 GB');
    expect(tile.textContent).toContain('ZFS ARC reclaimable: 98.1 GB');
    // used (4.7 GiB raw working set, before balloon subtraction) plus reclaimable.
    expect(tile.textContent).toMatch(/Current memory in use: 102\.8 GB/);
  });

  it('falls back to raw usagePercent when balloon fields are absent', () => {
    render(
      <ResourceGauges
        systemStats={baseStats({
          total: 16 * GiB,
          used: 14.4 * GiB,
          free: 1.6 * GiB,
          usagePercent: '90',
        })}
        cpuHistory={[]}
        netHistory={[]}
        historyEndAt={null}
      />,
    );

    const tile = memoryTile();
    const hero = memoryHero(tile);
    expect(hero.textContent).toBe('90%');
    expect(hero.className).toContain('text-destructive');
    expect(tile.textContent).toContain('14.4 GB / 16 GB');
    expect(tile.textContent).not.toContain('Balloon reclaimable');
    expect(tile.textContent).not.toContain('Current memory in use');

    const bar = memoryBar(tile);
    expect(bar).not.toBeNull();
    expect(bar?.style.width).toBe('90%');
    expect(bar?.style.backgroundColor).toBe('var(--destructive)');
  });

  it('renders a placeholder hero and no bar when stats are missing', () => {
    render(
      <ResourceGauges
        systemStats={null}
        cpuHistory={[]}
        netHistory={[]}
        historyEndAt={null}
      />,
    );

    const tile = memoryTile();
    expect(memoryHero(tile).textContent).toBe('--');
    expect(memoryBar(tile)).toBeNull();
  });
});
