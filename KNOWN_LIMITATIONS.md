# Known limitations

> [!NOTE]
> Sencho is currently in public beta on the path to v1.0. Core workflows are actively tested, but early users should review the known limitations and avoid deploying it blindly on critical infrastructure without testing in their own environment first.

Below are the limitations we know about today. If you hit something that is not here, please file a bug.

## Scale

- Single-instance use: not benchmarked yet beyond typical homelab loads. Expect comfortable operation on tens of stacks and a few hundred containers per node; very large nodes may show UI slowdowns.
- Fleet: not benchmarked yet. Comfortably tested with small fleets (a handful of nodes); larger fleets work but are less exercised.
- Container log streaming: not benchmarked yet at sustained high log rates; very chatty containers may lag the UI.

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
