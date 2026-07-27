/**
 * Collect per-service effective healthcheck evidence for Compose Doctor.
 * Structural facts only: never returns or logs Healthcheck.Test command text.
 */
import DockerController from '../DockerController';
import { filterContainersByComposeService } from '../../helpers/composeServiceMatch';
import { isDockerHealthcheckActive } from '../../helpers/healthcheckPresence';
import type { EffectiveModel } from '../preflight/effectiveModel';
import type { ServiceHealthcheckEvidence } from '../preflight/types';
import { mapWithConcurrency } from '../../utils/mapWithConcurrency';
import { getErrorMessage } from '../../utils/errors';
import { sanitizeForLog } from '../../utils/safeLog';

const INSPECT_CONCURRENCY = 8;

type ListedContainer = {
  Id: string;
  Names?: string[];
  Labels?: Record<string, string>;
  Image?: string;
};

type ReplicaProbe = {
  hasHealthcheck: boolean;
  imageMatches: boolean;
  inspectFailed: boolean;
};

type ImageEvidence = 'inherited' | 'absent' | 'unverifiable';

function evidence(
  state: ServiceHealthcheckEvidence['state'],
  origin: ServiceHealthcheckEvidence['origin'],
  consistentReplicas: boolean | null,
): ServiceHealthcheckEvidence {
  return { state, origin, consistentReplicas };
}

/**
 * Resolve effective healthcheck coverage for each service in the model.
 * When `nodeStateAvailable` is false, services that still need Docker evidence
 * become unverifiable without listing or inspecting containers/images.
 */
export async function collectServiceHealthcheckEvidence(
  nodeId: number,
  stackName: string,
  model: EffectiveModel,
  nodeStateAvailable: boolean,
): Promise<Record<string, ServiceHealthcheckEvidence>> {
  const out: Record<string, ServiceHealthcheckEvidence> = {};

  const needsDocker = model.services.some(s =>
    s.composeHealthcheck !== 'active' && s.composeHealthcheck !== 'disabled');

  let listed: ListedContainer[] = [];
  let listFailed = false;
  // Compose's top-level `name:` becomes com.docker.compose.project; that often
  // differs from the Sencho stack directory name used as stackName.
  const projectLabel = model.projectName || stackName;
  if (nodeStateAvailable && needsDocker) {
    try {
      const docker = DockerController.getInstance(nodeId).getDocker();
      listed = await docker.listContainers({
        all: true,
        filters: { label: [`com.docker.compose.project=${projectLabel}`] },
      }) as ListedContainer[];
    } catch (err) {
      listFailed = true;
      console.warn(
        '[ComposeDoctor] Healthcheck container list failed for %s:',
        sanitizeForLog(projectLabel),
        sanitizeForLog(getErrorMessage(err, 'unknown')),
      );
    }
  }

  for (const svc of model.services) {
    if (svc.composeHealthcheck === 'active') {
      out[svc.name] = evidence('compose-declared', 'compose', null);
      continue;
    }
    if (svc.composeHealthcheck === 'disabled') {
      out[svc.name] = evidence('explicitly-disabled', 'compose', null);
      continue;
    }

    if (!nodeStateAvailable) {
      out[svc.name] = evidence('unverifiable', 'none', null);
      continue;
    }

    if (listFailed) {
      // Container list failed, but a local image inspect may still succeed.
      out[svc.name] = await evidenceFromLocalImage(nodeId, svc.image, null);
      continue;
    }

    const scoped = filterContainersByComposeService(listed, svc.name);
    if (scoped.length > 0) {
      const replicas = await mapWithConcurrency(scoped, INSPECT_CONCURRENCY, (c) =>
        probeReplica(nodeId, c, svc.image));
      const fromRuntime = await resolveRuntimeEvidence(replicas);
      if (fromRuntime) {
        out[svc.name] = fromRuntime;
        continue;
      }
    }

    // No suitable runtime evidence: local image or unverifiable.
    out[svc.name] = await evidenceFromLocalImage(nodeId, svc.image, null);
  }

  return out;
}

