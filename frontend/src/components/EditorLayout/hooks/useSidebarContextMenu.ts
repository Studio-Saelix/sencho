import { useCallback } from 'react';
import { apiFetch } from '@/lib/api';
import { toast } from '@/components/ui/toast-store';
import type { StackMenuCtx } from '@/components/sidebar/sidebar-types';
import type { Label as StackLabel, LabelColor } from '../../label-types';
import type { OverlayState } from './useOverlayState';
import type { StackActionsHook } from './useStackActions';
import type { useStackListState } from './useStackListState';
import type { useViewNavigationState } from './useViewNavigationState';
import type { Node } from '@/context/NodeContext';
import type { PermissionAction } from '@/context/AuthContext';

type StackListState = ReturnType<typeof useStackListState>;
type NavState = ReturnType<typeof useViewNavigationState>;

interface UseSidebarContextMenuOptions {
  stackListState: StackListState;
  navState: NavState;
  overlayState: OverlayState;
  stackActions: StackActionsHook;
  activeNode: Node | null | undefined;
  isAdmin: boolean;
  can: (action: PermissionAction, resourceType?: string, resourceId?: string) => boolean;
}

export function useSidebarContextMenu({
  stackListState,
  navState,
  overlayState,
  stackActions,
  activeNode,
  isAdmin,
  can,
}: UseSidebarContextMenuOptions) {
  const buildMenuCtx = useCallback((file: string): StackMenuCtx => {
    const sName = file.replace(/\.(yml|yaml)$/, '');
    return {
      stackStatus: (stackListState.stackStatuses[file] ?? 'unknown') as 'running' | 'exited' | 'unknown',
      hasPort: Boolean(stackListState.stackPorts[file]),
      isBusy: stackListState.isStackBusy(file),
      isAdmin,
      canDelete: can('stack:delete', 'stack', sName),
      canEditLabels: can('stack:edit', 'stack', sName),
      // POST /api/labels (the inline "New label" entry) is guarded by the
      // unscoped requirePermission('stack:edit'); a user with only per-stack
      // scoped edit can toggle existing labels but cannot create new ones.
      canCreateLabels: can('stack:edit'),
      isPinned: stackListState.isPinned(file),
      labels: stackListState.labels,
      assignedLabelIds: (stackListState.stackLabelMap[file] ?? []).map(l => l.id),
      menuVisibility: stackActions.getStackMenuVisibility(file),
      openAlertSheet: () => overlayState.openAlertSheet(file),
      openAutoHeal: () => overlayState.openAutoHeal(file),
      checkUpdates: () => stackActions.checkUpdatesForStack(),
      openStackApp: () => stackActions.openStackApp(file),
      deploy: () => stackActions.executeStackActionByFile(file, 'deploy', 'deploy'),
      stop: () => stackActions.executeStackActionByFile(file, 'stop', 'stop'),
      restart: () => stackActions.executeStackActionByFile(file, 'restart', 'restart'),
      update: () => stackActions.executeStackActionByFile(file, 'update', 'update'),
      remove: () => overlayState.openDeleteDialog(sName),
      pin: () => stackListState.pin(file),
      unpin: () => stackListState.unpin(file),
      toggleLabel: async (labelId: number) => {
        const currentIds = (stackListState.stackLabelMap[file] ?? []).map(l => l.id);
        const assigned = currentIds.includes(labelId);
        const newIds = assigned ? currentIds.filter(id => id !== labelId) : [...currentIds, labelId];
        const loadingId = toast.loading('Updating labels...');
        try {
          const res = await apiFetch(`/stacks/${encodeURIComponent(file)}/labels`, {
            method: 'PUT',
            body: JSON.stringify({ labelIds: newIds }),
          });
          if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            throw new Error((data as { error?: string })?.error || 'Failed to update labels.');
          }
          stackListState.refreshLabels();
        } catch (err: unknown) {
          toast.error((err as Error)?.message || 'Failed to update labels.');
        } finally {
          toast.dismiss(loadingId);
        }
      },
      createAndAssignLabel: async (name: string, color: LabelColor) => {
        const loadingId = toast.loading('Creating label...');
        try {
          const createRes = await apiFetch('/labels', {
            method: 'POST',
            body: JSON.stringify({ name, color }),
          });
          if (!createRes.ok) {
            const data = await createRes.json().catch(() => ({}));
            throw new Error((data as { error?: string })?.error || 'Failed to create label.');
          }
          const created: StackLabel = await createRes.json();
          const currentIds = (stackListState.stackLabelMap[file] ?? []).map(l => l.id);
          const newIds = [...currentIds, created.id];
          const assignRes = await apiFetch(`/stacks/${encodeURIComponent(file)}/labels`, {
            method: 'PUT',
            body: JSON.stringify({ labelIds: newIds }),
          });
          if (!assignRes.ok) {
            const data = await assignRes.json().catch(() => ({}));
            throw new Error((data as { error?: string })?.error || 'Failed to assign label.');
          }
          toast.success(`Label "${created.name}" created.`);
          stackListState.refreshLabels();
        } catch (err: unknown) {
          toast.error((err as Error)?.message || 'Failed to create label.');
          throw err;
        } finally {
          toast.dismiss(loadingId);
        }
      },
      openLabelManager: () => navState.handleOpenSettings('labels'),
      openScheduleTask: () => {
        navState.setSchedulePrefill({ stackName: sName, nodeId: activeNode?.id ?? null });
        navState.setActiveView('scheduled-ops');
      },
    };
    // Handlers from useStackActions, useOverlayState, useViewNavigationState are
    // useCallback-stabilized at their owner hooks, so listing the menu surface
    // values (status maps, role/tier flags, pin state) is sufficient. Exhaustive
    // deps would force a rebuild on every parent render and defeat the memo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    stackListState.stackStatuses, stackListState.stackPorts, isAdmin,
    stackListState.isPinned, stackListState.labels, stackListState.stackLabelMap,
    stackListState.pin, stackListState.unpin,
  ]);

  return buildMenuCtx;
}
