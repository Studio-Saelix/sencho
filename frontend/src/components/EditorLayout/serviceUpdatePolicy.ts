import {
  SENCHO_UPDATE_CHECK_LABEL,
  SENCHO_UPDATE_IGNORE_LABEL,
  SENCHO_UPDATE_LABEL,
  updateCheckOf,
  updatePolicyOf,
  type SenchoLabelResolution,
} from '@/lib/senchoLabels';
import type { StackServiceUpdateStatus } from '@/types/imageUpdates';

/**
 * How the service's `io.sencho.update` label reads next to its links, or null
 * when it declares none or `auto`. Kept out of the component module so Fast
 * Refresh still treats that module as components only.
 */
export function updatePolicyChip(
  resolution: SenchoLabelResolution | null | undefined,
  service: string | undefined,
): { label: string; title: string } | null {
  switch (updatePolicyOf(resolution, service)) {
    case 'manual':
      return {
        label: 'Updates: manual',
        title: `${SENCHO_UPDATE_LABEL}: manual. Sencho updates this service only when you start the update.`,
      };
    case 'disabled':
      return {
        label: 'Updates: off',
        title: `${SENCHO_UPDATE_LABEL}: disabled. Sencho refuses updates for this service. Change the label in the Compose file to allow them.`,
      };
    case 'invalid':
      return {
        label: 'Updates: unattended off',
        title: `${SENCHO_UPDATE_LABEL} has an unrecognized value, so scheduled and automatic updates skip this service. Manual updates are still allowed.`,
      };
    default:
      return null;
  }
}

/**
 * Whether the service's declared policy keeps its Update affordance off. The
 * backend refuses the request either way; this only keeps the button from
 * offering an update the label rules out.
 */
export function serviceUpdateButtonState(
  resolution: SenchoLabelResolution | null | undefined,
  service: string | undefined,
): { disabled: boolean; title?: string } {
  if (updatePolicyOf(resolution, service) !== 'disabled') return { disabled: false };
  return {
    disabled: true,
    title: `${SENCHO_UPDATE_LABEL} is set to disabled in the Compose file, so updates are off for this service. Change the label to allow them.`,
  };
}

/**
 * How the service's update detection labels read next to its links. Checks off
 * comes from the label itself; a skip shows only when the last check actually
 * skipped a pending update, so the chip never claims a skip that matched
 * nothing.
 */
export function detectionChips(
  resolution: SenchoLabelResolution | null | undefined,
  service: string | undefined,
  status: Pick<StackServiceUpdateStatus, 'detection'> | undefined,
): { key: 'off' | 'ignored'; label: string; title: string }[] {
  const chips: { key: 'off' | 'ignored'; label: string; title: string }[] = [];
  if (!updateCheckOf(resolution, service)) {
    chips.push({
      key: 'off',
      label: 'Update checks: off',
      title: `${SENCHO_UPDATE_CHECK_LABEL}: false. Sencho does not check this service's image for updates. A stack update still pulls it.`,
    });
  } else if (status?.detection === 'ignored') {
    chips.push({
      key: 'ignored',
      label: 'Update skipped',
      title: `${SENCHO_UPDATE_IGNORE_LABEL} skips the pending update for this service. A newer update reports again. A stack update still pulls it.`,
    });
  }
  return chips;
}
