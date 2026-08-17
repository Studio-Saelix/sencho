/**
 * Managed-area path vocabulary, defined here rather than imported from
 * GitProjectManifestService.
 *
 * The manifest service reaches these modules through GitSourceService, so
 * importing its constants back into the gitops layer forms a cycle. Under that
 * cycle the binding can still be uninitialized when these modules evaluate,
 * which silently yields paths like `undefined/candidate-<sha>`: they pass a
 * containment check against the managed root and name a directory that does
 * not exist, so cleanup removes nothing and leaves the real one behind.
 *
 * These values must stay in step with the manifest service's layout.
 */
import path from 'path';

export const MANAGED_ROOT_NAME = 'git-managed';
export const GENERATIONS_DIR = 'generations';

/**
 * The directory every stack's managed area lives under.
 *
 * Exists so each filesystem call on a managed path can resolve its target and
 * check containment in its own scope. CodeQL does not credit the wrapped
 * `isPathWithinBase` helper as a barrier, so `js/path-injection` reports the
 * call even when the path was already validated; the check has to be inline at
 * the call to be recognised. The duplication is deliberate.
 *
 * The base is node-agnostic on purpose, since callers here are given a root
 * rather than a node id. It proves a path is inside the managed area, not that
 * it is inside one node's subtree of it; keeping a stack out of another node's
 * area still rests on stack-name validation at the route.
 */
export function managedAreaBase(): string {
  const dataDir = process.env.DATA_DIR || path.join(process.cwd(), 'data');
  return path.resolve(dataDir, MANAGED_ROOT_NAME);
}
