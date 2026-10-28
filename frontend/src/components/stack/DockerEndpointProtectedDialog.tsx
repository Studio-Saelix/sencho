import { RefreshCw } from 'lucide-react';
import { ConfirmModal } from '@/components/ui/modal';
import { useEndpointProviderOption } from '@/components/FleetView/hooks/useEndpointProviderOption';
import type { DockerEndpointRefusalReason } from '@/lib/stackUpdate';

interface DockerEndpointProtectedDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The guard's own refusal text, shown as-is. */
  message: string;
  reason: DockerEndpointRefusalReason | null;
  /** The service the guard protected, when the node named it. */
  service: string | null;
  /** The node the refused operation targeted. */
  nodeId: number | null;
  nodeName: string | null;
  /** Admin who can reapply this node's Compose configuration. */
  canRecreate: boolean;
  /** True when the editor has moved to another node or stack since the refusal. */
  contextMoved?: boolean;
  /** Opens the safe replacement preview for the same node and provider. */
  onRecreate?: () => void;
}

/**
 * The handoff from an operation the Docker endpoint guard refused.
 * A refused Deploy or Update is never quietly retried as a privileged
 * replacement: this names the provider the guard protected and offers the one
 * authorized path that may recreate it, leaving Sencho running.
 */
export function DockerEndpointProtectedDialog({
  open,
  onOpenChange,
  message,
  reason,
  service,
  nodeId,
  nodeName,
  canRecreate,
  contextMoved = false,
  onRecreate,
}: DockerEndpointProtectedDialogProps) {
  const option = useEndpointProviderOption(nodeId, open);
  const nodeLabel = nodeName?.trim() || 'this node';
  const provider = option?.state === 'available' ? option.service : null;
  const bare = (name: string | null | undefined) => name?.replace(/^\//, '') ?? null;
  // A labeled container in another stack is also reason `provider`, but only the
  // endpoint provider itself can be replaced by this action. The guard may name
  // the provider by its Compose service or by its container name.
  const protectedProvider = option?.state === 'available'
    && (service === null
      || service === option.service
      || bare(service) === bare(option.containerName));
  const providerOnly = option?.state === 'available' && option.providerOnly === true;
  const eligible = reason === 'provider' && canRecreate && provider !== null && protectedProvider && providerOnly && !!onRecreate;

  let note: string;
  if (eligible) {
    const project = option?.state === 'available' && option.project ? ` in Compose project ${option.project}` : '';
    note = `Recreating ${provider}${project} on ${nodeLabel} replaces only that container. Sencho keeps running and reconnects through the new one, and the rest of the stack is left alone. If the new container does not give Sencho Docker access, the previous one is restored.`;
  } else if (reason === 'sencho') {
    note = 'This operation would stop the Sencho container itself. Recreating the Docker endpoint is not the remedy; use Save & Reapply or Fleet node updates to recreate Sencho safely.';
  } else if (reason === 'invalid_label') {
    note = 'Sencho cannot tell which stack owns a container that carries its Docker connection, so there is no safe replacement to offer. Fix the Compose labels on the host, then try again.';
  } else if (reason === 'unresolved') {
    note = `Sencho could not identify the container carrying its Docker connection on ${nodeLabel}, so there is no safe replacement to offer. Check the node connection in Fleet, then try again.`;
  } else if (contextMoved) {
    note = `The editor has moved to another stack or node since this was refused. Open ${nodeLabel} and select that stack to recreate its Docker endpoint.`;
  } else if (option?.state === 'unavailable') {
    note = `The Docker endpoint on ${nodeLabel} cannot be recreated from here: ${option.reason}`;
  } else if (option?.state === 'unsupported') {
    note = `${nodeLabel} runs a Sencho version that cannot recreate its Docker endpoint. Update the node first.`;
  } else if (option?.state === 'available' && !providerOnly) {
    note = `${nodeLabel} runs a Sencho version that can only recreate its Docker endpoint together with Sencho. Update the node first to replace the endpoint on its own.`;
  } else if (option?.state === 'none') {
    note = `${nodeLabel} reaches Docker without a container, so there is no Docker endpoint to recreate.`;
  } else if (!canRecreate) {
    // Keep this before the unknown-option branch: a non-admin cannot read the
    // endpoint option at all, so null there says nothing about the provider.
    note = `An admin who can reapply ${nodeLabel}'s Compose configuration can recreate the Docker endpoint safely.`;
  } else if (option === null) {
    note = `Sencho could not confirm ${nodeLabel}'s Docker endpoint, so it cannot say whether this operation protected it. Refresh and try again.`;
  } else if (option.state === 'available' && !protectedProvider) {
    note = `The guard protected ${service ?? 'a container'} in this stack, and recreating the Docker endpoint would not change it. Recreate that service from the host (docker compose up -d) while Sencho is idle.`;
  } else {
    note = `No safe replacement is available for ${nodeLabel}.`;
  }

  return (
    <ConfirmModal
      open={open}
      onOpenChange={onOpenChange}
      kicker="DOCKER ENDPOINT"
      title="Docker endpoint protected"
      cancelLabel={eligible ? 'Cancel' : 'Close'}
      confirmLabel={eligible ? (
        <>
          <RefreshCw className="w-4 h-4 mr-1.5" strokeWidth={1.5} />
          Recreate endpoint
        </>
      ) : 'Got it'}
      hint={eligible ? 'KEEPS Sencho running' : undefined}
      onConfirm={() => {
        onOpenChange(false);
        if (eligible) onRecreate?.();
      }}
    >
      <p className="text-sm text-stat-subtitle">{message}</p>
      <p className="text-sm text-stat-subtitle pt-2">{note}</p>
    </ConfirmModal>
  );
}
