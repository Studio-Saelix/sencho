import type { PreflightContext, PreflightFinding, PreflightSeverity, NodePortBinding } from './types';
import type { EffService, EffPortSpec } from './effectiveModel';
import type { ExposureIntent } from '../network/types';
import { isLoopback } from '../network/normalize';

/** Higher number = more severe. Used to derive a run's overall status. */
export const SEVERITY_RANK: Record<PreflightSeverity, number> = { info: 0, warning: 1, high: 2, blocker: 3 };

/** The one rule whose message doubles as the report's render error. Shared so the
 *  service that reconstructs renderError from it cannot drift from the rule id. */
export const RENDER_FAILED_RULE_ID = 'render-failed';

export interface PreflightRule {
  id: string;
  run(ctx: PreflightContext): PreflightFinding[];
}

// ----- shared helpers -------------------------------------------------------

const MAX_RANGE = 256; // cap range expansion so an adversarial 1-65535 spec can't blow up

function isAllInterfaces(ip: string): boolean {
  return ip === '' || ip === '0.0.0.0' || ip === '::' || ip === '[::]';
}

function interfaceOverlap(a: string, b: string): boolean {
  return isAllInterfaces(a) || isAllInterfaces(b) || a === b;
}

function portsOf(spec: EffPortSpec): number[] {
  const end = Math.min(spec.endPort, spec.startPort + MAX_RANGE - 1);
  const out: number[] = [];
  for (let p = spec.startPort; p <= end; p++) out.push(p);
  return out;
}

function specLabel(spec: EffPortSpec): string {
  return spec.startPort === spec.endPort ? `${spec.startPort}` : `${spec.startPort}-${spec.endPort}`;
}

/** True when the image reference resolves to a moving `latest` tag. */
function usesLatestTag(image: string): boolean {
  if (image.includes('@sha256:')) return false; // digest-pinned
  const lastSlash = image.lastIndexOf('/');
  const lastColon = image.lastIndexOf(':');
  if (lastColon > lastSlash) return image.slice(lastColon + 1) === 'latest';
  return true; // no tag → implicit latest
}

const UID_GID_KEYS = new Set(['PUID', 'PGID', 'UID', 'GID']);
function hasUidGidSignal(svc: EffService): boolean {
  return svc.user !== undefined || svc.envKeys.some(k => UID_GID_KEYS.has(k));
}

/** Resolved runtime name of a top-level network/volume (compose prefixes the project). */
function runtimeResourceName(projectName: string, key: string, declaredName: string): string {
  return declaredName !== key ? declaredName : `${projectName}_${key}`;
}

// ----- rules ----------------------------------------------------------------

const renderFailed: PreflightRule = {
  id: RENDER_FAILED_RULE_ID,
  run(ctx) {
    if (ctx.renderable) return [];
    return [{
      ruleId: RENDER_FAILED_RULE_ID,
      severity: 'blocker',
      title: 'Compose model could not be rendered',
      message: ctx.renderError ?? 'docker compose config failed to produce an effective model.',
      remediation: 'Fix the reported error. Sencho cannot validate a stack it cannot render.',
    }];
  },
};

const envUnset: PreflightRule = {
  id: 'env-unset',
  run(ctx) {
    return ctx.unsetEnvVars.map(name => ({
      ruleId: 'env-unset',
      severity: 'high' as const,
      title: `Unset variable ${name}`,
      message: `"${name}" is referenced by the Compose model but is not set in the environment or any consulted env file. Compose substitutes an empty string, which often breaks the container silently.`,
      sourcePath: name,
      remediation: `Define ${name} in a .env or env_file, or give it a default with \${${name}:-value}.`,
    }));
  },
};

