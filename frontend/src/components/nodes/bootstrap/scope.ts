/**
 * What a bootstrap run is, stated wherever the user decides or reads the
 * result. A run executes the approved plan (checking each step's result) and
 * enrolls the Pilot; it does not check the node from inside the Pilot, so it
 * does not show the node is ready for deployments. docs/features/node-bootstrap.mdx
 * states the same fact.
 */
export const BOOTSTRAP_SCOPE =
  'Bootstrap is execution and enrollment only: it runs the plan and enrolls the Pilot. It is not a complete, verified provisioning, and it does not check that the node is ready for deployments.';

export const BOOTSTRAP_SCOPE_AFTER_RUN =
  'The run only executed the plan and enrolled the Pilot. It did not verify that the node is ready for deployments.';

export const BOOTSTRAP_READINESS_NOTE =
  'Items marked readiness are not checked by the run, except that the Pilot connects.';
