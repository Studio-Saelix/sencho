import { SENCHO_OPEN_STACK_EVENT, type SenchoOpenStackDetail } from './events';
import type { DockerEndpointRefusal } from './stackUpdate';

/**
 * Opens the editor and carries a Docker endpoint refusal to the one preview
 * that can act on it. Shared callers outside the editor (Fleet readiness,
 * deploy feedback, the stack update hook) cannot render the dialog themselves,
 * so the refusal travels with the node and stack it was raised for.
 *
 * Returns false when the caller has no node to bind the handoff to; the
 * refusal is then only a message, never a retargetable action.
 */
export function openEndpointRefusalInEditor(
  nodeId: number | null,
  stackName: string,
  refusal: DockerEndpointRefusal,
): boolean {
  if (nodeId === null) return false;
  window.dispatchEvent(new CustomEvent<SenchoOpenStackDetail>(SENCHO_OPEN_STACK_EVENT, {
    detail: { nodeId, stackName, destination: 'editor', endpointRefusal: refusal },
  }));
  return true;
}