const portConflictNode: PreflightRule = {
  id: 'port-conflict-node',
  run(ctx) {
    if (!ctx.model) return [];
    const byPort = new Map<number, NodePortBinding[]>();
    for (const b of ctx.nodePorts) {
      const list = byPort.get(b.publishedPort);
      if (list) list.push(b); else byPort.set(b.publishedPort, [b]);
    }
    const findings: PreflightFinding[] = [];
    for (const svc of ctx.model.services) {
      for (const spec of svc.ports) {
        for (const port of portsOf(spec)) {
          const clash = (byPort.get(port) ?? []).find(b =>
            b.protocol === spec.protocol && interfaceOverlap(spec.hostIp, b.ip) && b.stack !== ctx.stackName);
          if (!clash) continue;
          const owner = clash.stack ? `stack "${clash.stack}"` : 'another container';
          findings.push({
            ruleId: 'port-conflict-node',
            severity: 'blocker',
            title: `Host port ${port} is already in use`,
            message: `Service "${svc.name}" publishes ${port}/${spec.protocol}, but ${owner} already binds that port on this node. The deploy will fail.`,
            sourcePath: svc.name,
            service: svc.name,
            remediation: 'Stop the conflicting workload or publish a different host port.',
          });
          break; // one finding per service+spec is enough
        }
      }
    }
    return findings;
  },
};

const portConflictInternal: PreflightRule = {
  id: 'port-conflict-internal',
  run(ctx) {
    if (!ctx.model) return [];
    const claims = new Map<string, { service: string; hostIp: string }[]>();
    for (const svc of ctx.model.services) {
      for (const spec of svc.ports) {
        for (const port of portsOf(spec)) {
          const key = `${port}/${spec.protocol}`;
          const list = claims.get(key);
          if (list) list.push({ service: svc.name, hostIp: spec.hostIp });
          else claims.set(key, [{ service: svc.name, hostIp: spec.hostIp }]);
        }
      }
    }
    const findings: PreflightFinding[] = [];
    for (const [key, list] of claims) {
      const services = [...new Set(list.map(c => c.service))];
      if (services.length < 2) continue;
      const overlapping = list.some((a, i) => list.slice(i + 1).some(b => b.service !== a.service && interfaceOverlap(a.hostIp, b.hostIp)));
      if (!overlapping) continue;
      findings.push({
        ruleId: 'port-conflict-internal',
        severity: 'blocker',
        title: `Two services publish ${key}`,
        message: `Services ${services.map(s => `"${s}"`).join(' and ')} both publish host port ${key}. Only one can bind it, so the deploy will fail.`,
        remediation: 'Give each service a distinct host port.',
      });
    }
    return findings;
  },
};

const portExposedAllInterfaces: PreflightRule = {
  id: 'port-exposed-all-interfaces',
  run(ctx) {
    if (!ctx.model) return [];
    const findings: PreflightFinding[] = [];
    for (const svc of ctx.model.services) {
      for (const spec of svc.ports) {
        if (!isAllInterfaces(spec.hostIp)) continue;
        findings.push({
          ruleId: 'port-exposed-all-interfaces',
          severity: 'high',
          title: `Port ${specLabel(spec)} exposed on all interfaces`,
          message: `Service "${svc.name}" publishes ${specLabel(spec)}/${spec.protocol} on all interfaces (0.0.0.0), so it is reachable from every network the host is attached to.`,
          sourcePath: svc.name,
          service: svc.name,
          remediation: `Bind to a specific interface, e.g. 127.0.0.1:${spec.startPort}, if this should not be public.`,
        });
      }
    }
    return findings;
  },
};

const bindPathMissing: PreflightRule = {
  id: 'bind-path-missing',
  run(ctx) {
    return ctx.bindChecks
      .filter(b => b.withinBase && !b.exists)
      .map(b => ({
        ruleId: 'bind-path-missing',
        severity: 'high' as const,
        title: 'Bind mount path is missing',
        message: `The host path "${b.source}" for service "${b.service}" does not exist. Docker will create it as a root-owned directory on deploy, which often leaves the container unable to write to it.`,
        sourcePath: b.source,
        service: b.service,
        remediation: 'Create the directory with the ownership the container expects before deploying.',
      }));
  },
};

