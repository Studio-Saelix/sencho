# Operational permission inventory

This inventory is the authority for ordinary operational API authorization. A
route marked `exact` must include the target resource identity in the permission
check. Bulk routes must authorize every valid target before starting any work.

| Route family | Read | Execute | Edit | Create | Delete | Scope |
| --- | --- | --- | --- | --- | --- | --- |
| `/api/stacks/:stackName` and named subroutes | `stack:read` | `stack:deploy` | `stack:edit` | n/a | `stack:delete` | exact stack and request node |
| `/api/stacks/bulk` | n/a | `stack:deploy` | n/a | n/a | n/a | every exact stack before execution |
| `/api/containers`, logs, and `/api/ports/in-use` | `stack:read` | n/a | n/a | n/a | n/a | global read |
| `/api/containers/:containerId/start|stop|restart` | n/a | Admin | n/a | n/a | n/a | arbitrary container IDs can include unmanaged or Sencho containers |
| `/api/volumes/browse/*` | `stack:read` | n/a | n/a | n/a | n/a | global read |
| `/api/templates` | `stack:read` | n/a | n/a | n/a | n/a | global read |
| `/api/templates/:id/deploy` | n/a | `stack:deploy` | n/a | `stack:create` | n/a | global create and deploy |
| `/api/blueprints` | `node:read` | n/a | `stack:edit` | `stack:create` | `stack:delete` | global blueprint definition |
| Blueprint apply | n/a | `stack:deploy` | n/a | `stack:create` | n/a | global create and deploy |
| Blueprint accept or withdraw | n/a | exact `stack:deploy` | n/a | n/a | exact `stack:delete` | blueprint stack name and target node |
| Blueprint pin | n/a | n/a | exact `node:manage` | n/a | n/a | target node; unpin uses global node manage |
| `/api/nodes`, labels, metadata, and scheduling reads | `node:read` | n/a | n/a | n/a | n/a | exact node when a node ID is present |
| Node metadata, labels, cordon, and mesh enablement | n/a | n/a | exact `node:manage` | n/a | n/a | target node |
| Dependency map and networking reads | `node:read` | n/a | n/a | n/a | n/a | global or exact node as exposed by the route |
| Fleet label suggestions and match preview | `node:read` | n/a | n/a | n/a | n/a | global fleet discovery |
| Fleet stop by confirmed labels | n/a | exact `stack:deploy` | n/a | n/a | n/a | every target stack and node before fanout |
| Fleet bulk label assignment | n/a | n/a | exact `stack:edit` | n/a | n/a | every target stack and node before fanout |
| `/api/labels/:id/action` | n/a | exact `stack:deploy` | n/a | n/a | n/a | every resolved stack before mutation |
| Mesh status, aliases, diagnostics, and activity | `node:read` | n/a | n/a | n/a | n/a | global read |
| Mesh stack and override reads | exact `stack:read` | n/a | n/a | n/a | n/a | target stack and node |
| Mesh local override writes | n/a | n/a | exact `stack:edit` | n/a | n/a | target stack and node |
| Mesh membership changes | n/a | Admin | n/a | n/a | n/a | membership changes cascade redeploys across mesh stacks |
| Security scans for an image or stack | n/a | `stack:deploy` | n/a | n/a | n/a | exact stack when named, otherwise global |
| Node-wide security scan | n/a | `node:manage` | n/a | n/a | n/a | global, including remote proxy parity |
| SBOM, SARIF, VEX, and predeploy security reports | `stack:read` | n/a | n/a | n/a | n/a | exact stack when named, otherwise global |
| Security policies, suppressions, and acknowledgements | `stack:read` | n/a | `stack:edit` | n/a | n/a | global collection |
| Docker resource inventory and orphan reads | `stack:read` | n/a | n/a | n/a | n/a | global read |
| Network topology and inspection | `node:read` | n/a | n/a | n/a | n/a | global read |

## Preserved system boundaries

Literal Admin or the existing `system:*` permission remains required for user,
license, credential, API token, recovery, self-update, and sensitive system
settings. Host-destructive Docker operations also remain Admin-only, including
image, volume, network, resource, and fleet pruning. Reset-anchor and mesh-wide
membership cascades remain Admin-only because their effects are broader than one
ordinary node or stack permission check can safely authorize.

## Frontend parity

Navigation and controls use `can()` with the same action and resource identity.
Exact stack checks pass the stack name and node ID. Exact node checks pass the
node ID. System-only controls continue to use the Admin or `system:*` gate. UI
visibility is advisory; every backend route in this inventory enforces its gate.
