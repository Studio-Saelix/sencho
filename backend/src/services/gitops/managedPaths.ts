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
export const MANAGED_ROOT_NAME = 'git-managed';
export const GENERATIONS_DIR = 'generations';