const bindPathPermission: PreflightRule = {
  id: 'bind-path-permission',
  run(ctx) {
    if (!ctx.model || ctx.platform === 'win32') return [];
    const svcByName = new Map(ctx.model.services.map(s => [s.name, s]));
    const findings: PreflightFinding[] = [];
    for (const b of ctx.bindChecks) {
      if (!b.withinBase || !b.exists || b.ownerUid !== 0) continue;
      const svc = svcByName.get(b.service);
      if (!svc || !hasUidGidSignal(svc)) continue;
      findings.push({
        ruleId: 'bind-path-permission',
        severity: 'warning',
        title: 'Bind mount may have wrong ownership',
        message: `The host path "${b.source}" is owned by root, but service "${b.service}" runs as a non-root user. It may not be able to write there.`,
        sourcePath: b.source,
        service: b.service,
        remediation: 'chown the path to the UID/GID the container runs as.',
      });
    }
    return findings;
  },
};

const dockerSocketMount: PreflightRule = {
  id: 'docker-socket-mount',
  run(ctx) {
    if (!ctx.model) return [];
    const findings: PreflightFinding[] = [];
    for (const svc of ctx.model.services) {
      const hit = svc.binds.some(b => b.source.includes('docker.sock') || b.target.includes('docker.sock'));
      if (!hit) continue;
      findings.push({
        ruleId: 'docker-socket-mount',
        severity: 'high',
        title: 'Docker socket mounted',
        message: `Service "${svc.name}" mounts the Docker socket, which grants it root-equivalent control over the host.`,
        sourcePath: svc.name,
        service: svc.name,
        remediation: 'Avoid mounting docker.sock unless required; consider a scoped socket proxy.',
      });
    }
    return findings;
  },
};

const privileged: PreflightRule = {
  id: 'privileged',
  run(ctx) {
    if (!ctx.model) return [];
    return ctx.model.services.filter(s => s.privileged).map(s => ({
      ruleId: 'privileged',
      severity: 'high' as const,
      title: 'Privileged container',
      message: `Service "${s.name}" runs with privileged: true, which disables most container isolation.`,
      sourcePath: s.name,
      service: s.name,
      remediation: 'Drop privileged and grant only the specific capabilities the service needs.',
    }));
  },
};

const networkModeHost: PreflightRule = {
  id: 'network-mode-host',
  run(ctx) {
    if (!ctx.model) return [];
    return ctx.model.services.filter(s => s.networkMode === 'host').map(s => ({
      ruleId: 'network-mode-host',
      severity: 'high' as const,
      title: 'Host network mode',
      message: `Service "${s.name}" uses network_mode: host. Its ports bypass Docker's network isolation and ignore published-port mappings.`,
      sourcePath: s.name,
      service: s.name,
      remediation: 'Use bridge networking with explicit published ports unless host mode is required.',
    }));
  },
};

const uidGidRisk: PreflightRule = {
  id: 'uid-gid-risk',
  run(ctx) {
    if (!ctx.model) return [];
    // Only for binds whose ownership Sencho cannot verify (outside the compose
    // base); within-base root-owned binds are covered by bind-path-permission.
    const unverifiableByService = new Set(ctx.bindChecks.filter(b => !b.withinBase).map(b => b.service));
    return ctx.model.services
      .filter(s => hasUidGidSignal(s) && unverifiableByService.has(s.name))
      .map(s => ({
        ruleId: 'uid-gid-risk',
        severity: 'warning' as const,
        title: 'Check UID/GID alignment',
        message: `Service "${s.name}" sets a user/UID and mounts host paths Sencho cannot inspect. Mismatched ownership between the host path and the container user is a common cause of permission errors.`,
        sourcePath: s.name,
        service: s.name,
        remediation: 'Ensure the bind-mount paths are owned by the UID/GID the container runs as.',
      }));
  },
};

