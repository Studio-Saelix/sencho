import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { StackRow } from '../StackRow';
import type { Label } from '@/components/label-types';

function base(overrides: Partial<ComponentProps<typeof StackRow>> = {}) {
  return {
    file: 'web.yml',
    displayName: 'web',
    status: 'running' as const,
    isBusy: false,
    isActive: false,
    labels: [] as Label[],
    hasUpdate: false,
    hasGitPending: false,
    onSelect: vi.fn(),
    kebabSlot: null,
    ...overrides,
  };
}

describe('StackRow', () => {
  it('renders UP for running', () => {
    render(<StackRow {...base()} />);
    expect(screen.getByText('UP')).toBeInTheDocument();
  });

  it('renders DN for exited', () => {
    render(<StackRow {...base({ status: 'exited' })} />);
    expect(screen.getByText('DN')).toBeInTheDocument();
  });

  it('renders -- for unknown', () => {
    render(<StackRow {...base({ status: 'unknown' })} />);
    expect(screen.getByText('--')).toBeInTheDocument();
  });

  it('renders cyan rail only when active', () => {
    const { rerender } = render(<StackRow {...base({ isActive: false })} />);
    expect(screen.getByTestId('stack-row')).not.toHaveClass('bg-accent/[0.07]');
    rerender(<StackRow {...base({ isActive: true })} />);
    expect(screen.getByTestId('stack-row')).toHaveClass('bg-accent/[0.07]');
  });

  it('fires onSelect on click', () => {
    const onSelect = vi.fn();
    render(<StackRow {...base({ onSelect })} />);
    screen.getByTestId('stack-row').click();
    expect(onSelect).toHaveBeenCalledWith('web.yml');
  });

  it('fires onSelect on Enter and Space', () => {
    const onSelect = vi.fn();
    render(<StackRow {...base({ onSelect })} />);
    const row = screen.getByTestId('stack-row');
    row.focus();
    fireEvent.keyDown(row, { key: 'Enter' });
    fireEvent.keyDown(row, { key: ' ' });
    expect(onSelect).toHaveBeenCalledTimes(2);
  });

  it('kebab click does not trigger onSelect', () => {
    const onSelect = vi.fn();
    render(<StackRow {...base({ onSelect, kebabSlot: <button data-testid="kebab">k</button> })} />);
    screen.getByTestId('kebab').click();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('renders loader when isBusy', () => {
    const { container } = render(<StackRow {...base({ isBusy: true })} />);
    expect(container.querySelector('.animate-spin')).not.toBeNull();
    expect(screen.queryByText('UP')).not.toBeInTheDocument();
  });

  it('renders label indicators', () => {
    const labels: Label[] = [
      { id: 1, node_id: 0, name: 'prod', color: 'teal' },
      { id: 2, node_id: 0, name: 'media', color: 'blue' },
    ];
    const { container } = render(<StackRow {...base({ labels })} />);
    expect(container.querySelectorAll('[style*="--label-"]')).toHaveLength(2);
  });
});
