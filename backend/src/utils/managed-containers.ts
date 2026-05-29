import path from 'path';

/** Minimal container shape needed to decide managed-vs-external. */
export interface LabeledContainer {
  Labels?: Record<string, string>;
}

/**
 * "Managed" means Docker started the container from within COMPOSE_DIR.
 *
 * We key on `com.docker.compose.project.working_dir` rather than the project
 * name so stacks launched from the COMPOSE_DIR root (not a subdirectory)
 * aren't mis-classified as external. Containers without the label (plain
 * `docker run`, or another tool's compose project outside COMPOSE_DIR) are
 * treated as unmanaged.
 *
 * @param container any object carrying Docker labels
 * @param composeDir an already `path.resolve`d COMPOSE_DIR for the node
 */
export function isManagedByComposeDir(container: LabeledContainer, composeDir: string): boolean {
  const workingDir = container.Labels?.['com.docker.compose.project.working_dir'];
  if (!workingDir) return false;
  const resolved = path.resolve(workingDir);
  return resolved === composeDir || resolved.startsWith(composeDir + path.sep);
}