const imageLatest: PreflightRule = {
  id: 'image-latest',
  run(ctx) {
    if (!ctx.model) return [];
    return ctx.model.services
      .filter(s => s.image !== undefined && usesLatestTag(s.image))
      .map(s => ({
        ruleId: 'image-latest',
        severity: 'warning' as const,
        title: 'Image uses a moving tag',
        message: `Service "${s.name}" uses "${s.image}", which resolves to a moving latest tag. Deploys are not reproducible and can change under you.`,
        sourcePath: s.name,
        service: s.name,
        remediation: 'Pin a specific version tag.',
      }));
  },
};

const noRestartPolicy: PreflightRule = {
  id: 'no-restart-policy',
  run(ctx) {
    if (!ctx.model) return [];
    // `restart: "no"` is Compose's default and means "do not restart", which
    // `docker compose config` may render explicitly, so treat it as no policy.
    return ctx.model.services
      .filter(s => (!s.restart || s.restart === 'no') && !(s.deploy && s.deploy['restart_policy'] !== undefined))
      .map(s => ({
        ruleId: 'no-restart-policy',
        severity: 'warning' as const,
        title: 'No restart policy',
        message: `Service "${s.name}" has no restart policy, so it will not come back after a crash or host reboot.`,
        sourcePath: s.name,
        service: s.name,
        remediation: 'Add restart: unless-stopped.',
      }));
  },
};

const noHealthcheck: PreflightRule = {
  id: 'no-healthcheck',
  run(ctx) {
    if (!ctx.model) return [];
    return ctx.model.services
      .filter(s => !s.hasHealthcheck)
      .map(s => ({
        ruleId: 'no-healthcheck',
        severity: 'warning' as const,
        title: 'No healthcheck',
        message: `Service "${s.name}" declares no healthcheck, so Docker and Sencho cannot tell when it is actually ready (the image may still define one).`,
        sourcePath: s.name,
        service: s.name,
        remediation: 'Add a healthcheck, or confirm the image provides one.',
      }));
  },
};

const SWARM_ONLY_DEPLOY_KEYS = ['placement', 'update_config', 'rollback_config', 'endpoint_mode'];
const deploySwarmOnly: PreflightRule = {
  id: 'deploy-swarm-only',
  run(ctx) {
    if (!ctx.model) return [];
    const findings: PreflightFinding[] = [];
    for (const s of ctx.model.services) {
      if (!s.deploy) continue;
      const present = SWARM_ONLY_DEPLOY_KEYS.filter(k => s.deploy?.[k] !== undefined);
      if (present.length === 0) continue;
      findings.push({
        ruleId: 'deploy-swarm-only',
        severity: 'warning',
        title: 'Swarm-only deploy fields',
        message: `Service "${s.name}" sets deploy.${present.join(', deploy.')}, which standalone Compose ignores (these apply to Swarm).`,
        sourcePath: s.name,
        service: s.name,
        remediation: 'Remove the Swarm-only deploy fields or move equivalent settings to their standalone keys.',
      });
    }
    return findings;
  },
};

const externalNetworkMissing: PreflightRule = {
  id: 'external-network-missing',
  run(ctx) {
    if (!ctx.model) return [];
    const findings: PreflightFinding[] = [];
    for (const [key, net] of Object.entries(ctx.model.networks)) {
      if (!net.external || ctx.existingNetworkNames.has(net.name)) continue;
      findings.push({
        ruleId: 'external-network-missing',
        severity: 'blocker',
        title: 'External network not found',
        message: `The model requires the external network "${net.name}", which does not exist on this node. The deploy will fail.`,
        sourcePath: `networks.${key}`,
        remediation: `Create it with: docker network create ${net.name}`,
      });
    }
    return findings;
  },
};

const externalVolumeMissing: PreflightRule = {
  id: 'external-volume-missing',
  run(ctx) {
    if (!ctx.model) return [];
    const findings: PreflightFinding[] = [];
    for (const [key, vol] of Object.entries(ctx.model.volumes)) {
      if (!vol.external || ctx.existingVolumeNames.has(vol.name)) continue;
      findings.push({
        ruleId: 'external-volume-missing',
        severity: 'blocker',
        title: 'External volume not found',
        message: `The model requires the external volume "${vol.name}", which does not exist on this node. The deploy will fail.`,
        sourcePath: `volumes.${key}`,
        remediation: `Create it with: docker volume create ${vol.name}`,
      });
    }
    return findings;
  },
};

