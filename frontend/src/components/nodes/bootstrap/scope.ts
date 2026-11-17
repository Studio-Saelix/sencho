/**
 * What a bootstrap run is, stated wherever the user decides or reads the
 * result. A run executes the approved plan (checking each step's result) and
 * enrolls the Pilot. The run does not decide that the node is ready: once the
 * Pilot connects, the hub asks it for a fresh readiness report and marks the
 * node ready only when no check fails or goes unanswered (warnings do not
 * block). docs/features/node-bootstrap.mdx states the same facts.
 */
export const BOOTSTRAP_SCOPE =
  'Bootstrap runs the plan and enrolls the Pilot. The node is ready for deployments only after the hub checks it through the Pilot once it connects: identity, Docker, Compose and the Compose directory.';

export const BOOTSTRAP_READINESS_NOTE =
  'Items marked readiness are checked by the hub through the Pilot once it connects, before the node is called ready.';

