import type { EffectiveModel, EffResource } from '../services/preflight/effectiveModel';
import type { DeclaredCompose, DeclaredPort, DeclaredResource, DeclaredService } from './composeDependencyParse';
import { normalizeComposeRestartIntent } from '../utils/oneShotCompletion';

/** Map one rendered network/volume entry to the declared shape drift expects. */
function toDeclaredResource(key: string, res: EffResource, projectName: string): DeclaredResource {
  const defaultName = res.external ? key : `${projectName}_${key}`;
  if (res.name === defaultName) {
    return { external: res.external };
  }
  return { external: res.external, name: res.name };
}

function toDeclaredResourceRecord(
  resources: Record<string, EffResource>,
  projectName: string,
): Record<string, DeclaredResource> {
  return Object.fromEntries(
    Object.entries(resources).map(([key, res]) => [key, toDeclaredResource(key, res, projectName)]),
  );
}

/**
 * Convert a fully-rendered effective model (`docker compose config`) into the
 * {@link DeclaredCompose} shape consumed by the spatial drift engine. Variable
 * substitution, defaults, multi-file merge, and profile filtering are already
 * applied upstream.
 */
export function declaredFromEffectiveModel(model: EffectiveModel): DeclaredCompose {
  const { projectName } = model;
  const services: DeclaredService[] = model.services.map((s) => ({
    name: s.name,
    dependsOn: [],
    networks: s.networks.map((n) => n.key),
    volumes: [],
    ports: s.ports.map(
      (p): DeclaredPort => ({
        hostIp: p.hostIp,
        publishedPort: p.startPort,
        protocol: p.protocol,
      }),
    ),
    image: s.image,
    networkMode: s.networkMode,
    restart: normalizeComposeRestartIntent(s.restart, s.deploy),
  }));

  return {
    services,
    networks: toDeclaredResourceRecord(model.networks, projectName),
    volumes: toDeclaredResourceRecord(model.volumes, projectName),
    projectName,
  };
}
