import { describe, it, expect, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useStackKeyboardShortcuts } from '../useStackKeyboardShortcuts';
import type { StackMenuCtx } from '@/components/sidebar/sidebar-types';

function makeCtx(overrides: Partial<StackMenuCtx> = {}): StackMenuCtx {
  return {
    stackStatus: 'running',
    isSelfStack: false,
    ready: true,
    canOpenApp: true,
    isBusy: false,
    isAdmin: true,
    canDelete: true,
    canDeploy: true,
    canEditLabels: true,
    canCreateLabels: true,
    isPinned: false,
    labels: [],
    assignedLabelIds: [],
    menuVisibility: { showDeploy: true, showStop: true, showRestart: true, showUpdate: true, showTakeDown: true },
    openAlertSheet: vi.fn(),
    openAutoHeal: vi.fn(),
    canViewMonitor: true,
    checkUpdates: vi.fn(),
    canCheckUpdates: true,
    openStackApp: vi.fn(),
    deploy: vi.fn(),
    stop: vi.fn(),
    restart: vi.fn(),
    update: vi.fn(),
    takeDown: vi.fn(),
    remove: vi.fn(),
    pin: vi.fn(),
    unpin: vi.fn(),
    toggleLabel: vi.fn(),
    createAndAssignLabel: vi.fn(),
    openLabelManager: vi.fn(),
    openScheduleTask: vi.fn(),
    canMuteNotifications: false,
    muteStackAll: vi.fn(),
    muteStackDeploySuccess: vi.fn(),
    muteStackMonitor: vi.fn(),
    openStackMuteRules: vi.fn(),
    muteLabelAll: vi.fn(),
    muteLabelExternal: vi.fn(),
    muteLabelLowPriority: vi.fn(),
    openLabelMuteRules: vi.fn(),
    ...overrides,
  };
}

function pressKey(key: string) {
  window.dispatchEvent(new KeyboardEvent('keydown', { key }));
}

describe('useStackKeyboardShortcuts monitor gating', () => {
  it('opens the Alerts sheet on "a" when canViewMonitor', () => {
    const ctx = makeCtx({ canViewMonitor: true });
    renderHook(() => useStackKeyboardShortcuts('web.yml', () => ctx));
    pressKey('a');
    expect(ctx.openAlertSheet).toHaveBeenCalled();
  });

  it('ignores "a" when !canViewMonitor', () => {
    const ctx = makeCtx({ canViewMonitor: false });
    renderHook(() => useStackKeyboardShortcuts('web.yml', () => ctx));
    pressKey('a');
    expect(ctx.openAlertSheet).not.toHaveBeenCalled();
  });

  it('opens Auto-Heal on "h" when canViewMonitor', () => {
    const ctx = makeCtx({ canViewMonitor: true });
    renderHook(() => useStackKeyboardShortcuts('web.yml', () => ctx));
    pressKey('h');
    expect(ctx.openAutoHeal).toHaveBeenCalled();
  });

  it('ignores "h" when !canViewMonitor', () => {
    const ctx = makeCtx({ canViewMonitor: false });
    renderHook(() => useStackKeyboardShortcuts('web.yml', () => ctx));
    pressKey('h');
    expect(ctx.openAutoHeal).not.toHaveBeenCalled();
  });

  it('still gates "u" (check updates) on canCheckUpdates', () => {
    const ctx = makeCtx({ canCheckUpdates: false });
    renderHook(() => useStackKeyboardShortcuts('web.yml', () => ctx));
    pressKey('u');
    expect(ctx.checkUpdates).not.toHaveBeenCalled();
  });
});
