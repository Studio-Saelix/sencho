/**
 * Header a Sencho node adds when it refuses a mesh proxy-tunnel upgrade.
 * Its presence proves the refusal came from Sencho itself, not from a
 * reverse proxy or access gateway in front of it. Values:
 *   - `unauthorized`: the credential was missing or rejected.
 *   - `scope`: the API token is not full-admin.
 *   - `tier`: the license tier does not include mesh.
 *   - `forbidden`: any other refusal.
 */
export const MESH_REJECT_HEADER = 'X-Sencho-Mesh-Reject';
