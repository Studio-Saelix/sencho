<div align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="frontend/public/sencho-logo-dark.png">
    <img src="frontend/public/sencho-logo-light.png" alt="Sencho" width="220">
  </picture>

  ### Self-hosted Docker Compose management for one machine or a fleet.

  <p>
    <a href="https://docs.sencho.io">Docs</a> ·
    <a href="https://sencho.io">Website</a> ·
    <a href="https://github.com/studio-saelix/sencho/discussions">Discussions</a> ·
    <a href="https://buymeacoffee.com/sencho">Sponsor</a>
  </p>

  [![Latest release](https://img.shields.io/github/v/release/studio-saelix/sencho?label=release)](https://github.com/studio-saelix/sencho/releases)
  [![Docker Pulls](https://img.shields.io/docker/pulls/saelix/sencho)](https://hub.docker.com/r/saelix/sencho)
  [![CI](https://github.com/studio-saelix/sencho/actions/workflows/ci.yml/badge.svg)](https://github.com/studio-saelix/sencho/actions/workflows/ci.yml)
  [![License](https://img.shields.io/badge/license-BSL--1.1-blue)](LICENSE)
  [![Discussions](https://img.shields.io/github/discussions/studio-saelix/sencho)](https://github.com/studio-saelix/sencho/discussions)
</div>

<br />

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/dashboard-dark.png">
  <img src="docs/images/dashboard-light.png" alt="Sencho dashboard">
</picture>

---

## What Sencho is

Sencho is for homelab operators, small DevOps teams, and platform engineers who run services on Docker Compose, want a graphical interface without giving up file-on-disk workflows, and need to manage more than one machine without SSH gymnastics or a VPN.

It runs as a single container on your hardware and gives you a UI for the work you currently do over SSH on compose stacks: deploying, editing files, watching logs, restarting containers, browsing volumes, and recovering from failures. Your compose files stay on the host filesystem and remain the source of truth.

A Sencho instance is autonomous. To manage another machine, you install a second Sencho on it and connect them with a long-lived API token; the primary dashboard then acts as a transparent HTTPS proxy across your fleet. There is no SSH and no exposed Docker socket. For nodes behind NAT or strict firewalls, the Pilot Agent establishes a single outbound WebSocket tunnel to the primary, so the remote host opens no inbound port at all.

Most capabilities are free in the Community tier. A few advanced automation and fleet-control features ship in paid tiers; pricing lives at [sencho.io/pricing](https://sencho.io/pricing).

---

## Capabilities

### Stacks
- Full Compose lifecycle: create, deploy, restart, stop, pull
- Monaco editor with diff preview before save and one-click rollback
- [Git-sourced stacks](https://docs.sencho.io/features/git-sources) pulled and synced from any repository
- File explorer for compose, env, and supporting files
- [Stack labels](https://docs.sencho.io/features/stack-labels) for grouping and bulk operations
- [App Store](https://docs.sencho.io/features/app-store) with LinuxServer.io templates

### Observability
- Aggregated [log search and stream](https://docs.sencho.io/features/global-observability) across every container in the fleet
- Live container stats, health checks, and image-update notifications
- Threshold alerts for CPU, memory, and network
- Read-only [audit log](https://docs.sencho.io/features/audit-log) of every action
- [Network topology](https://docs.sencho.io/features/fleet-view) view of containers, networks, and nodes

### Fleet
- Multi-node management via authenticated HTTP and WebSocket proxy
- [Fleet view](https://docs.sencho.io/features/fleet-view) with grid and topology layouts
- [Fleet snapshots](https://docs.sencho.io/features/fleet-backups) of compose and env across the fleet
- [Pilot Agent](https://docs.sencho.io/features/pilot-agent) for nodes behind NAT or strict firewalls
- Node compatibility checks before deploying

### Automation
- [Auto-heal policies](https://docs.sencho.io/features/auto-heal-policies) for failed containers
- [Auto-update policies](https://docs.sencho.io/features/auto-update-policies) for image rollouts
- [Scheduled operations](https://docs.sencho.io/features/scheduled-operations) on cron
- [Blueprints](https://docs.sencho.io/features/blueprint-model): declarative fleet templates with drift detection
- [Webhooks](https://docs.sencho.io/features/webhooks) on stack lifecycle events
- Encrypted [Fleet Secrets](https://docs.sencho.io/features/fleet-secrets) pushed to labeled nodes

### Security
- [SSO](https://docs.sencho.io/features/sso): custom OIDC, presets for Google, GitHub, and Okta, plus LDAP and Active Directory
- [Two-factor authentication](https://docs.sencho.io/features/two-factor-authentication) with TOTP and backup codes
- [RBAC](https://docs.sencho.io/features/rbac) with admin, editor, and viewer roles
- [Vulnerability scanning](https://docs.sencho.io/features/vulnerability-scanning) via Trivy with VEX-based suppression and SARIF export
- [Private registries](https://docs.sencho.io/features/private-registries) and [deploy enforcement](https://docs.sencho.io/features/deploy-enforcement) for non-compliant images
- [API tokens](https://docs.sencho.io/features/api-tokens) for automation

### Operations
- [Host console](https://docs.sencho.io/features/host-console) in the browser
- [Sencho Cloud Backup](https://docs.sencho.io/operations/backup) for off-site stack archives
- [Notification routing](https://docs.sencho.io/features/notification-routing) to Slack, Discord, email, and webhooks
- [Global search](https://docs.sencho.io/features/global-search) across stacks, containers, and services
- [Resources view](https://docs.sencho.io/features/resources) for images, volumes, and networks with scoped prune actions

---

## Quick start

Sencho runs in a single container.

```yaml
services:
  sencho:
    image: saelix/sencho:latest
    container_name: sencho
    restart: unless-stopped
    ports:
      - "1852:1852"
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - ./data:/app/data
      # 1:1 Compose Path Rule: the host path MUST match the container path
      - /opt/docker:/opt/docker
    environment:
      - COMPOSE_DIR=/opt/docker
      - DATA_DIR=/app/data
```

```bash
docker compose up -d
```

Open `http://your-server:1852` and create your admin account.

Always front Sencho with a TLS-terminating reverse proxy in production. See the [self-hosting guide](https://docs.sencho.io/operations/self-hosting) for hardening, environment variables, and reverse-proxy examples.

<details>
<summary>Run with <code>docker run</code> instead</summary>

```bash
docker run -d --name sencho \
  -p 1852:1852 \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v sencho_data:/app/data \
  -e COMPOSE_DIR=/opt/docker \
  saelix/sencho:latest
```

</details>

For the full walkthrough, see the [quickstart guide](https://docs.sencho.io/getting-started/quickstart).

---

## Adding remote nodes

To manage a second machine, install Sencho on it the same way, then add it from the primary dashboard with its URL and a long-lived API token. The primary proxies authenticated HTTPS and WebSocket requests to the remote instance. No SSH, no exposed Docker socket, no agent process on the remote. Nodes behind NAT or strict firewalls can opt into the Pilot Agent for outbound-only connectivity.

See the [multi-node guide](https://docs.sencho.io/features/multi-node) for the full token-bearer flow.

---

## Screenshots

| | |
|---|---|
| ![Stacks](docs/images/stacks.png) | ![Editor](docs/images/editor.png) |
| ![Fleet](docs/images/fleet.png) | ![Logs](docs/images/logs.png) |

---

## Documentation, community, and license

- **Documentation:** [docs.sencho.io](https://docs.sencho.io)
- **Community:** [GitHub Discussions](https://github.com/studio-saelix/sencho/discussions)
- **Contributing:** [CONTRIBUTING.md](CONTRIBUTING.md)
- **Security:** [SECURITY.md](SECURITY.md). Do not open public issues for security vulnerabilities.
- **License:** [Business Source License 1.1](LICENSE). Free for production use; the only restriction is offering Sencho as a competing hosted or managed service. Converts to [Apache 2.0](https://www.apache.org/licenses/LICENSE-2.0) on **2030-03-25**.

---

<div align="center">

[![Contributors](https://contrib.rocks/image?repo=studio-saelix/sencho)](https://github.com/studio-saelix/sencho/graphs/contributors)

</div>
