/**
 * What a bootstrap run is, stated wherever the user decides or reads the result.
 * A run executes the approved plan and enrolls the Pilot; it never checks that
 * the finished server can host deployments. The same words appear in
 * docs/features/node-bootstrap.mdx.
 */
export const BOOTSTRAP_SCOPE =
  'A run executes the plan and enrolls the Pilot, nothing more. It does not verify that the server is ready for deployments.';

export const BOOTSTRAP_SCOPE_AFTER_RUN =
  'The run only executed the plan and enrolled the Pilot. It did not verify that the node is ready for deployments.';
