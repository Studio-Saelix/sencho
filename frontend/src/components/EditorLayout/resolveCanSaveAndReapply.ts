/** Toolbar/diff eligibility: admin + node reapply + selected file is self-stack. */
export function resolveCanSaveAndReapply(
  isAdmin: boolean,
  canReapplyCompose: boolean,
  isSelfStack: boolean,
): boolean {
  return isAdmin && canReapplyCompose && isSelfStack;
}
