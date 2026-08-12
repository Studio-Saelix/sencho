import type { LucideIcon } from 'lucide-react';
import type { Label, LabelColor } from '../label-types';

export type MenuGroupId = 'inspect' | 'organize' | 'lifecycle' | 'destructive';

export interface MenuItem {
  id: string;
  label: string;
  icon: LucideIcon;
  shortcut?: string;
  onSelect: () => void;
  disabled?: boolean;
  destructive?: boolean;
  subItems?: MenuItem[];
}

export interface MenuGroup {
  id: MenuGroupId;
  items: MenuItem[];
}

export type StackLifecycleStatus = 'running' | 'exited' | 'unknown';

export interface StackMenuCtx {
  stackStatus: StackLifecycleStatus;
  /** False while status evidence is not authoritative for the active node/list;
   *  gates schedule/delete items that permissions alone would expose. */
  ready: boolean;
  /** True when this stack is the running Sencho instance on the active node. */
  isSelfStack: boolean;
  canOpenApp: boolean;
  isBusy: boolean;
  isAdmin: boolean;
  canDelete: boolean;
  canDeploy: boolean;
  canEditLabels: boolean;
  canCreateLabels: boolean;
  isPinned: boolean;
  labels: Label[];
  assignedLabelIds: number[];
  menuVisibility: { showDeploy: boolean; showStop: boolean; showRestart: boolean; showUpdate: boolean; showTakeDown: boolean };
  openAlertSheet: () => void;
  openAutoHeal: () => void;
  /** True when the caller may view stack alerts/auto-heal (stack:read). */
  canViewMonitor: boolean;
  /** True when the caller may trigger a stack image-update check (stack:deploy). */
  canCheckUpdates: boolean;
  checkUpdates: () => void;
  openStackApp: () => void;
  deploy: () => void;
  stop: () => void;
  restart: () => void;
  update: () => void;
  takeDown: () => void;
  remove: () => void;
  pin: () => void;
  unpin: () => void;
  toggleLabel: (labelId: number) => void;
  createAndAssignLabel: (name: string, color: LabelColor) => Promise<void>;
  canMuteNotifications: boolean;
  muteStackAll: () => void;
  muteStackDeploySuccess: () => void;
  muteStackMonitor: () => void;
  openStackMuteRules: () => void;
  muteLabelAll: (labelId: number, labelName: string) => void;
  muteLabelExternal: (labelId: number, labelName: string) => void;
  muteLabelLowPriority: (labelId: number, labelName: string) => void;
  openLabelMuteRules: (labelId: number, labelName: string) => void;
  openLabelManager: () => void;
  openScheduleTask: () => void;
}

export type StackGroupKind = 'pinned' | 'labeled' | 'unlabeled';

export type FilterChip = 'all' | 'up' | 'down' | 'updates';