const newNetwork: PreflightRule = {
  id: 'new-network',
  run(ctx) {
    if (!ctx.model) return [];
    const findings: PreflightFinding[] = [];
    for (const [key, net] of Object.entries(ctx.model.networks)) {
      if (net.external || key === 'default') continue;
      const expected = runtimeResourceName(ctx.model.projectName, key, net.name);
      if (ctx.existingNetworkNames.has(expected)) continue;
      findings.push({
        ruleId: 'new-network',
        severity: 'info',
        title: 'New network will be created',
        message: `Deploying will create the network "${expected}".`,
        sourcePath: `networks.${key}`,
      });
    }
    return findings;
  },
};

const newVolume: PreflightRule = {
  id: 'new-volume',
  run(ctx) {
    if (!ctx.model) return [];
    const findings: PreflightFinding[] = [];
    for (const [key, vol] of Object.entries(ctx.model.volumes)) {
      if (vol.external) continue;
      const expected = runtimeResourceName(ctx.model.projectName, key, vol.name);
      if (ctx.existingVolumeNames.has(expected)) continue;
      findings.push({
        ruleId: 'new-volume',
        severity: 'info',
        title: 'New volume will be created',
        message: `Deploying will create the named volume "${expected}".`,
        sourcePath: `volumes.${key}`,
      });
    }
    return findings;
  },
};

const containerNameInternalDup: PreflightRule = {
  id: 'container-name-internal-dup',
  run(ctx) {
    if (!ctx.model) return [];
    const byName = new Map<string, string[]>();
    for (const s of ctx.model.services) {
      if (!s.containerName) continue;
      const list = byName.get(s.containerName);
      if (list) list.push(s.name); else byName.set(s.containerName, [s.name]);
    }
    const findings: PreflightFinding[] = [];
    for (const [name, services] of byName) {
      if (services.length < 2) continue;
      findings.push({
        ruleId: 'container-name-internal-dup',
        severity: 'blocker',
        title: 'Duplicate container_name',
        message: `Services ${services.map(s => `"${s}"`).join(' and ')} both set container_name "${name}". Docker requires unique names, so the deploy will fail.`,
        remediation: 'Give each service a unique container_name, or remove it and let Compose name them.',
      });
    }
    return findings;
  },
};

const containerNameCollision: PreflightRule = {
  id: 'container-name-collision',
  run(ctx) {
    if (!ctx.model) return [];
    const findings: PreflightFinding[] = [];
    for (const s of ctx.model.services) {
      if (!s.containerName) continue;
      const clash = ctx.existingContainers.find(c => c.name === s.containerName && c.stack !== ctx.stackName);
      if (!clash) continue;
      const owner = clash.stack ? `stack "${clash.stack}"` : 'an unmanaged container';
      findings.push({
        ruleId: 'container-name-collision',
        severity: 'blocker',
        title: 'container_name already in use',
        message: `container_name "${s.containerName}" for service "${s.name}" is already used by ${owner} on this node. The deploy will fail with a name conflict.`,
        sourcePath: s.name,
        service: s.name,
        remediation: 'Choose a different container_name or remove the conflicting container.',
      });
    }
    return findings;
  },
};

const effectiveModelExpanded: PreflightRule = {
  id: 'effective-model-expanded',
  run(ctx) {
    // Skip when the source could not be read: an empty source-service set then
    // means "unknown", not "zero services", and would flag every service.
    if (!ctx.model || !ctx.sourceReadable) return [];
    const source = new Set(ctx.sourceServiceNames);
    const extra = ctx.model.services.map(s => s.name).filter(n => !source.has(n));
    if (extra.length === 0) return [];
    return [{
      ruleId: 'effective-model-expanded',
      severity: 'info',
      title: 'Effective model adds services',
      message: `The effective model includes ${extra.map(s => `"${s}"`).join(', ')}, which are not in this file (pulled in via include, extends, or profiles). What deploys differs from what you see here.`,
      remediation: 'Review the included files to confirm this is intended.',
    }];
  },
};

