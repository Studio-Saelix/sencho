# Known limitations

> [!NOTE]
> Sencho is used in production for day-to-day Docker Compose and fleet management. As a pre-1.0 project it still evolves quickly, so review the limitations below and validate against your own setup before deploying it on critical infrastructure.

Below are the limitations we know about today. If you hit something that is not here, please file a bug.

## Scale

Sencho's core workflows are validated through QA, repeated security and code audits, and end-to-end journey testing, so day-to-day correctness is well exercised. What is not yet characterized is performance at large scale: the figures below are ranges we have run comfortably, not hard ceilings.

- Single instance: comfortable at typical homelab and small-team loads (tens of stacks and a few hundred containers per node). Very large nodes are not yet benchmarked and may show UI slowdowns.
- Fleet: validated on small fleets (a handful of nodes). Larger fleets work but are less exercised, and fleet-wide operations are not yet benchmarked at scale.
- Container log streaming: handles normal log volumes smoothly. Sustained high log rates are not yet benchmarked, and very chatty containers may lag the UI.

## Platform support

- Operating systems: Linux (primary), macOS (development), Windows with WSL2 (development). Production deployments should be on Linux.
- Docker: requires Docker Engine 20.10 or later and Docker Compose v2.
- Browsers: latest two stable versions of Chrome, Firefox, Safari, Edge.

## Architecture

- Sencho runs as root inside its container by default. Non-root operation is supported via `SENCHO_USER=sencho` but may require adjusting bind-mount ownership.
- Mounting `/var/run/docker.sock` grants Sencho root-equivalent privilege on the host. This is the same model as Portainer, Dockge, Komodo, and similar tools.
- Plain HTTP works on trusted networks but is not safe to expose to the public internet. Always front Sencho with a TLS-terminating reverse proxy in production.
- Multi-node fleets require either the remote node reaching the primary or the primary reaching the remote, depending on Pilot Agent vs direct proxy mode. Both directions blocked at once is not supported.
- There is no downgrade path between minor versions; back up `/app/data` before upgrading.
- Trivy vulnerability scanning requires outbound HTTPS to the Trivy database mirror unless configured for air-gapped operation.

## Features

- Mesh networking depends on a shared Docker network alias scheme; it does not currently support overlay networks or Swarm.
- Auto-update applies one image at a time per node; concurrent updates of the same stack are serialized.
- Pilot Agent tunnels have a hard limit of 256 concurrent connections per primary.
- Some features are tier-gated; see [pricing](https://sencho.io/pricing).

## What we will fix vs document

Items in this file are either (a) on the roadmap, (b) architectural constraints that will not change in 1.x, or (c) documented for awareness because the right fix is a workaround. Each item should say which.
