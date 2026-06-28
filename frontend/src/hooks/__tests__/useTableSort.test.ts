import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useTableSort } from '../useTableSort';

interface Row { name: string; size: number }

const ITEMS: Row[] = [
  { name: 'beta', size: 30 },
  { name: 'alpha', size: 10 },
  { name: 'gamma', size: 20 },
];

const COMPARATORS = {
  name: (a: Row, b: Row) => a.name.localeCompare(b.name),
  size: (a: Row, b: Row) => a.size - b.size,
};

describe('useTableSort', () => {
  it('sorts by the initial key and direction', () => {
    const { result } = renderHook(() => useTableSort(ITEMS, COMPARATORS, 'name'));
    expect(result.current.sorted.map(r => r.name)).toEqual(['alpha', 'beta', 'gamma']);
    expect(result.current.sortKey).toBe('name');
    expect(result.current.sortDir).toBe('asc');
  });

  it('flips direction when toggling the active key', () => {
    const { result } = renderHook(() => useTableSort(ITEMS, COMPARATORS, 'name'));
    act(() => result.current.toggleSort('name'));
    expect(result.current.sortDir).toBe('desc');
    expect(result.current.sorted.map(r => r.name)).toEqual(['gamma', 'beta', 'alpha']);
  });

  it('switches key and resets direction to asc', () => {
    const { result } = renderHook(() => useTableSort(ITEMS, COMPARATORS, 'name', 'desc'));
    act(() => result.current.toggleSort('size'));
    expect(result.current.sortKey).toBe('size');
    expect(result.current.sortDir).toBe('asc');
    expect(result.current.sorted.map(r => r.size)).toEqual([10, 20, 30]);
  });

  it('does not mutate the input array', () => {
    const input = [...ITEMS];
    renderHook(() => useTableSort(input, COMPARATORS, 'size'));
    expect(input.map(r => r.name)).toEqual(['beta', 'alpha', 'gamma']);
  });
});
