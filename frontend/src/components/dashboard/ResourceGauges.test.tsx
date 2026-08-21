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
  it('uses balloon-adjusted percent for hero, tone, and bar, and drops the duplicated suffix', () => {
    render(
      <ResourceGauges
        systemStats={baseStats({
          total: 16 * GiB,
          used: 14.4 * GiB,
          free: 1.6 * GiB,
          usagePercent: '90',
          ballooned: 4 * GiB,
          effectiveUsed: 800 * MiB,
          effectiveTotal: 5.3 * GiB,
          effectiveUsagePercent: '14',
        })}
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

    expect(tile.textContent).toContain('800 MB / 5.3 GB');
    expect(tile.textContent).toContain('Ballooned to host: 4 GB');
    expect(tile.textContent).not.toMatch(/effective\s+14%/i);

    const bar = memoryBar(tile);
    expect(bar).not.toBeNull();
    expect(bar?.style.width).toBe('14%');
    expect(bar?.style.backgroundColor).toBe('var(--brand)');
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
    expect(tile.textContent).not.toContain('Ballooned to host');

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
