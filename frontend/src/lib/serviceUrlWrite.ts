import { renameRetiredServiceUrlLabel } from './composeServiceUrl';
import { ignoredLabels } from './senchoLabels';
import { RETIRED_URL_LABEL } from './serviceUrlLabel';
import { senchoLabelsOf, type ServiceUrlEntry } from './serviceUrlResolve';

/**
 * Persist a service URL, then show the patched compose text in the editor.
 * The buffer changes only after the write is accepted, so a refused save
 * cannot leave an abandoned URL for a later Save to persist.
 */
export async function commitServiceUrlWrite<T extends { ok: boolean }>(
  patched: string,
  save: () => Promise<T>,
  applyContent: (content: string) => void,
): Promise<T> {
  const result = await save();
  if (result.ok) applyContent(patched);
  return result;
}

export type RetiredRenamePlan = { ok: true; next: string } | { ok: false; message: string };

/**
 * What a click on "Rename to io.sencho.url" may do to the open compose buffer:
 * the rewritten text, or the one sentence that says why nothing is written.
 */
export function planRetiredUrlRename(input: {
  content: string;
  originalContent: string;
  canEdit: boolean;
  service: string;
}): RetiredRenamePlan {
  if (!input.canEdit) return { ok: false, message: 'You cannot edit this stack.' };
  if (input.content !== input.originalContent) {
    return { ok: false, message: 'Save or discard your changes to the compose file first, then rename the label.' };
  }
  let patched: ReturnType<typeof renameRetiredServiceUrlLabel>;
  try {
    patched = renameRetiredServiceUrlLabel(input.content, input.service);
  } catch (error) {
    console.error('Failed to rename the service URL label:', error);
    return { ok: false, message: 'The compose file could not be updated.' };
  }
  if (!patched.ok) {
    return {
      ok: false,
      message: patched.reason === 'missing-service'
        ? 'That service is defined in another compose file.'
        : patched.reason === 'unsupported'
          ? 'The label cannot be renamed here without changing other parts of this compose file. Rename it in the editor instead.'
          : 'The compose file could not be read as YAML. Fix it in the editor, then try again.',
    };
  }
  if (patched.yaml === input.content) {
    return { ok: false, message: 'The label is not in the open compose file. Rename it in the file that sets it.' };
  }
  return { ok: true, next: patched.yaml };
}

/** Whether a fresh node answer shows the retired label gone from the service: the only proof a rename took effect. */
export function retiredRenameVerified(entry: ServiceUrlEntry | null | undefined, service: string): boolean {
  if (entry?.status !== 'ready') return false;
  return !ignoredLabels(senchoLabelsOf(entry), service).some(label => label.key === RETIRED_URL_LABEL);
}
