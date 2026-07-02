import { describe, it, expect, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { BellRing, Trash2 } from 'lucide-react';
import { useStackMenuItems } from '../useStackMenuItems';
import type { StackMenuCtx } from '@/components/sidebar/sidebar-types';

function makeCtx(overrides: Partial<StackMenuCtx> = {}): StackMenuCtx {
  return {
    stackStatus: 'running',
    canOpenApp: true,
    isBusy: false,
    isAdmin: true,
    canDelete: true,
    canEditLabels: true,
    canCreateLabels: true,
    isPinned: false,
    labels: [],
    assignedLabelIds: [],
    menuVisibility: { showDeploy: false, showStop: true, showRestart: true, showUpdate: false },
    openAlertSheet: vi.fn(),
    openAutoHeal: vi.fn(),
    checkUpdates: vi.fn(),
    openStackApp: vi.fn(),
    deploy: vi.fn(),
    stop: vi.fn(),
    restart: vi.fn(),
    update: vi.fn(),
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

describe('useStackMenuItems', () => {
  it('returns Inspect / Organize / Lifecycle / Destructive groups in order', () => {
    const { result } = renderHook(() => useStackMenuItems('web.yml', makeCtx()));
    expect(result.current.map(g => g.id)).toEqual(['inspect', 'organize', 'lifecycle', 'destructive']);
  });

  it('always includes Alerts in Inspect', () => {
    const { result } = renderHook(() => useStackMenuItems('web.yml', makeCtx()));
    const inspect = result.current.find(g => g.id === 'inspect')!;
    expect(inspect.items.some(i => i.icon === BellRing)).toBe(true);
  });

  it('always includes Auto-Heal in Inspect', () => {
    const { result } = renderHook(() => useStackMenuItems('web.yml', makeCtx()));
    const inspect = result.current.find(g => g.id === 'inspect')!;
    expect(inspect.items.find(i => i.id === 'auto-heal')).toBeDefined();
  });

  it('shows Open App when running and canOpenApp', () => {
    const { result } = renderHook(() => useStackMenuItems('web.yml', makeCtx()));
    const inspect = result.current.find(g => g.id === 'inspect')!;
    expect(inspect.items.find(i => i.id === 'open-app')).toBeDefined();
  });

  it('hides Open App when the stack is not running', () => {
    const { result } = renderHook(() => useStackMenuItems('web.yml', makeCtx({ stackStatus: 'exited' })));
    const inspect = result.current.find(g => g.id === 'inspect')!;
    expect(inspect.items.find(i => i.id === 'open-app')).toBeUndefined();
  });

  it('hides Open App when no reachable URL can be built (canOpenApp false)', () => {
    const { result } = renderHook(() => useStackMenuItems('web.yml', makeCtx({ canOpenApp: false })));
    const inspect = result.current.find(g => g.id === 'inspect')!;
    expect(inspect.items.find(i => i.id === 'open-app')).toBeUndefined();
  });

  it('toggles Pin / Unpin label based on isPinned', () => {
    const pinned = renderHook(() => useStackMenuItems('web.yml', makeCtx({ isPinned: true })));
    const unpinned = renderHook(() => useStackMenuItems('web.yml', makeCtx({ isPinned: false })));
    const pinnedOrganize = pinned.result.current.find(g => g.id === 'organize')!;
    const unpinnedOrganize = unpinned.result.current.find(g => g.id === 'organize')!;
    expect(pinnedOrganize.items.find(i => i.id === 'pin')!.label).toBe('Unpin');
    expect(unpinnedOrganize.items.find(i => i.id === 'pin')!.label).toBe('Pin to top');
  });

  it('omits Destructive group entirely when !canDelete', () => {
    const { result } = renderHook(() => useStackMenuItems('web.yml', makeCtx({ canDelete: false })));
    expect(result.current.find(g => g.id === 'destructive')).toBeUndefined();
  });

  it('marks Delete item destructive with Trash2 icon', () => {
    const { result } = renderHook(() => useStackMenuItems('web.yml', makeCtx()));
    const destructive = result.current.find(g => g.id === 'destructive')!;
    const del = destructive.items.find(i => i.id === 'delete')!;
    expect(del.destructive).toBe(true);
    expect(del.icon).toBe(Trash2);
  });

  it('does not show an auto-update entry; Schedule task is the auto-update path', () => {
    const admin = renderHook(() => useStackMenuItems('web.yml', makeCtx({ isAdmin: true })));
    const viewer = renderHook(() => useStackMenuItems('web.yml', makeCtx({ isAdmin: false })));
    for (const r of [admin, viewer]) {
      const groups = r.result.current;
      expect(groups.some(g => g.items.some(i => i.id === 'auto-update'))).toBe(false);
    }
    const lifecycle = admin.result.current.find(g => g.id === 'lifecycle')!;
    expect(lifecycle.items.some(i => i.id === 'schedule')).toBe(true);
  });

  it('hides Schedule task when not admin', () => {
    const { result } = renderHook(() => useStackMenuItems('web.yml', makeCtx({ isAdmin: false })));
    const lifecycle = result.current.find(g => g.id === 'lifecycle');
    expect(lifecycle?.items.some(i => i.id === 'schedule')).toBeFalsy();
  });

  it('includes Mute submenu in Inspect when canMuteNotifications', () => {
    const { result } = renderHook(() => useStackMenuItems('web.yml', makeCtx({ canMuteNotifications: true })));
    const inspect = result.current.find(g => g.id === 'inspect')!;
    const muteItem = inspect.items.find(i => i.id === 'mute');
    expect(muteItem).toBeDefined();
    expect(muteItem?.subItems?.map(s => s.id)).toEqual([
      'mute-stack-all',
      'mute-stack-deploy',
      'mute-stack-monitor',
      'mute-stack-manage',
    ]);
  });

  it('hides Mute submenu when canMuteNotifications is false', () => {
    const { result } = renderHook(() => useStackMenuItems('web.yml', makeCtx({ canMuteNotifications: false })));
    const inspect = result.current.find(g => g.id === 'inspect')!;
    expect(inspect.items.find(i => i.id === 'mute')).toBeUndefined();
  });

  it('keeps label assignment available for any tier', () => {
    const { result } = renderHook(() => useStackMenuItems('web.yml', makeCtx({
      labels: [{ id: 1, node_id: 0, name: 'prod', color: 'teal' }],
    })));
    const organize = result.current.find(g => g.id === 'organize')!;
    const labelsItem = organize.items.find(i => i.id === 'labels');
    expect(labelsItem).toBeDefined();
    expect(labelsItem?.subItems?.[0]).toMatchObject({ id: 'label:1', label: 'prod' });
  });

  it('hides the Labels submenu when !canEditLabels (viewer role)', () => {
    const { result } = renderHook(() => useStackMenuItems('web.yml', makeCtx({
      canEditLabels: false,
      labels: [{ id: 1, node_id: 0, name: 'prod', color: 'teal' }],
    })));
    const organize = result.current.find(g => g.id === 'organize')!;
    expect(organize.items.find(i => i.id === 'labels')).toBeUndefined();
    expect(organize.items.find(i => i.id === 'pin')).toBeDefined();
  });

  it('lifecycle items follow menuVisibility flags', () => {
    const { result } = renderHook(() => useStackMenuItems('web.yml', makeCtx({
      menuVisibility: { showDeploy: true, showStop: false, showRestart: false, showUpdate: true },
    })));
    const lifecycle = result.current.find(g => g.id === 'lifecycle')!;
    const ids = lifecycle.items.map(i => i.id);
    expect(ids).toEqual(['deploy', 'update', 'schedule']);
  });

  it('disables action lifecycle items when isBusy but leaves schedule enabled', () => {
    const { result } = renderHook(() => useStackMenuItems('web.yml', makeCtx({
      isBusy: true,
      menuVisibility: { showDeploy: true, showStop: true, showRestart: true, showUpdate: true },
    })));
    const lifecycle = result.current.find(g => g.id === 'lifecycle')!;
    const actionItems = lifecycle.items.filter(i => i.id !== 'schedule');
    expect(actionItems.every(i => i.disabled === true)).toBe(true);
    const scheduleItem = lifecycle.items.find(i => i.id === 'schedule')!;
    expect(scheduleItem.disabled).toBeFalsy();
  });
});
