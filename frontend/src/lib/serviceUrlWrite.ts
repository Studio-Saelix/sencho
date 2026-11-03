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

const REFUSAL_MESSAGE: Record<Extract<ReturnType<typeof renameRetiredServiceUrlLabel>, { ok: false }>['reason'], string> = {
  'missing-service': 'That service is defined in another compose file.',
  unsupported: 'The label cannot be renamed here without changing other parts of this compose file. Rename it in the editor instead.',
  parse: 'The compose file could not be read or updated as YAML. Fix any YAML error in the editor, then try again.',
};

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
  if (!patched.ok) return { ok: false, message: REFUSAL_MESSAGE[patched.reason] };
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

function isRefused<T extends { ok: boolean }>(result: T): result is Extract<T, { ok: false }> {
  return !result.ok;
}

export type RetiredRenameRun<T extends { ok: boolean }> =
  | { status: 'busy' }
  | { status: 'save-threw' }
  | { status: 'save-refused'; result: Extract<T, { ok: false }> }
  | { status: 'saved'; verified: boolean; current: boolean };

/**
 * Save a planned rename and prove it took effect. One rename at a time: a second
 * call while a save is in flight would reuse the first call's etag and report a
 * conflict it caused itself. After a successful save the node's answer is read
 * again when the refresh was superseded (it returns null), and a rename the node
 * still reports is never called done.
 */
export async function runRetiredRename<T extends { ok: boolean }>(deps: {
  inFlight: { current: boolean };
  nextContent: string;
  service: string;
  save: () => Promise<T>;
  applyContent: (content: string) => void;
  /** Whether the stack and node the rename was started on are still open. */
  isCurrent: () => boolean;
  refresh: () => Promise<ServiceUrlEntry | null>;
  refetch: () => Promise<ServiceUrlEntry>;
}): Promise<RetiredRenameRun<T>> {
  if (deps.inFlight.current) return { status: 'busy' };
  deps.inFlight.current = true;
  try {
    let result: T;
    try {
      result = await commitServiceUrlWrite(deps.nextContent, deps.save, deps.applyContent);
    } catch (error) {
      console.error('Failed to rename the service URL label:', error);
      return { status: 'save-threw' };
    }
    if (isRefused(result)) return { status: 'save-refused', result };
    if (!deps.isCurrent()) return { status: 'saved', verified: false, current: false };
    let verified = false;
    try {
      verified = retiredRenameVerified((await deps.refresh()) ?? await deps.refetch(), deps.service);
    } catch (error) {
      console.error('Failed to verify the renamed service URL label:', error);
    }
    return { status: 'saved', verified, current: deps.isCurrent() };
  } finally {
    deps.inFlight.current = false;
  }
}
