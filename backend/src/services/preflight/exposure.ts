/**
 * Per-stack/per-service Compose exposure descriptor. Reuses the existing
 * effective-model parser and the normalize helpers; does not reimplement
 * port/bind detection.
 *
 * Exposure represents CONFIGURED reachability as declared in the Compose
 * model, refreshed on deploy/update. It is NOT live topology: down/stop
 * do not clear the cache, just as vulnerability scan data persists after
 * containers stop. The descriptor reflects what the compose file declares,
 * not what is currently running.
 *
 * The signal is tri-state per image: true (publicly exposed), false
 * (internal only in every cached stack containing the image), or absent
 * (no cached descriptor). It is an escalation input for the Security
 * posture, never an auto-suppression.
 */
import type { EffectiveModel } from './effectiveModel';
import { isLoopback, isHostNetwork } from '../network/normalize';

export interface ServiceExposure {
  service: string;
  /** Join key to vulnerability_scans.image_ref. Absent for build-only services. */
  image: string | null;
  publiclyExposed: boolean;
  reason: 'published-port' | 'host-network' | null;
  /** Host-side binding strings, e.g. "0.0.0.0:8080/tcp". */
  bindings: string[];
}

export interface StackExposure {
  stack: string;
  services: ServiceExposure[];
  computedAt: number;
}

/** Build a port-range label: "8080" for a single port, "8080-8090" for a range. */
function portLabel(startPort: number, endPort: number): string {
  return startPort === endPort ? `${startPort}` : `${startPort}-${endPort}`;
}

/**
 * Derive a per-stack exposure descriptor from the rendered effective model.
 * Pure function with no side effects; callers own caching and persistence.
 */
export function deriveStackExposure(
  model: EffectiveModel,
  stackName: string,
  now: number,
): StackExposure {
  const services: ServiceExposure[] = model.services.map((svc) => {
    // Publicly exposed when any published port binds to a non-loopback address,
    // or when network_mode is host (every container port is published on the host).
    const nonLoopbackPorts = svc.ports.filter((p) => !isLoopback(p.hostIp));
    const hostNetwork = isHostNetwork(svc.networkMode);

    const publiclyExposed = nonLoopbackPorts.length > 0 || hostNetwork;

    const bindings = nonLoopbackPorts.map(
      (p) => `${p.hostIp || '0.0.0.0'}:${portLabel(p.startPort, p.endPort)}/${p.protocol}`,
    );

    return {
      service: svc.name,
      image: svc.image ?? null,
      publiclyExposed,
      reason: hostNetwork
        ? 'host-network'
        : nonLoopbackPorts.length > 0
          ? 'published-port'
          : null,
      bindings,
    };
  });

  return { stack: stackName, services, computedAt: now };
}

/**
 * Build a per-node image->exposed tri-state map from all cached stack
 * descriptors. The map answers:
 *   true  = at least one service using this image is publicly exposed
 *   false = every cached descriptor containing this image marks it internal-only
 *   absent = no cached descriptor contains this image (null)
 *
 * When multiple stacks contain the same image, one public exposure wins over
 * any number of internal-only classifications (conservative escalation).
 */
export function buildExposedImageMap(
  exposures: StackExposure[],
): Map<string, boolean> {
  const map = new Map<string, boolean>();
  for (const exp of exposures) {
    for (const svc of exp.services) {
      if (!svc.image) continue; // build-only services have no join key
      const current = map.get(svc.image);
      // true wins: once an image is known to be publicly exposed anywhere,
      // it stays true regardless of other stacks classifying it internal.
      if (current === true) continue;
      map.set(svc.image, svc.publiclyExposed);
    }
  }
  return map;
}
