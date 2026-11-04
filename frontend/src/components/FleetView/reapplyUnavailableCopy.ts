import type { ReapplyUnavailableReason } from './types';

/**
 * One sentence per reason a node cannot recreate its own Compose
 * configuration, shared by the self-stack dialog and the Node updates sheet so
 * the fact is written once. Each sentence names the consequence and, where the
 * operator can act, the remedy.
 */
const SENTENCES: Record<ReapplyUnavailableReason, (node: string) => string> = {
  not_in_container: (node) =>
    `${node} is not running in a container, so there is no Compose service for it to recreate. Reapply is available only when Sencho runs as a container managed by Docker Compose.`,
  container_unidentified: (node) =>
    `${node} could not identify its own container when it started, so it cannot recreate itself. It keeps retrying on its own; if this persists, check that Sencho can inspect its own container through its Docker endpoint.`,
  docker_unreachable: (node) =>
    `${node} could not reach its Docker endpoint when it started, so it cannot recreate itself. It keeps retrying on its own; if this persists, check the Docker connection on that node.`,
  not_compose_managed: (node) =>
    `${node} is not managed by Docker Compose, so it cannot recreate itself from a Compose file. Deploy Sencho from a Docker Compose project so its container carries the Compose labels.`,
  compose_cli_unavailable: (node) =>
    `${node} does not have the Docker Compose CLI available, so it cannot recreate itself. It keeps retrying on its own; if this persists, check that the image includes Docker Compose.`,
  image_unknown: (node) =>
    `${node} could not determine the image it is running, so it cannot safely recreate itself. Check that its Compose service declares an image.`,
  detecting: (node) =>
    `${node} is still working out how to manage its own container. It retries on its own; try again in a moment.`,
  node_unreachable: (node) =>
    `${node} could not be reached, so Sencho cannot tell whether it can recreate itself. Check that the node is online, then try again.`,
  node_outdated: (node) =>
    `${node} runs an older Sencho release that does not report whether it can recreate itself. Update it first.`,
};

const UNKNOWN_REASON =
  'Sencho could not confirm that this node can recreate its own Compose configuration.';

/** Sentence for a reason plus the node it describes; a null reason stays generic. */
export function reapplyUnavailableSentence(
  reason: ReapplyUnavailableReason | null | undefined,
  nodeName: string | null | undefined,
): string {
  if (!reason) return UNKNOWN_REASON;
  const node = nodeName?.trim() || 'This node';
  return SENTENCES[reason](node);
}