// ----- exposure-intent rules ------------------------------------------------
// These read the user's stored exposure classification (resolved per service)
// and the dossier's documented access URLs from the context, plus a sensitivity
// heuristic on the image name for the broad-exposure rule.

/** Image-name hints for a database or admin service that should rarely be broadly exposed. */
const SENSITIVE_IMAGE_HINTS = [
  'postgres', 'mysql', 'mariadb', 'mongo', 'redis', 'memcached', 'elasticsearch',
  'adminer', 'phpmyadmin', 'portainer', 'docker-socket-proxy',
];
/** Reverse-proxy label-key base names; matched as the key itself or a `base.` prefix (case-insensitive). */
const REVERSE_PROXY_LABEL_HINTS = ['traefik', 'caddy', 'virtual.host'];

/** A service's effective intent: its own override, else the stack-level intent. */
function effectiveIntent(ctx: PreflightContext, service: string): ExposureIntent | null {
  return ctx.serviceIntents[service] ?? ctx.stackIntent;
}

const exposureInternalPublished: PreflightRule = {
  id: 'exposure-internal-published',
  run(ctx) {
    if (!ctx.model) return [];
    const findings: PreflightFinding[] = [];
    for (const svc of ctx.model.services) {
      const intent = effectiveIntent(ctx, svc.name);
      if (intent !== 'internal' && intent !== 'same-node') continue;
      // same-node tolerates a loopback binding; internal tolerates no host port.
      const offending = svc.ports.filter(p => intent === 'internal' || !isLoopback(p.hostIp));
      if (offending.length === 0) continue;
      findings.push({
        ruleId: 'exposure-internal-published',
        severity: 'high',
        title: `"${svc.name}" is classified ${intent} but publishes a host port`,
        message: `Service "${svc.name}" is classified as ${intent} exposure, but it publishes ${offending.map(specLabel).join(', ')} to the host, which contradicts that intent.`,
        sourcePath: svc.name,
        service: svc.name,
        remediation: intent === 'same-node'
          ? 'Bind the port to loopback (127.0.0.1), remove it, or reclassify the exposure intent.'
          : 'Remove the published port or reclassify the exposure intent.',
      });
    }
    return findings;
  },
};

const exposureUnclassified: PreflightRule = {
  id: 'exposure-unclassified',
  run(ctx) {
    if (!ctx.model) return [];
    const publishing = ctx.model.services.filter(s => s.ports.length > 0);
    if (publishing.length === 0) return [];
    // Fire only when a publishing service is still effectively unclassified: a
    // service-level intent suppresses the warning for that service even when the
    // stack itself is unset.
    const unclassified = publishing.some(s => {
      const intent = effectiveIntent(ctx, s.name);
      return intent === null || intent === 'unknown';
    });
    if (!unclassified) return [];
    return [{
      ruleId: 'exposure-unclassified',
      severity: 'warning',
      title: 'Stack publishes ports without an exposure intent',
      message: 'This stack publishes one or more host ports but has no exposure intent set. Classifying it (internal, LAN, reverse proxy, public) lets Sencho flag mismatches later.',
      remediation: 'Set the stack exposure intent in the Networking tab.',
    }];
  },
};

const exposurePortVsDossier: PreflightRule = {
  id: 'exposure-port-vs-dossier',
  run(ctx) {
    if (!ctx.model || !ctx.hasAccessUrls) return [];
    const findings: PreflightFinding[] = [];
    for (const svc of ctx.model.services) {
      const undocumented = [...new Set(svc.ports.flatMap(portsOf).filter(p => !ctx.accessUrlPorts.has(p)))];
      if (undocumented.length === 0) continue;
      findings.push({
        ruleId: 'exposure-port-vs-dossier',
        severity: 'warning',
        title: 'Published port is not in the documented access URLs',
        message: `Service "${svc.name}" publishes ${undocumented.join(', ')}, which ${undocumented.length > 1 ? 'are' : 'is'} not referenced by the dossier's documented access URLs. The documentation may be stale.`,
        sourcePath: svc.name,
        service: svc.name,
        remediation: 'Update the access URLs in the Stack Dossier, or change the published port.',
      });
    }
    return findings;
  },
};