/**
 * Decide from inspected, image-matched replicas.
 * Returns null when the caller should fall through to a generic local-image lookup
 * (all inspects failed, or every replica is a stale/mismatched image).
 */
function resolveRuntimeEvidence(
  replicas: ReplicaProbe[],
): ServiceHealthcheckEvidence | null {
  const inspected = replicas.filter(r => !r.inspectFailed);
  if (inspected.length === 0) return null;

  const usable = inspected.filter(r => r.imageMatches);
  if (usable.length === 0) return null;

  const withHc = usable.filter(r => r.hasHealthcheck).length;
  const withoutHc = usable.length - withHc;
  const partial = inspected.length < replicas.length;

  if (withHc > 0 && withoutHc > 0) {
    return evidence('inconsistent-replicas', 'runtime', false);
  }

  if (withHc === usable.length) {
    // Incomplete inspection: do not claim full coverage.
    if (partial) return evidence('unverifiable', 'runtime', null);
    return evidence('runtime-inherited', 'runtime', true);
  }

  // All usable replicas lack an effective healthcheck. Do not upgrade a verified
  // runtime gap to local-image-inherited; live replicas are authoritative.
  if (partial) return evidence('unverifiable', 'runtime', null);
  return evidence('absent', 'runtime', true);
}

async function evidenceFromLocalImage(
  nodeId: number,
  image: string | undefined,
  consistentReplicas: boolean | null,
): Promise<ServiceHealthcheckEvidence> {
  if (!image) return evidence('unverifiable', 'none', consistentReplicas);

  const imageKind = await inspectLocalImage(nodeId, image);
  if (imageKind === 'inherited') {
    return evidence('local-image-inherited', 'local-image', consistentReplicas);
  }
  if (imageKind === 'absent') {
    return evidence('absent', 'local-image', consistentReplicas);
  }
  return evidence('unverifiable', 'none', consistentReplicas);
}

async function probeReplica(
  nodeId: number,
  listed: ListedContainer,
  declaredImage: string | undefined,
): Promise<ReplicaProbe> {
  try {
    const docker = DockerController.getInstance(nodeId).getDocker();
    const inspect = await docker.getContainer(listed.Id).inspect();
    const test = inspect.Config?.Healthcheck?.Test;
    const hasHealthcheck = isDockerHealthcheckActive(test);
    const runtimeImage = typeof inspect.Config?.Image === 'string' ? inspect.Config.Image : listed.Image;
    const imageMatches = !declaredImage
      || !runtimeImage
      || runtimeImage === declaredImage;
    return { hasHealthcheck, imageMatches, inspectFailed: false };
  } catch (err) {
    if ((err as { statusCode?: number })?.statusCode === 404) {
      return { hasHealthcheck: false, imageMatches: false, inspectFailed: true };
    }
    console.warn(
      '[ComposeDoctor] Healthcheck container inspect failed:',
      sanitizeForLog(getErrorMessage(err, 'unknown')),
    );
    return { hasHealthcheck: false, imageMatches: false, inspectFailed: true };
  }
}

async function inspectLocalImage(
  nodeId: number,
  imageRef: string,
): Promise<ImageEvidence> {
  try {
    const { inspect } = await DockerController.getInstance(nodeId).inspectImage(imageRef);
    const test = (inspect as { Config?: { Healthcheck?: { Test?: unknown } } })?.Config?.Healthcheck?.Test;
    return isDockerHealthcheckActive(test) ? 'inherited' : 'absent';
  } catch (err) {
    console.warn(
      '[ComposeDoctor] Healthcheck image inspect failed for %s:',
      sanitizeForLog(imageRef),
      sanitizeForLog(getErrorMessage(err, 'unknown')),
    );
    return 'unverifiable';
  }
}
