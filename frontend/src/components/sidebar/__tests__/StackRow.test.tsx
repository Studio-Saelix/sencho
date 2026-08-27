import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { StackRow } from '../StackRow';
import type { Label } from '@/components/label-types';
import { SOURCE_STATE } from '@/lib/gitopsState';

function base(overrides: Partial<ComponentProps<typeof StackRow>> = {}) {
  return {
    file: 'web.yml',
    displayName: 'web',
    status: 'running' as const,
    isBusy: false,
    isActive: false,
    labels: [] as Label[],
    hasUpdate: false,
    gitPending: null,
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
    render(<StackRow {...base({ status: 'partial', running: 3, total: 5 })} />);
    const trigger = screen.getByText('PT');
    // Radix TooltipTrigger adds data-state to the wrapped element.
    expect(trigger.getAttribute('data-state')).toBe('closed');
  });

  it('does not wrap a non-partial pill in a tooltip', () => {
    render(<StackRow {...base({ status: 'running' })} />);
    expect(screen.getByText('UP').getAttribute('data-state')).toBeNull();
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

  it('does not render trailing label color dots when labels are assigned', () => {
    const labels: Label[] = [
      { id: 1, node_id: 0, name: 'prod', color: 'teal' },
      { id: 2, node_id: 0, name: 'media', color: 'blue' },
    ];
    const { container } = render(<StackRow {...base({ labels })} />);
    expect(container.querySelectorAll('[style*="--label-"]')).toHaveLength(0);
  });

  // ── Image-update check status indicator ────────────────────────────────

  it('shows a muted check-failed indicator when the last check failed and there is no update', () => {
    const { container } = render(<StackRow {...base({ status: 'running', hasUpdate: false, checkStatus: 'failed', lastError: 'Registry unreachable' })} />);
    // The trailing slot renders a tooltip-wrapped AlertCircle icon (an SVG).
    const trailingSlot = container.querySelector('[data-state="closed"]');
    expect(trailingSlot).not.toBeNull();
    // It is not the update dot.
    expect(container.querySelector('.bg-update')).toBeNull();
  });

  it('prefers the failed indicator over the update dot when checkStatus is failed', () => {
    const { container } = render(<StackRow {...base({ status: 'running', hasUpdate: true, checkStatus: 'failed' })} />);
    expect(container.querySelector('.bg-update')).toBeNull();
    expect(screen.getByTestId('stack-trailing-check-failed')).toBeInTheDocument();
  });

  it('shows a partial indicator (not purple) for incomplete checks with hasUpdate', async () => {
    const { container } = render(<StackRow {...base({
      hasUpdate: true,
      checkStatus: 'partial',
      lastError: 'ghcr.io unreachable',
    })} />);
    expect(container.querySelector('.bg-update')).toBeNull();
    expect(screen.getByTestId('stack-trailing-check-partial')).toBeInTheDocument();
    fireEvent.pointerMove(screen.getByTestId('stack-trailing-check-partial'));
    const tips = await screen.findAllByText(/last check was incomplete/i);
    expect(tips.length).toBeGreaterThan(0);
    expect(screen.queryByText(/previous result was retained/i)).toBeNull();
    expect((await screen.findAllByText(/ghcr.io unreachable/i)).length).toBeGreaterThan(0);
  });

  it('shows the purple update dot only for confirmed ok+hasUpdate', () => {
    const { container } = render(<StackRow {...base({ hasUpdate: true, checkStatus: 'ok' })} />);
    expect(container.querySelector('.bg-update')).not.toBeNull();
  });

  it('names outdated services in the update tooltip', async () => {
    render(<StackRow {...base({ hasUpdate: true, checkStatus: 'ok', outdatedServices: ['api', 'worker'] })} />);
    fireEvent.pointerMove(screen.getByTestId('stack-trailing-update'));
    expect((await screen.findAllByText('Update available: api, worker')).length).toBeGreaterThan(0);
  });

  it('shows no trailing indicator for a clean ok check with no update', () => {
    const { container } = render(<StackRow {...base({ status: 'running', hasUpdate: false, checkStatus: 'ok' })} />);
    expect(container.querySelector('.lucide-alert-circle')).toBeNull();
    expect(container.querySelector('.bg-update')).toBeNull();
  });

  // ── Git source pending indicator ───────────────────────────────────────

  it('shows no git indicator when no candidate is waiting', () => {
    render(<StackRow {...base({ gitPending: null })} />);
    expect(screen.queryByTestId('stack-trailing-git-pending')).not.toBeInTheDocument();
  });

  it('names the waiting state in the tooltip instead of a generic one', async () => {
    render(<StackRow {...base({ gitPending: 'source_conflict_blocker' })} />);
    fireEvent.pointerMove(screen.getByTestId('stack-trailing-git-pending'));
    expect(
      (await screen.findAllByText(SOURCE_STATE.source_conflict_blocker.line)).length,
    ).toBeGreaterThan(0);
  });

  it('names the ordinary waiting state too', async () => {
    render(<StackRow {...base({ gitPending: 'candidate_ready' })} />);
    fireEvent.pointerMove(screen.getByTestId('stack-trailing-git-pending'));
    expect((await screen.findAllByText(SOURCE_STATE.candidate_ready.line)).length).toBeGreaterThan(0);
  });

  it('renders the same indicator whatever the waiting state is', () => {
    // The state changes the tooltip, never the pixels. This is what keeps the
    // sidebar's rendered output unchanged from before the states existed.
    const { container: blocked } = render(<StackRow {...base({ gitPending: 'source_conflict_blocker' })} />);
    const { container: ready } = render(<StackRow {...base({ gitPending: 'candidate_ready' })} />);
    const markup = (root: HTMLElement) =>
      root.querySelector('[data-testid="stack-row-trailing"]')?.outerHTML;
    // Non-empty first: two missing indicators would otherwise compare equal.
    expect(markup(blocked)).toContain('stack-trailing-git-pending');
    expect(markup(blocked)).toBe(markup(ready));
  });

  it('keeps a confirmed update above the git indicator in the trailing slot', () => {
    render(<StackRow {...base({ gitPending: 'candidate_ready', hasUpdate: true, checkStatus: 'ok' })} />);
    expect(screen.getByTestId('stack-trailing-update')).toBeInTheDocument();
    expect(screen.queryByTestId('stack-trailing-git-pending')).not.toBeInTheDocument();
  });

  it('constrains long stack names so trailing indicators stay in the row', () => {
    const longName = 'tick-grafana-docker-observability-stack';
    render(<StackRow {...base({ displayName: longName })} />);
    expect(screen.getByTestId('stack-row')).toHaveClass('min-w-0');
    expect(screen.getByText(longName)).toHaveClass('truncate');
  });
});