const reverseProxyUndocumented: PreflightRule = {
  id: 'reverse-proxy-undocumented',
  run(ctx) {
    if (!ctx.model) return [];
    // Already documented or intentionally reverse-proxied at the stack level.
    if (ctx.hasAccessUrls || ctx.stackIntent === 'reverse-proxy') return [];
    const findings: PreflightFinding[] = [];
    for (const svc of ctx.model.services) {
      if (effectiveIntent(ctx, svc.name) === 'reverse-proxy') continue;
      const hasRpLabel = svc.labelKeys.some(k => {
        const lk = k.toLowerCase();
        return REVERSE_PROXY_LABEL_HINTS.some(h => lk === h || lk.startsWith(`${h}.`));
      });
      if (!hasRpLabel) continue;
      findings.push({
        ruleId: 'reverse-proxy-undocumented',
        severity: 'warning',
        title: `"${svc.name}" has reverse-proxy labels but no documented URL`,
        message: `Service "${svc.name}" carries reverse-proxy labels, but the stack has no documented access URL or reverse-proxy intent, so how it is reached is unclear.`,
        sourcePath: svc.name,
        service: svc.name,
        remediation: 'Document the access URL in the Stack Dossier or set the exposure intent to reverse proxy.',
      });
    }
    return findings;
  },
};

const sensitiveServiceBroadExposure: PreflightRule = {
  id: 'sensitive-service-broad-exposure',
  run(ctx) {
    if (!ctx.model) return [];
    const findings: PreflightFinding[] = [];
    for (const svc of ctx.model.services) {
      if (svc.image === undefined) continue;
      const image = svc.image.toLowerCase();
      if (!SENSITIVE_IMAGE_HINTS.some(h => image.includes(h))) continue;
      const broad = svc.ports.filter(p => isAllInterfaces(p.hostIp));
      if (broad.length === 0) continue;
      findings.push({
        ruleId: 'sensitive-service-broad-exposure',
        severity: 'high',
        title: `Sensitive service "${svc.name}" is exposed on all interfaces`,
        message: `Service "${svc.name}" looks like a database or admin service (${svc.image}) and publishes ${broad.map(specLabel).join(', ')} on all interfaces. Broadly exposing it is a common source of compromise.`,
        sourcePath: svc.name,
        service: svc.name,
        remediation: 'Bind it to a specific interface such as 127.0.0.1, or keep it on an internal network only.',
      });
    }
    return findings;
  },
};

/** The ordered registry. Order is the display order within a severity group. */
export const PREFLIGHT_RULES: PreflightRule[] = [
  renderFailed,
  envUnset,
  portConflictNode,
  portConflictInternal,
  portExposedAllInterfaces,
  bindPathMissing,
  bindPathPermission,
  dockerSocketMount,
  privileged,
  networkModeHost,
  uidGidRisk,
  imageLatest,
  noRestartPolicy,
  noHealthcheck,
  deploySwarmOnly,
  externalNetworkMissing,
  externalVolumeMissing,
  newNetwork,
  newVolume,
  containerNameInternalDup,
  containerNameCollision,
  exposureInternalPublished,
  sensitiveServiceBroadExposure,
  exposureUnclassified,
  exposurePortVsDossier,
  reverseProxyUndocumented,
  effectiveModelExpanded,
];

export const RULE_IDS: readonly string[] = PREFLIGHT_RULES.map(r => r.id);

/** Run every rule and concatenate findings. */
export function runRules(ctx: PreflightContext): PreflightFinding[] {
  return PREFLIGHT_RULES.flatMap(rule => rule.run(ctx));
}
