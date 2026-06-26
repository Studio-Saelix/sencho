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

  it('renders PT with the amber class for partial', () => {
    const { container } = render(<StackRow {...base({ status: 'partial', running: 3, total: 5 })} />);
    expect(screen.getByText('PT')).toBeInTheDocument();
    expect(container.querySelector('.text-warning')).not.toBeNull();
  });

  it('wraps the partial pill in a hover tooltip', () => {
    // jsdom does not mount the cursor-follow label, so assert the PT trigger is
    // wrapped in the RowTooltip cursor-container; the visible "3/5 running"
    // tooltip text is verified in the Playwright drive.
    const { container } = render(<StackRow {...base({ status: 'partial', running: 3, total: 5 })} />);
    expect(screen.getByText('PT').closest('[data-slot="cursor-container"]')).not.toBeNull();
    expect(container.querySelector('[data-slot="cursor-container"]')).not.toBeNull();
  });

  it('does not wrap a non-partial pill in a tooltip', () => {
    render(<StackRow {...base({ status: 'running' })} />);
    expect(screen.getByText('UP').closest('[data-slot="cursor-container"]')).toBeNull();
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

  // ── Image-update check status indicator ────────────────────────────────
  // status='running' renders the pill as plain text (no tooltip), so the only
  // cursor-container in these rows is the trailing update/check indicator.

  it('shows a muted check-failed indicator when the last check failed and there is no update', () => {
    const { container } = render(<StackRow {...base({ status: 'running', hasUpdate: false, checkStatus: 'failed', lastError: 'Registry unreachable' })} />);
    expect(container.querySelector('[data-slot="cursor-container"]')).not.toBeNull();
    // It is not the update dot.
    expect(container.querySelector('.bg-update')).toBeNull();
  });

  it('prefers the update dot over the check-failed indicator', () => {
    const { container } = render(<StackRow {...base({ status: 'running', hasUpdate: true, checkStatus: 'failed' })} />);
    expect(container.querySelector('.bg-update')).not.toBeNull();
  });

  it('shows no trailing indicator for a clean ok check with no update', () => {
    const { container } = render(<StackRow {...base({ status: 'running', hasUpdate: false, checkStatus: 'ok' })} />);
    expect(container.querySelector('[data-slot="cursor-container"]')).toBeNull();
    expect(container.querySelector('.bg-update')).toBeNull();
  });
});
