import { useMemo } from 'react';
import {
  Activity,
  ArrowUpRight,
  BellRing,
  CalendarClock,
  Download,
  Pin,
  PinOff,
  Play,
  RefreshCw,
  RotateCw,
  Square,
  Tag,
  Trash2,
} from 'lucide-react';
import type { MenuGroup, MenuItem, StackMenuCtx } from '@/components/sidebar/sidebar-types';

export function useStackMenuItems(_file: string, ctx: StackMenuCtx): MenuGroup[] {
  const {
    stackStatus, hasPort, isBusy, isAdmin, canDelete, canEditLabels, isPinned, labels,
    openAlertSheet, openAutoHeal, checkUpdates, openStackApp,
    deploy, stop, restart, update, remove, pin, unpin, toggleLabel,
    menuVisibility, openScheduleTask,
  } = ctx;
  const { showDeploy, showStop, showRestart, showUpdate } = menuVisibility;

  return useMemo(() => {
    const groups: MenuGroup[] = [];

    const inspect: MenuItem[] = [
      { id: 'alerts', label: 'Alerts', icon: BellRing, shortcut: 'A', onSelect: openAlertSheet },
      { id: 'auto-heal', label: 'Auto-Heal', icon: Activity, shortcut: 'H', onSelect: openAutoHeal },
    ];
    inspect.push({ id: 'check-updates', label: 'Check updates', icon: RefreshCw, shortcut: 'U', onSelect: checkUpdates });
    if (stackStatus === 'running' && hasPort) {
      inspect.push({ id: 'open-app', label: 'Open App', icon: ArrowUpRight, shortcut: '↗', onSelect: openStackApp });
    }
    groups.push({ id: 'inspect', items: inspect });

    const organize: MenuItem[] = [];
    if (canEditLabels) {
      organize.push({
        id: 'labels',
        label: 'Labels',
        icon: Tag,
        shortcut: 'L ›',
        onSelect: () => {},
        subItems: labels.map(l => ({
          id: `label:${l.id}`,
          label: l.name,
          icon: Tag,
          onSelect: () => toggleLabel(l.id),
        })),
      });
    }
    organize.push(
      isPinned
        ? { id: 'pin', label: 'Unpin', icon: PinOff, shortcut: 'P', onSelect: unpin }
        : { id: 'pin', label: 'Pin to top', icon: Pin, shortcut: 'P', onSelect: pin }
    );
    groups.push({ id: 'organize', items: organize });

    const lifecycle: MenuItem[] = [];
    if (showDeploy) lifecycle.push({ id: 'deploy', label: 'Deploy', icon: Play, shortcut: '⌘↵', onSelect: deploy, disabled: isBusy });
    if (showStop) lifecycle.push({ id: 'stop', label: 'Stop', icon: Square, shortcut: '⌘.', onSelect: stop, disabled: isBusy });
    if (showRestart) lifecycle.push({ id: 'restart', label: 'Restart', icon: RotateCw, shortcut: '⌘R', onSelect: restart, disabled: isBusy });
    if (showUpdate) lifecycle.push({ id: 'update', label: 'Update', icon: Download, shortcut: '⌘↑', onSelect: update, disabled: isBusy });
    if (isAdmin) lifecycle.push({ id: 'schedule', label: 'Schedule task', icon: CalendarClock, onSelect: openScheduleTask });
    if (lifecycle.length > 0) groups.push({ id: 'lifecycle', items: lifecycle });

    if (canDelete) {
      groups.push({
        id: 'destructive',
        items: [{ id: 'delete', label: 'Delete', icon: Trash2, shortcut: '⌘⌫', destructive: true, onSelect: remove }],
      });
    }

    return groups;
  }, [
    stackStatus, hasPort, isBusy, isAdmin, canDelete, canEditLabels, isPinned, labels,
    showDeploy, showStop, showRestart, showUpdate,
    openAlertSheet, openAutoHeal, checkUpdates, openStackApp,
    deploy, stop, restart, update, remove, pin, unpin, toggleLabel, openScheduleTask,
  ]);
}
