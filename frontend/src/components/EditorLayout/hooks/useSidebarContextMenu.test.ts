import { describe, it, expect, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useSidebarContextMenu } from './useSidebarContextMenu';
import type { Node } from '@/context/NodeContext';

// buildMenuCtx derives canOpenApp from the active node plus the stack's
// published port; only the fields it reads need to be real, the handler
// closures are never invoked here.
function makeOptions(
  activeNode: Node | null,
  stackPorts: Record<string, number | undefined>,
  stackStatuses: Record<string, string> = { 'web.yml': 'running' },
) {
  const stackListState = {
    stackStatuses,
    stackPorts,
    isStackBusy: () => false,
    isPinned: () => false,
    labels: [],
    stackLabelMap: {},
    pin: vi.fn(),
    unpin: vi.fn(),
    refreshLabels: vi.fn(),
  };
  const stackActions = {
    getStackMenuVisibility: () => ({ showDeploy: false, showStop: true, showRestart: true, showUpdate: false }),
    checkUpdatesForStack: vi.fn(),
    openStackApp: vi.fn(),
    executeStackActionByFile: vi.fn(),
  };
  const overlayState = { openAlertSheet: vi.fn(), openAutoHeal: vi.fn(), openDeleteDialog: vi.fn() };
  const navState = { handleOpenSettings: vi.fn(), setSchedulePrefill: vi.fn(), setActiveView: vi.fn() };
  return {
    stackListState,
    navState,
    overlayState,
    stackActions,
    activeNode,
    isAdmin: true,
    can: () => true,
  } as unknown as Parameters<typeof useSidebarContextMenu>[0];
}

describe('useSidebarContextMenu canOpenApp', () => {
  it('is true for a local node with a published port', () => {
    const { result } = renderHook(() =>
      useSidebarContextMenu(makeOptions({ id: 1, type: 'local' } as Node, { 'web.yml': 8989 })));
    expect(result.current('web.yml').canOpenApp).toBe(true);
  });

  it('is true for a remote node with an api_url host and a port', () => {
    const { result } = renderHook(() =>
      useSidebarContextMenu(makeOptions({ id: 4, type: 'remote', api_url: 'http://10.0.0.5:1852' } as Node, { 'web.yml': 8989 })));
    expect(result.current('web.yml').canOpenApp).toBe(true);
  });

  it('is false for a remote pilot node (no api_url) even with a port', () => {
    const { result } = renderHook(() =>
      useSidebarContextMenu(makeOptions({ id: 2, type: 'remote', api_url: '' } as Node, { 'web.yml': 8989 })));
    expect(result.current('web.yml').canOpenApp).toBe(false);
  });

  it('is false when the stack has no published port', () => {
    const { result } = renderHook(() =>
      useSidebarContextMenu(makeOptions({ id: 1, type: 'local' } as Node, {})));
    expect(result.current('web.yml').canOpenApp).toBe(false);
  });
});

describe('useSidebarContextMenu stackStatus', () => {
  it('maps a partial stack to running so it gets running-stack actions', () => {
    const { result } = renderHook(() =>
      useSidebarContextMenu(makeOptions({ id: 1, type: 'local' } as Node, {}, { 'web.yml': 'partial' })));
    expect(result.current('web.yml').stackStatus).toBe('running');
  });

  it('passes exited and unknown through unchanged', () => {
    const exited = renderHook(() =>
      useSidebarContextMenu(makeOptions({ id: 1, type: 'local' } as Node, {}, { 'web.yml': 'exited' })));
    expect(exited.result.current('web.yml').stackStatus).toBe('exited');

    const missing = renderHook(() =>
      useSidebarContextMenu(makeOptions({ id: 1, type: 'local' } as Node, {}, {})));
    expect(missing.result.current('web.yml').stackStatus).toBe('unknown');
  });
});
