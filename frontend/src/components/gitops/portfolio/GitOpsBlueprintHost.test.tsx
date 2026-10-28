/**
 * The workplace hosts a Blueprint's sheet and the create dialog itself, so a
 * handoff from a row or the masthead never leaves GitOps. A host that takes a
 * request marks it handled, which is what keeps the Fleet fallback from also firing.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { GitOpsBlueprintHost } from './GitOpsBlueprintHost';
import { openBlueprintInPlace } from './portfolioNavigation';
import { clearBlueprintIntent, peekBlueprintIntent } from '@/lib/blueprintIntent';

const hook = vi.hoisted(() => ({
  openBlueprint: vi.fn(),
  openCreate: vi.fn(),
  options: undefined as undefined | { onChanged: () => unknown; showPortfolioLink?: boolean },
}));

vi.mock('@/components/blueprints/useBlueprintSheets', () => ({
  useBlueprintSheets: (options: { onChanged: () => unknown; showPortfolioLink?: boolean }) => {
    hook.options = options;
    return { openBlueprint: hook.openBlueprint, openCreate: hook.openCreate, canCreate: true, sheets: <div data-testid="sheets" /> };
  },
}));

afterEach(() => {
  hook.openBlueprint.mockReset();
  hook.openCreate.mockReset();
  clearBlueprintIntent();
});

describe('GitOpsBlueprintHost', () => {
  it('renders the shared sheets, told they sit over GitOps', () => {
    render(<GitOpsBlueprintHost />);
    expect(screen.getByTestId('sheets')).toBeInTheDocument();
    expect(hook.options?.showPortfolioLink).toBe(false);
  });

  it('opens a requested Blueprint in place and does not fall back to Fleet', () => {
    render(<GitOpsBlueprintHost />);
    act(() => openBlueprintInPlace({ kind: 'open', blueprintId: 7 }));
    expect(hook.openBlueprint).toHaveBeenCalledWith(7);
    expect(hook.openCreate).not.toHaveBeenCalled();
    expect(peekBlueprintIntent()).toBeNull();
  });

  it('opens the create dialog in place', () => {
    render(<GitOpsBlueprintHost />);
    act(() => openBlueprintInPlace({ kind: 'create' }));
    expect(hook.openCreate).toHaveBeenCalledTimes(1);
    expect(peekBlueprintIntent()).toBeNull();
  });

  it('announces a gitops change on the hub when a Blueprint changes, so the list rereads', () => {
    render(<GitOpsBlueprintHost />);
    const seen: Array<{ scope?: string; nodeId?: number }> = [];
    const handler = (e: Event) => seen.push((e as CustomEvent).detail);
    window.addEventListener('sencho:state-invalidate', handler);
    hook.options?.onChanged();
    window.removeEventListener('sencho:state-invalidate', handler);
    expect(seen).toEqual([{ scope: 'gitops' }]);
  });

  it('stops answering once unmounted, so the Fleet fallback takes over', () => {
    const { unmount } = render(<GitOpsBlueprintHost />);
    unmount();
    act(() => openBlueprintInPlace({ kind: 'open', blueprintId: 7 }));
    expect(hook.openBlueprint).not.toHaveBeenCalled();
    expect(peekBlueprintIntent()).toEqual({ kind: 'open', blueprintId: 7 });
  });

  it('lets only the first of two hosts take a request', () => {
    render(<><GitOpsBlueprintHost /><GitOpsBlueprintHost /></>);
    act(() => openBlueprintInPlace({ kind: 'open', blueprintId: 7 }));
    expect(hook.openBlueprint).toHaveBeenCalledTimes(1);
  });

  it('reports success to the sheets, since there is no list of its own to reread', () => {
    render(<GitOpsBlueprintHost />);
    expect(hook.options?.onChanged()).toBe(true);
  });
});
