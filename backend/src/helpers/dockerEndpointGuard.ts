import { parse as parseYaml } from 'yaml';
import DockerController from '../services/DockerController';
import SelfIdentityService from '../services/SelfIdentityService';
import { NodeRegistry } from '../services/NodeRegistry';
import {
  resolveDockerEndpointProvider,
  type DockerEndpointContainer,
  type DockerEndpointProvider,
} from '../services/DockerEndpointProvider';
import { getRuntimeContainerIdCandidates, matchesContainerId, workingDirMatchesStack } from './selfStackGuard';
import { normalizeComposeVersion } from './composeVersionSkew';
import { getErrorMessage } from '../utils/errors';
import type { DockerEndpointRefusal } from './dockerEndpointError';

/*
 * Guard for lifecycle operations that would stop or recreate the container
 * carrying this node's Docker API: Sencho itself, or the socket proxy Sencho
 * reaches Docker through. Recreating the proxy cuts the connection the
 * operation is using, and the rollback that follows dies the same way, so the
 * operation is refused before it starts and the reason names the safe path.
 *
 * It refuses when the provider or Sencho's own identity cannot be resolved
 * (for the stacks that could hold the provider), when a container list or
 * inspect fails (Docker being unreachable included: a failed read proves
 * nothing about the mutation that follows it), when the Compose model of a
 * stack that is deployed, updated, or changed per service cannot be rendered
 * (a stop, restart, take down, or delete is judged from the deployed
 * containers, running or stopped, and does not need the render), when Compose's
 * recreate decision cannot be predicted (including when the container was
 * created by a different `docker compose` version than the one the deploy would
 * run, or records none, because a different Compose can recreate it even when
 * the configuration hash and image both match), and when a deploy would remove a
 * protected container as an orphan (it is not stopped, carries a project label,
 * and its service label is missing or names a service the rendered file does
 * not contain). That is wider than what Compose 5.1.3 removes: it removes only
 * a container that also carries `com.docker.compose.oneoff=False`, and leaves a
 * hand-made one with just a project label alone. The guard does not read
 * `oneoff`, because another Compose version may remove more and a false refusal
 * costs less than a cut connection. A protected container that has stopped passes a
 * deploy that does not recreate it (removing a stopped orphan is one) and
 * Auto-Heal's restart of the detected provider (`allowProvider`, the way a
 * stopped proxy comes back). Every other operation still refuses it. A stop,
 * restart, take down, delete, or container operation then says the container is
 * not running and names the host-side removal, wherever the state is known (the
 * container list, with every replica of the service stopped, or an inspect that
 * answered). An update (a rollback is one) that finds every container of the
 * service stopped says that too, because it does not stop or recreate anything
 * it names; it refuses because the stack holds the container. A deploy that would
 * recreate it or cannot predict that, a service redeploy, an unidentified
 * provider, and a refusal decided before the state is read (an inspect that
 * failed or was denied, matched by id or name) keep their own advice. It otherwise lets the operation through: when the stack holds no protected container, no owner of a
 * namespace one runs in, and nothing the operation would recreate that they
 * depend on; for a restart of Sencho itself (both evaluators); and for a remote
 * node (its own Sencho guards it).
 *
 * The provider is recognised by its id, by its container name, and by its
 * Compose project and service, so a proxy recreated since it was resolved is
 * still refused, whatever labels the new container carries.
 *
 * A failed container inspect refuses, except for a missing container (HTTP 404,
 * the operation then fails by itself), a restart of Sencho, a restart of the
 * resolved provider that Auto-Heal asked to let through (any inspect error), and
 * an inspect the endpoint denies (HTTP 401 or 403) of a container that is not
 * known to be protected: that container is then judged from the provider's and
 * Sencho's own namespaces and from the containers carrying the infrastructure
 * label, and refused when any of them cannot be read. Only the container
 * evaluator lets a restart of Sencho through a failed inspect; the stack
 * evaluator reads the namespaces of Sencho, the provider, and the labeled
 * containers before it decides, and refuses when any of those reads fails
 * (other than a missing container).
 *
 * Two evaluators share these rules: `evaluateDockerEndpointGuard` for the
 * mutating Compose entry points (`ComposeService`) and
 * `evaluateDockerEndpointContainer` for container stop/restart/removal
 * (`DockerController`). Scheduler, webhook, GitOps, Blueprint, mesh, and bulk
 * update all reach one of the two.
 */

export {
  DOCKER_ENDPOINT_PROTECTED_CODE,
  DockerEndpointProtectedError,
  isDockerEndpointProtectedError,
  type DockerEndpointRefusal,
  type EndpointRefusalReason,
} from './dockerEndpointError';

/** Label that marks a service as carrying this node's Docker connection when detection misses it. */
export const INFRASTRUCTURE_LABEL = 'io.sencho.infrastructure';

export type EndpointMutation =
  /**
   * `compose up -d`: a protected service is refused only when it would be
   * recreated. `pinnedServices` are the services a digest-pin overlay rewrites
   * the image of, which the config hash does not see.
   */
  | { kind: 'up'; pinnedServices?: readonly string[] }
  /** Pull then `up -d`: a fresh image would recreate it, so a protected service is refused. */
  | { kind: 'update' }
  /** Stop, down, delete. */
  | { kind: 'stop' }
  /** Restart: the provider is refused, and so is the owner of a namespace the provider or Sencho runs in; Sencho itself is not (restarting Sencho is the intended way to bounce it). */
  | { kind: 'restart' }
  /**
   * A service-scoped operation: refused when it targets a protected service, and
   * when the stack's Compose model cannot be rendered. `restart` marks a restart
   * of that service; `engineOnly` marks a stop or restart driven through the
   * Engine API, which is judged from the deployed containers and does not need
   * the render (like a stack-level stop, restart, take down, or delete).
   */
  | { kind: 'service'; service: string; restart?: boolean; engineOnly?: boolean };

/** A stop, restart, take down, or delete: the guard decides it from the deployed containers (running or stopped) and does not need the Compose render. */
function isEngineDriven(mutation: EndpointMutation): boolean {
  return mutation.kind === 'stop' || mutation.kind === 'restart' || (mutation.kind === 'service' && mutation.engineOnly === true);
}

export type ListedContainer = {
  Id?: string;
  Names?: string[];
  Labels?: Record<string, string>;
  /** Docker's container state (`running`, `exited`, ...). Some mocks and proxies omit it; a missing state counts as running. */
  State?: string;
  ImageID?: string;
  NetworkSettings?: { Networks?: Record<string, { NetworkID?: string } | null> };
};

/** The local image behind a reference: its id, or unknown when it cannot be inspected. */
export type LocalImageLookup = { state: 'id'; id: string } | { state: 'unknown' };

/** What the Compose layer supplies, so this module never imports `ComposeService`. */
export interface EndpointGuardProbes {
  /** Rendered `docker compose config` YAML for the stack, null when it cannot be rendered. */
  renderConfig(): Promise<string | null>;
  /** The config hash Compose would assign `service` now, null when it cannot be computed. */
  configHash(service: string): Promise<string | null>;
  /** The local image id behind `imageRef`; Compose recreates a service whose image id changed. */
  localImage(imageRef: string): Promise<LocalImageLookup>;
  /**
   * The `docker compose` version that would run the deploy (`docker compose
   * version --short`), null when it cannot be read. A deploy is only predictable
   * for containers created by that same version (see `ownRecreate`).
   */
  composeVersion(): Promise<string | null>;
}

export interface EndpointGuardInput {
  nodeId: number;
  stackName: string;
  mutation: EndpointMutation;
  probes: EndpointGuardProbes;
}

type ProtectedRole = 'sencho' | 'provider' | 'unknown_provider' | 'mislabeled';
/** `via` names the protected service when these containers are only protected because it runs in their namespace. */
type Protected = { containers: ListedContainer[]; role: ProtectedRole; via?: string };

/** What Sencho knows about the provider after resolution. */
type ProviderView =
  | { state: 'resolved'; provider: DockerEndpointContainer }
  | { state: 'unresolved'; reason: string }
  | { state: 'none' };

/**
 * Whether a Docker container state means the container has stopped (exited,
 * created, dead). Every other state (restarting, paused, removing, a missing or
 * unknown one) counts as running. What a stopped container is let through for
 * is each caller's call: a deploy removes a stopped orphan, because that cannot
 * cut a connection, while a stop, restart, or removal still refuses it.
 */
function isStoppedState(state: string | undefined): boolean {
  return state === 'exited' || state === 'created' || state === 'dead';
}

function isStopped(container: ListedContainer): boolean {
  return isStoppedState(container.State);
}

function serviceOf(container: ListedContainer): string | null {
  // An empty label is no label: Compose treats a container with one as an orphan.
  return container.Labels?.['com.docker.compose.service'] || null;
}

type RenderedService = {
  infrastructure: string | undefined;
  image: string | undefined;
  pullPolicy: string | undefined;
  /** Services whose recreate Compose follows with a recreate or restart of this one. */
  linkedServices: string[];
  /** Services whose network, pid, or ipc namespace this one runs in; stopping or recreating one of them takes this one down. */
  namespaceServices: string[];
  /**
   * The container's `config-hash` label never equals `docker compose config --hash`
   * for a service that resolves a `service:` namespace mode or `volumes_from` to
   * a container id, so a mismatch says nothing about whether `up` would recreate it.
   */
  hashUnreliable: boolean;
};

type RenderedServiceDocument = {
  labels?: unknown;
  image?: unknown;
  pull_policy?: unknown;
  depends_on?: unknown;
  network_mode?: unknown;
  pid?: unknown;
  ipc?: unknown;
  volumes_from?: unknown;
  links?: unknown;
};

function serviceNamed(mode: unknown): string | null {
  return typeof mode === 'string' && mode.startsWith('service:') ? mode.slice('service:'.length) || null : null;
}

/**
 * The services `service` is wired to. A namespace mode (`network_mode`, `pid`,
 * `ipc` set to `service:x`), `volumes_from`, `links`, and a `depends_on` entry
 * with `restart: true` all make Compose recreate or restart it when the other
 * service is recreated; a plain `depends_on` does not. `hashUnreliable` is set
 * when the service resolves a `volumes_from` or `service:` namespace reference.
 */
function wiringOf(service: RenderedServiceDocument | undefined): { linked: string[]; namespace: string[]; hashUnreliable: boolean } {
  const namespace = new Set<string>();
  for (const mode of [service?.network_mode, service?.pid, service?.ipc]) {
    const name = serviceNamed(mode);
    if (name) namespace.add(name);
  }
  const linked = new Set<string>(namespace);
  const dependsOn = service?.depends_on;
  if (dependsOn && typeof dependsOn === 'object' && !Array.isArray(dependsOn)) {
    for (const [name, condition] of Object.entries(dependsOn)) {
      if ((condition as { restart?: unknown } | null)?.restart === true) linked.add(name);
    }
  }
  const stringEntries = (list: unknown): string[] =>
    Array.isArray(list) ? list.filter((entry): entry is string => typeof entry === 'string') : [];
  const volumesFrom = stringEntries(service?.volumes_from);
  for (const entry of [...volumesFrom, ...stringEntries(service?.links)]) {
    if (entry.startsWith('container:')) continue;
    const name = entry.split(':')[0];
    if (name) linked.add(name);
  }
  // A volumes_from entry naming a container is resolved to an id as well, so its hash is unreliable too.
  return { linked: [...linked], namespace: [...namespace], hashUnreliable: namespace.size > 0 || volumesFrom.length > 0 };
}

/** The label value and image of every service in rendered Compose YAML. Throws on YAML that does not parse. */
function readRenderedServices(renderedYaml: string): Map<string, RenderedService> {
  const out = new Map<string, RenderedService>();
  const parsed = parseYaml(renderedYaml) as { services?: Record<string, RenderedServiceDocument> } | null;
  const services = parsed?.services;
  if (!services || typeof services !== 'object') return out;
  for (const [name, service] of Object.entries(services)) {
    const labels = service?.labels;
    let infrastructure: string | undefined;
    if (Array.isArray(labels)) {
      const entry = labels.find(item => typeof item === 'string' && item.startsWith(`${INFRASTRUCTURE_LABEL}=`));
      if (typeof entry === 'string') infrastructure = entry.slice(INFRASTRUCTURE_LABEL.length + 1);
    } else if (labels && typeof labels === 'object') {
      const raw = (labels as Record<string, unknown>)[INFRASTRUCTURE_LABEL];
      if (raw !== undefined && raw !== null) infrastructure = String(raw);
    }
    const wiring = wiringOf(service);
    out.set(name, {
      infrastructure,
      image: typeof service?.image === 'string' ? service.image : undefined,
      pullPolicy: typeof service?.pull_policy === 'string' ? service.pull_policy : undefined,
      linkedServices: wiring.linked,
      namespaceServices: wiring.namespace,
      hashUnreliable: wiring.hashUnreliable,
    });
  }
  return out;
}

/**
 * Services whose label value is exactly "true" are marked; any other value is
 * invalid.
 */
export function readInfrastructureLabels(renderedYaml: string): { marked: string[]; invalid: Array<{ service: string; value: string }> } {
  const marked: string[] = [];
  const invalid: Array<{ service: string; value: string }> = [];
  for (const [name, service] of readRenderedServices(renderedYaml)) {
    if (service.infrastructure === undefined) continue;
    if (service.infrastructure === 'true') marked.push(name);
    else invalid.push({ service: name, value: service.infrastructure });
  }
  return { marked, invalid };
}

const REAPPLY_PATH = 'Fleet -> Node Updates';

function invalidLabelRefusal(service: string, value: string): DockerEndpointRefusal {
  return {
    reason: 'invalid_label',
    service,
    message: `Service "${service}" sets ${INFRASTRUCTURE_LABEL} to "${value}". The only accepted value is "true"; fix the label before this stack is changed.`,
  };
}

/** Why a service might carry the connection, worded for the role that put it on the list. */
function carriesClause(role: ProtectedRole): string {
  switch (role) {
    case 'sencho': return 'is the Sencho container';
    case 'unknown_provider': return 'shares a network with Sencho and may carry its Docker connection';
    case 'provider':
    case 'mislabeled': return 'carries the Docker connection Sencho is using';
    default: {
      const unreachable: never = role;
      throw new Error(`Unhandled protected role: ${String(unreachable)}`);
    }
  }
}

function refusalFor(
  role: ProtectedRole,
  service: string,
  provider: DockerEndpointContainer | null,
  selfProject: string | null,
  providerUnresolvedReason: string | null = null,
): DockerEndpointRefusal {
  switch (role) {
    case 'sencho':
      return {
        reason: 'sencho',
        service,
        message: `Service "${service}" is the running Sencho instance, and this operation would stop or recreate it. `
          + `Use Reapply in ${REAPPLY_PATH} to recreate Sencho from its current Compose configuration.`,
      };
    case 'unknown_provider':
      return {
        reason: 'unresolved',
        service,
        message: `Sencho could not determine which container carries its Docker connection (${providerUnresolvedReason ?? 'Docker did not answer'}), `
          + `so it cannot tell whether this operation would stop or recreate service "${service}", which shares a network with Sencho. `
          + 'Check that the Docker endpoint allows container list and inspect requests, then retry.',
      };
    case 'mislabeled':
      return {
        reason: 'invalid_label',
        service,
        message: `Service "${service}" is deployed with ${INFRASTRUCTURE_LABEL} set to a value other than "true", so Sencho treats it as carrying its Docker connection, `
          + 'and this operation would stop or recreate it. Correct the label and recreate the service from the host (docker compose up -d) while Sencho is idle.',
      };
    case 'provider': {
      const shared = provider?.project != null && provider.project === selfProject;
      const how = shared
        ? 'It is in the same Compose project as Sencho: recreate it from the host (docker compose up -d) while Sencho is idle.'
        : 'Recreate it from the host (docker compose up -d) while Sencho is idle.';
      return {
        reason: 'provider',
        service,
        message: `Service "${service}" carries the Docker connection Sencho is using, and this operation would stop or recreate it. `
          + `Sencho would lose its Docker API mid-operation and its rollback could not reach Docker. ${how}`,
      };
    }
    default: {
      const unreachable: never = role;
      throw new Error(`Unhandled protected role: ${String(unreachable)}`);
    }
  }
}

/** A service that owns a namespace the protected service `via` runs in: stopping or recreating it takes `via` down. */
function namespaceOwnerRefusal(role: ProtectedRole, service: string, via: string): DockerEndpointRefusal {
  return {
    reason: role === 'sencho' ? 'sencho' : 'provider',
    service,
    message: `Service "${service}" owns a network, pid, or ipc namespace that service "${via}" runs in, and "${via}" ${carriesClause(role)}. `
      + `This operation would stop or recreate "${service}" and cut that connection. Recreate it from the host (docker compose up -d) while Sencho is idle.`,
  };
}

function unknownRecreateRefusal(
  role: ProtectedRole,
  service: string,
  via?: string,
  cause: 'hash' | 'version' | 'unknown' = 'unknown',
): DockerEndpointRefusal {
  const subject = via ? `owns a namespace that "${via}" runs in, and "${via}" ${carriesClause(role)}` : carriesClause(role);
  const why = cause === 'hash'
    ? '(the service, or a service it is wired to, uses volumes_from or a service: network, pid, or ipc mode, and the configuration hash Docker records for such a service never equals the one Compose renders, so the two cannot be compared). '
    : cause === 'version'
      ? '(the container was created by a different Docker Compose version than the one this deploy would run, it does not record one, or the running version could not be read, and a different Compose can recreate a service whose configuration hash and image still match). '
      : '(Compose did not report its configuration hash, its image could not be inspected, or its pull policy can pull or build a different image). ';
  const remedy = role === 'sencho' && !via
    ? `use Reapply in ${REAPPLY_PATH} to recreate Sencho on purpose.`
    : cause === 'version'
      ? "recreate the service once with the Docker Compose version that runs deploys here (the one Sencho's image ships) while Sencho is idle."
      : 'recreate the service from the host (docker compose up -d) while Sencho is idle.';
  return {
    reason: 'unresolved',
    service,
    message: `Sencho could not tell whether this operation would recreate service "${service}", which ${subject} `
      + why
      + 'It is refused rather than guessed; '
      + remedy,
  };
}

/** The reason a refusal of a protected container in this role carries (the same mapping `refusalFor` uses). */
function reasonOf(role: ProtectedRole): DockerEndpointRefusal['reason'] {
  switch (role) {
    case 'sencho': return 'sencho';
    case 'provider': return 'provider';
    case 'mislabeled': return 'invalid_label';
    case 'unknown_provider': return 'unresolved';
    default: {
      const unreachable: never = role;
      throw new Error(`Unhandled protected role: ${String(unreachable)}`);
    }
  }
}

/**
 * Whether a deploy that removes orphans could remove this container: it carries
 * a project label and no rendered service owns it, because it has no service
 * label or its service is not among the rendered ones (removed from the file, or
 * in a profile that is not enabled). One with no project label is outside the
 * project and left alone. Compose 5.1.3 removes only such a container that also
 * carries `oneoff=False`; the guard does not require it (see the header).
 */
function isRemovableOrphan(container: ListedContainer, rendered: Map<string, RenderedService>): boolean {
  if (!container.Labels?.['com.docker.compose.project']) return false;
  const service = serviceOf(container);
  return service === null || !rendered.has(service);
}

/** A protected container that has not stopped and that a deploy removing orphans could remove (see `isRemovableOrphan`). */
function orphanRemovalRefusal(role: ProtectedRole, name: string, service: string | null, stackName: string, via?: string): DockerEndpointRefusal {
  const subject = via ? `owns a namespace that "${via}" runs in, and "${via}" ${carriesClause(role)}` : carriesClause(role);
  const why = service === null
    ? 'it has no Compose service label'
    : `its service "${service}" is not among the services Compose renders for "${stackName}" (it was removed from the file, or is in a profile that is not enabled)`;
  // A container Compose created for a service the file no longer holds is the
  // orphan a deploy removes for certain. A hand-made one with only a project
  // label survives Compose 5.1.3, so its message says "can remove", not "would".
  const effect = service === null
    ? `so a deploy of "${stackName}" that removes orphans can remove it`
    : `so Compose treats it as an orphan of "${stackName}" and this deploy, which removes orphans, would remove it`;
  return {
    reason: via && role !== 'sencho' ? 'provider' : reasonOf(role),
    service: service ?? name,
    message: `Container "${name}" ${subject}, but ${why}, ${effect}. `
      + (service === null
        ? 'Make it a service of the Compose file, or recreate it from the host without the project label, while Sencho is idle. '
        : `Keep "${service}" in the Compose file (or enable its profile), or recreate the container from the host without the project label, while Sencho is idle. `)
      + 'If it is a leftover you no longer need, stop and remove it from the host first: a container that has stopped does not block a deploy.',
  };
}

/**
 * A protected container that has already stopped, refused on a stop, restart, or
 * removal (a deploy lets a stopped orphan through, see `orphanRemovalRefusal`).
 * Recreating it from the host is not the way out of this refusal: it is not
 * running, so what is left is removing it or starting it again. `name` is the
 * container name `docker rm` takes; `service` is what the refusal reports, the
 * Compose service where it has one.
 */
function stoppedContainerRefusal(
  role: ProtectedRole,
  name: string,
  service: string,
  via?: string,
  refuses = 'Sencho still does not stop, restart, or remove it',
): DockerEndpointRefusal {
  const subject = via ? `owns a namespace that "${via}" runs in, and "${via}" ${carriesClause(role)}` : carriesClause(role);
  const label = role === 'mislabeled' && !via
    ? ` It is labeled ${INFRASTRUCTURE_LABEL} with a value other than "true"; correct the label when you start it again.`
    : '';
  return {
    reason: via && role !== 'sencho' ? 'provider' : reasonOf(role),
    service,
    message: `Container "${name}" ${subject}. "${name}" is not running, but ${refuses}. `
      + `If it is a leftover you no longer need, remove it from the host (docker rm ${name}); otherwise start it again from the host (docker compose up -d) while Sencho is idle.${label}`,
  };
}

/**
 * Every container on the node (running or stopped), and the ones that belong to
 * the stack, matched by project name or working directory. Exported so the
 * Compose version notice and the Compose Doctor note judge the same containers
 * the guard judges.
 */
export async function listNodeContainers(nodeId: number, stackName: string): Promise<{ all: ListedContainer[]; stack: ListedContainer[] }> {
  const composeDir = NodeRegistry.getInstance().getComposeDir(nodeId);
  const all = await DockerController.getInstance(nodeId).getDocker().listContainers({ all: true }) as ListedContainer[];
  const stack = all.filter(container => {
    const labels = container.Labels ?? {};
    return labels['com.docker.compose.project'] === stackName
      || workingDirMatchesStack(labels['com.docker.compose.project.working_dir'], stackName, composeDir);
  });
  return { all, stack };
}

/** Containers carrying the infrastructure label, whatever its value and wherever they run. */
function labeledContainers(all: ListedContainer[]): ListedContainer[] {
  return all.filter(container => container.Labels?.[INFRASTRUCTURE_LABEL] !== undefined);
}

function nameOf(container: ListedContainer): string {
  return container.Names?.[0]?.replace(/^\//, '') ?? '';
}

/** The service a refusal reports for a stack container: its Compose service, else its name or id. */
function reportedServiceOf(container: ListedContainer): string {
  return serviceOf(container) || nameOf(container) || container.Id || 'unknown';
}

/**
 * The provider's container is matched by id, by name, and by Compose project and
 * service, because a recreate gives the provider a new id while the cached
 * answer still names the old one. A Compose recreate keeps the name even when
 * the container carries no Compose labels (the provider was resolved without a
 * project or service, or was recreated by hand under the same name), so the
 * name match holds whatever the labels say. A listed container supplies
 * `Names`, an inspected one `Name`.
 */
function isProviderContainer(
  container: { Id?: string; Name?: string; Names?: string[]; Labels?: Record<string, string> },
  provider: DockerEndpointContainer,
): boolean {
  if (container.Id && container.Id === provider.containerId) return true;
  const providerName = bareName(provider.containerName);
  if (providerName && [container.Name, ...(container.Names ?? [])].some(name => bareName(name) === providerName)) return true;
  if (provider.project === null || provider.service === null) return false;
  return container.Labels?.['com.docker.compose.project'] === provider.project
    && container.Labels?.['com.docker.compose.service'] === provider.service;
}

/** Matches a caller-supplied reference (full or short id, or container name) to the provider without inspecting it. */
function namesProviderContainer(reference: string, provider: DockerEndpointContainer): boolean {
  return matchesContainerId(provider.containerId, reference)
    || provider.containerName.replace(/^\//, '') === reference.replace(/^\//, '');
}

function sharesSenchoNetwork(
  networks: Record<string, { NetworkID?: string } | null> | undefined,
  self: SelfIdentityService,
): boolean {
  return Object.entries(networks ?? {}).some(([name, network]) =>
    self.isOwnNetwork(name) || (!!network?.NetworkID && self.isOwnNetwork(network.NetworkID)));
}

/**
 * The services whose network, pid, or ipc namespace `services` run in,
 * transitively: stopping or recreating one of them takes the service down with
 * it. Services that merely share an owner with it, or run in its own namespace,
 * are not included: stopping those cannot stop it. Each owner is mapped to the
 * protected service it was reached from.
 */
function namespaceOwners(services: Array<string | null>, rendered: Map<string, RenderedService>): Map<string, string> {
  const owners = new Map<string, string>();
  const roots = new Set(services.filter((s): s is string => s !== null));
  const queue = [...roots].map(root => ({ name: root, via: root }));
  while (queue.length > 0) {
    const { name, via } = queue.shift() as { name: string; via: string };
    for (const owner of rendered.get(name)?.namespaceServices ?? []) {
      if (owners.has(owner) || roots.has(owner)) continue;
      owners.set(owner, via);
      queue.push({ name: owner, via });
    }
  }
  return owners;
}

/** `unreliable`: the running container's hash cannot be compared (see `RenderedService.hashUnreliable`). */
type Recreate = 'yes' | 'no' | 'unknown' | 'unreliable' | 'version';

/**
 * Compose pull policies that can replace the image on `up`: the pulling ones
 * fetch a newer image, and `build` rebuilds from the build context (also for a
 * build-only service with no `image`), which the config hash and the local
 * image id read before the command do not see.
 */
const REPLACING_POLICY = /^(always|refresh|daily|weekly|every_.+|build)$/i;

/**
 * Whether `service` itself would be recreated by `compose up -d`: a different
 * config hash, a different local image id behind its tag (a pull that landed
 * outside Sencho), a digest-pin overlay rewriting its image, or a container
 * created by a different Compose version all do.
 */
async function ownRecreate(
  input: EndpointGuardInput,
  stackContainers: ListedContainer[],
  service: string,
  rendered: RenderedService | undefined,
  composeVersion: () => Promise<string | null>,
): Promise<Recreate> {
  const mutation = input.mutation;
  if (mutation.kind === 'up' && mutation.pinnedServices?.includes(service)) return 'yes';
  // A pull policy that can fetch or build a newer image on `up` can replace the
  // container behind a hash and a local image id that both still match.
  if (rendered?.pullPolicy && REPLACING_POLICY.test(rendered.pullPolicy)) return 'unknown';
  const hash = await input.probes.configHash(service);
  if (!hash) return 'unknown';
  const existing = stackContainers.filter(container => serviceOf(container) === service);
  if (existing.length === 0) return 'no';
  if (existing.some(container => container.Labels?.['com.docker.compose.config-hash'] !== hash)) {
    // The label of a service that resolves a namespace or volumes_from reference never equals the rendered hash.
    return rendered?.hashUnreliable ? 'unreliable' : 'yes';
  }
  if (rendered?.image) {
    const image = await input.probes.localImage(rendered.image);
    if (image.state === 'unknown') return 'unknown';
    const wanted = image.id.replace(/^sha256:/, '');
    if (existing.some(container => (container.ImageID ?? '').replace(/^sha256:/, '') !== wanted)) return 'yes';
  }
  // "Unchanged" is only knowable for the Compose version that created the
  // container: a different Compose can recreate it even when the hash and the
  // image both match (Compose 5.6 recreated an unchanged project created by
  // 5.1.3), so a version mismatch, a container that records none, or a version
  // that cannot be read cannot be predicted and is refused rather than guessed.
  const running = normalizeComposeVersion(await composeVersion());
  if (!running) return 'version';
  if (existing.some(container => normalizeComposeVersion(container.Labels?.['com.docker.compose.version']) !== running)) return 'version';
  return 'no';
}

/**
 * Whether `compose up -d` would stop or recreate `service`: its own recreate
 * decision, or that of anything it is wired to, because Compose recreates or
 * restarts a service when a service it links to, mounts volumes from, runs in
 * the namespace of, or lists in `depends_on` with `restart: true` is recreated.
 * `unreliable` takes precedence over `version` and `unknown` so the refusal
 * names the hash limitation; either way the operation is refused.
 */
async function wouldRecreate(
  input: EndpointGuardInput,
  stackContainers: ListedContainer[],
  service: string,
  rendered: Map<string, RenderedService>,
  composeVersion: () => Promise<string | null>,
): Promise<Recreate> {
  let unknown = false;
  let unreliable = false;
  let version = false;
  const visited = new Set<string>();
  const queue = [service];
  while (queue.length > 0) {
    const name = queue.shift() as string;
    if (visited.has(name)) continue;
    visited.add(name);
    const view = rendered.get(name);
    const own = await ownRecreate(input, stackContainers, name, view, composeVersion);
    if (own === 'yes') return 'yes';
    if (own === 'unknown') unknown = true;
    if (own === 'unreliable') unreliable = true;
    if (own === 'version') version = true;
    // A link to a service the render does not contain (a disabled profile) cannot be recreated.
    queue.push(...(view?.linkedServices ?? []).filter(linked => rendered.has(linked)));
  }
  if (unreliable) return 'unreliable';
  if (version) return 'version';
  return unknown ? 'unknown' : 'no';
}

function viewOf(provider: DockerEndpointProvider): ProviderView {
  switch (provider.state) {
    case 'resolved': return { state: 'resolved', provider: provider.provider };
    case 'unresolved': return { state: 'unresolved', reason: provider.reason };
    case 'none': return { state: 'none' };
    default: {
      const unreachable: never = provider;
      throw new Error(`Unhandled Docker endpoint provider state: ${JSON.stringify(unreachable)}`);
    }
  }
}

/**
 * Returns the refusal for a mutation that would stop or recreate the container
 * carrying this node's Docker API, or null when the mutation may run. Remote
 * nodes are never evaluated: their lifecycle is proxied to their own Sencho.
 */
export async function evaluateDockerEndpointGuard(input: EndpointGuardInput): Promise<DockerEndpointRefusal | null> {
  const { nodeId, stackName, mutation } = input;
  if (NodeRegistry.getInstance().getNode(nodeId)?.type === 'remote') return null;

  const self = SelfIdentityService.getInstance();
  const selfState = await self.ensureResolved();
  const provider = viewOf(await resolveDockerEndpointProvider());
  // One read per evaluation: the version is the same for every service, and a
  // deploy may judge several protected services. A failed probe is "cannot
  // tell", never a thrown evaluation.
  let composeVersionCall: Promise<string | null> | null = null;
  const composeVersion = (): Promise<string | null> =>
    (composeVersionCall ??= input.probes.composeVersion().catch(() => null));

  let allContainers: ListedContainer[];
  let stackContainers: ListedContainer[];
  try {
    ({ all: allContainers, stack: stackContainers } = await listNodeContainers(nodeId, stackName));
  } catch (error) {
    // A failed read is not permission, Docker being unreachable included: the
    // connection can recover before the mutation that follows.
    return {
      reason: 'unresolved',
      service: null,
      message: `Sencho could not list the containers of "${stackName}" (${getErrorMessage(error, 'Docker error')}), so it cannot tell whether this operation would stop the container that carries its Docker connection.`,
    };
  }
  // A stack with nothing deployed yet has nothing to stop, but a first deploy
  // creates containers, so its labels are validated like any other.
  if (stackContainers.length === 0) {
    if (isEngineDriven(mutation)) return null;
    const firstRender = await readRendered(input.probes);
    return firstRender.state === 'failed' ? renderFailureRefusal(stackName, firstRender.detail) : invalidRenderedLabel(firstRender.services);
  }

  const found: Protected[] = [];
  const selfContainers = stackContainers.filter(c => typeof c.Id === 'string' && self.isOwnContainer(c.Id));
  if (selfContainers.length > 0) found.push({ containers: selfContainers, role: 'sencho' });
  const providerContainers = provider.state === 'resolved'
    ? stackContainers.filter(c => isProviderContainer(c, provider.provider))
    : [];
  if (providerContainers.length > 0) found.push({ containers: providerContainers, role: 'provider' });

  if (selfState === 'unresolved') {
    const candidates = await getRuntimeContainerIdCandidates();
    const mayBeSelf = candidates.length === 0
      || stackContainers.some(c => typeof c.Id === 'string' && candidates.some(id => matchesContainerId(c.Id as string, id)));
    if (mayBeSelf) {
      return {
        reason: 'unresolved',
        service: null,
        message: `Sencho could not identify its own container (${self.getUnresolvedReason() ?? 'Docker did not answer'}), so it cannot tell whether "${stackName}" is the stack it runs in. `
          + 'Check the reason in parentheses (for example that the Docker endpoint allows container inspect requests, and that /proc is readable), then retry.',
      };
    }
  }

  // The provider could not be told apart: every container that shares a network
  // with Sencho (every container when Sencho's own networks are unknown) might
  // be the one carrying the Docker connection.
  if (provider.state === 'unresolved') {
    const maybeProvider = stackContainers.filter(c =>
      !selfContainers.includes(c)
      && (selfState !== 'resolved' || sharesSenchoNetwork(c.NetworkSettings?.Networks, self)));
    if (maybeProvider.length > 0) found.push({ containers: maybeProvider, role: 'unknown_provider' });
  }

  // The label is read from the deployed containers, running or stopped (what is
  // actually deployed) and from the rendered file (what the next deploy would
  // deploy), so removing it from the file does not unprotect a container that
  // still carries it.
  const renderResult = await readRendered(input.probes);
  // A deploy, update, or per-service change is decided from the rendered model
  // (pull policy, wiring, labels), so one that cannot be rendered is refused
  // rather than guessed: Compose does not always fail by itself (a render that
  // times out or overflows its cap, while `up` has a far longer budget). A stop
  // or restart does not need the render: a failed one falls back to the deployed
  // containers, so it stays possible while the file is broken.
  if (renderResult.state === 'failed' && !isEngineDriven(mutation)) {
    return renderFailureRefusal(stackName, renderResult.detail);
  }
  const rendered = renderResult.services;
  // An invalid value in the file refuses before anything runs, so it can be
  // fixed by editing the file. An invalid value on a running container cannot
  // be fixed from here without recreating it, so that container is protected
  // like a labeled one instead of locking the whole stack.
  const invalid = invalidRenderedLabel(rendered);
  if (invalid) return invalid;
  const alreadyProvider = new Set(found.filter(f => f.role === 'provider').flatMap(f => f.containers));
  const labeledOnly = stackContainers.filter(c => {
    const service = serviceOf(c);
    const deployed = c.Labels?.[INFRASTRUCTURE_LABEL];
    return !alreadyProvider.has(c)
      && (deployed === 'true' || (service !== null && rendered.get(service)?.infrastructure === 'true'));
  });
  if (labeledOnly.length > 0) found.push({ containers: labeledOnly, role: 'provider' });
  const mislabeled = stackContainers.filter(c => {
    const deployed = c.Labels?.[INFRASTRUCTURE_LABEL];
    return deployed !== undefined && deployed !== 'true' && !alreadyProvider.has(c) && !labeledOnly.includes(c);
  });
  if (mislabeled.length > 0) found.push({ containers: mislabeled, role: 'mislabeled' });

  // The service whose network, pid, or ipc namespace Sencho or the provider
  // runs in is protected too: stopping, restarting, or recreating it takes the
  // protected container down with it. (A service that merely runs in the same
  // namespace, or in the provider's own, cannot stop it and is left alone.)
  for (const entry of [...found]) {
    if (entry.role !== 'sencho' && entry.role !== 'provider') continue;
    const owners = namespaceOwners(entry.containers.map(serviceOf), rendered);
    // One entry per protected service, so each refusal names the service it protects.
    for (const via of new Set(owners.values())) {
      const extra = stackContainers.filter(c => {
        const service = serviceOf(c);
        return service !== null && owners.get(service) === via && !entry.containers.includes(c);
      });
      if (extra.length > 0) found.push({ containers: extra, role: entry.role, via });
    }
  }

  // The deployed protected containers (running or stopped) keep the namespaces they were created in,
  // whatever the file says now: removing `pid: service:vpn` from the file does
  // not move the proxy out of vpn's namespace until the proxy is recreated.
  // Ownership is read from the containers themselves, across projects and
  // through chains of owners.
  const docker = DockerController.getInstance(nodeId).getDocker() as InspectsContainers;
  const roots = new Map<string, { role: 'sencho' | 'provider'; target: NamespaceTarget; label: string }>();
  for (const entry of found) {
    if (entry.role !== 'sencho' && entry.role !== 'provider') continue;
    for (const c of entry.containers) {
      if (typeof c.Id !== 'string' || entry.via) continue;
      roots.set(c.Id, { role: entry.role, target: { containerId: c.Id, containerName: c.Names?.[0]?.replace(/^\//, '') ?? '' }, label: serviceOf(c) ?? c.Names?.[0]?.replace(/^\//, '') ?? c.Id });
    }
  }
  // A container carrying the label is protected wherever it runs: its namespace
  // owner may live in another project, and a proxy detection missed is
  // protected by the label alone. (A stopped container with the label stays
  // protected here, so every operation refuses it except a deploy that does not
  // recreate it (a stopped orphan's removal is one).)
  for (const c of labeledContainers(allContainers)) {
    if (typeof c.Id !== 'string' || roots.has(c.Id)) continue;
    roots.set(c.Id, { role: 'provider', target: { containerId: c.Id, containerName: nameOf(c) }, label: serviceOf(c) ?? (nameOf(c) || c.Id) });
  }
  if (provider.state === 'resolved' && !roots.has(provider.provider.containerId)) {
    roots.set(provider.provider.containerId, {
      role: 'provider',
      target: provider.provider,
      label: provider.provider.service ?? provider.provider.containerName,
    });
  }
  const identity = self.getIdentity();
  if (selfState === 'resolved' && identity.containerId && !roots.has(identity.containerId)) {
    roots.set(identity.containerId, {
      role: 'sencho',
      target: { containerId: identity.containerId, containerName: identity.containerName ?? '' },
      label: self.getComposeLocation().service ?? 'sencho',
    });
  }
  for (const root of roots.values()) {
    const owners = await namespaceOwnerRefs(docker, root.target);
    if (owners.state === 'unknown') {
      return {
        reason: 'unresolved',
        service: null,
        message: `Sencho could not inspect the container "${root.label}" (${owners.detail}), so it cannot tell which containers own a namespace it runs in and whether this operation would stop one of them. `
          + 'Check that the Docker endpoint allows container inspect requests, then retry.',
      };
    }
    const extra = stackContainers.filter(c =>
      !roots.has(c.Id ?? '') && namesAnyOwner(owners.owners, c.Id ?? '', c.Names?.[0]));
    if (extra.length > 0) found.push({ containers: extra, role: root.role, via: root.label });
  }

  const selfProject = selfContainers[0]?.Labels?.['com.docker.compose.project'] || null;
  const providerInfo = provider.state === 'resolved' ? provider.provider : null;
  const providerReason = provider.state === 'unresolved' ? provider.reason : null;
  const restartsSelf = mutation.kind === 'restart' || (mutation.kind === 'service' && mutation.restart === true);
  for (const entry of found) {
    // A protected container without a Compose service label (a stale or hand-made
    // container carrying the stack label) is still protected, under its name. On a
    // deploy it is not one of the stack's services, so what Compose decides for a
    // service of the same name says nothing about it; `up --remove-orphans` can
    // remove it when it carries a project label (the stack is matched by project
    // label or by working directory, and the project name Compose runs under can
    // differ from the stack name in case or through a `name:` key). The same goes
    // for a container whose service label names a service the rendered file no
    // longer holds (a removed service is the orphan Compose removes for sure).
    // One with no project label at all is outside the project and left alone.
    // One that has stopped is removed too, but the guard lets it through:
    // removing it cannot cut the connection. (It could be started between this
    // check and the removal, a window every check here has; the removal itself
    // is not guarded again.)
    let judged = entry.containers;
    if (mutation.kind === 'up') {
      const orphan = entry.containers.find(c => !isStopped(c) && isRemovableOrphan(c, rendered));
      if (orphan) return orphanRemovalRefusal(entry.role, nameOf(orphan) || orphan.Id || 'unknown', serviceOf(orphan), stackName, entry.via);
      // What is left is judged as a service: an orphan that has stopped is not one, and a container outside the project is not recreated by this deploy.
      judged = entry.containers.filter(c => {
        const service = serviceOf(c);
        return service !== null && rendered.has(service);
      });
    }
    const services = [...new Set(judged.map(reportedServiceOf))];
    for (const service of services) {
      if (mutation.kind === 'service' && mutation.service !== service) continue;
      if (restartsSelf && entry.role === 'sencho' && !entry.via) continue;
      if (mutation.kind === 'up') {
        const recreate = await wouldRecreate(input, stackContainers, service, rendered, composeVersion);
        if (recreate === 'no') continue;
        if (recreate === 'unknown' || recreate === 'unreliable' || recreate === 'version') {
          return unknownRecreateRefusal(entry.role, service, entry.via, recreate === 'unreliable' ? 'hash' : recreate === 'version' ? 'version' : 'unknown');
        }
      }
      // A stop, restart, take down, or delete of a service whose containers have all stopped: recreating it is not the advice that fits.
      // (An unidentified provider keeps its own refusal: the cause is that detection failed, not the container.)
      const ofService = judged.filter(c => reportedServiceOf(c) === service);
      if (entry.role !== 'unknown_provider' && ofService.length > 0 && ofService.every(isStopped)) {
        const stoppedName = nameOf(ofService[0]) || ofService[0].Id || service;
        if (isEngineDriven(mutation)) return stoppedContainerRefusal(entry.role, stoppedName, service, entry.via);
        // An update (a rollback is one) refuses because the stack holds the container, not because it would stop or recreate it.
        if (mutation.kind === 'update') {
          return stoppedContainerRefusal(
            entry.role, stoppedName, service, entry.via,
            `an update or rollback of "${stackName}" recreates the stack's services, and Sencho does not run one while a container that carries the Docker connection is in the stack`,
          );
        }
      }
      return entry.via
        ? namespaceOwnerRefusal(entry.role, service, entry.via)
        : refusalFor(entry.role, service, providerInfo, selfProject, providerReason);
    }
  }
  return null;
}

function invalidRenderedLabel(rendered: Map<string, RenderedService>): DockerEndpointRefusal | null {
  for (const [service, view] of rendered) {
    if (view.infrastructure !== undefined && view.infrastructure !== 'true') return invalidLabelRefusal(service, view.infrastructure);
  }
  return null;
}

type RenderResult =
  | { state: 'ok'; services: Map<string, RenderedService> }
  | { state: 'failed'; detail: string; services: Map<string, RenderedService> };

/** The rendered services; `failed` (with an empty model) when the stack cannot be rendered or the render does not parse. */
async function readRendered(probes: EndpointGuardProbes): Promise<RenderResult> {
  try {
    const rendered = await probes.renderConfig();
    if (rendered) return { state: 'ok', services: readRenderedServices(rendered) };
    console.warn('[DockerEndpointGuard] Compose config could not be rendered; %s is not read from the file', INFRASTRUCTURE_LABEL);
    return { state: 'failed', detail: 'Compose returned no configuration', services: new Map() };
  } catch (error) {
    const detail = getErrorMessage(error, 'render failed');
    console.warn('[DockerEndpointGuard] Could not read %s from the Compose config:', INFRASTRUCTURE_LABEL, detail);
    return { state: 'failed', detail, services: new Map() };
  }
}

function renderFailureRefusal(stackName: string, detail: string): DockerEndpointRefusal {
  return {
    reason: 'unresolved',
    service: null,
    message: `Sencho could not render the Compose configuration of "${stackName}" (${detail}), so it cannot tell whether this operation would stop or recreate the container that carries its Docker connection. `
      + 'Fix the configuration (rendering it must also take under 20 seconds and produce no more than 5 MiB of output), then retry.',
  };
}

type InspectedContainer = {
  Id?: string;
  Name?: string;
  Config?: { Labels?: Record<string, string> };
  /** `docker inspect` State; `Status` is `running`, `exited`, ... (a missing one counts as running). */
  State?: { Status?: string };
  NetworkSettings?: { Networks?: Record<string, { NetworkID?: string } | null> };
};

export interface InspectsContainers {
  getContainer(id: string): { inspect(): Promise<unknown> };
  listContainers(options?: object): Promise<unknown>;
}

export interface ContainerGuardOptions {
  /**
   * Let a restart of the detected provider itself through. Auto-Heal restarts
   * the proxy when its health check fails; nothing else is exempt, so a stop or
   * removal of the provider, the owner of a namespace the provider or Sencho
   * runs in, a labeled container that is not the detected provider, and a
   * mislabeled one are still refused.
   */
  allowProvider?: boolean;
}

function inspectFailureRefusal(containerId: string, error: unknown): DockerEndpointRefusal {
  return {
    reason: 'unresolved',
    service: null,
    message: `Sencho could not inspect container "${containerId}" (${getErrorMessage(error, 'Docker error')}), so it cannot tell whether this operation would stop the container that carries its Docker connection.`,
  };
}

/**
 * Container-level guard for stop, restart, and removal (removal is evaluated as
 * a stop). It mirrors the stack level: the provider (by id, by name, or by
 * Compose project and service) is refused on stop and removal, and on restart
 * unless `allowProvider` is set; a container carrying the infrastructure label
 * that is not the provider is refused on every action, `allowProvider` or not; a
 * container that may be the provider when it cannot be told apart is refused;
 * the Sencho container is refused on stop and removal only (a restart brings it
 * back, which is the one intended way to bounce Sencho). The owner of a network,
 * pid, or ipc namespace that the provider, Sencho, or any container carrying the
 * infrastructure label runs in is refused as well, whatever the action. One of
 * those (the provider, a labeled or mislabeled container, or a namespace
 * owner) that has already stopped is still refused, because a removal is
 * evaluated as a stop and force-removes a container that was started since the
 * check (the one exception is `allowProvider`'s restart of the provider, in any
 * state, which is how a stopped proxy comes back). When the state is known (an
 * inspect that answered, or the labeled list), the refusal says it is not
 * running and names the host-side removal rather than advising a recreate. A
 * refusal decided before the state is read (an inspect that failed or was
 * denied, matched by id or name) keeps the recreate advice.
 *
 * A container that cannot be inspected is refused, except one that does not
 * exist (HTTP 404, the operation then fails by itself), a restart of Sencho, a
 * restart of the resolved provider under `allowProvider` (whatever the error),
 * and one whose inspect the endpoint denies (HTTP 401 or 403) and that is not
 * the provider: that one is let through only when the provider, Sencho, and the
 * labeled containers can be read and none of them is it or runs in its
 * namespace.
 */
export async function evaluateDockerEndpointContainer(
  containerId: string,
  action: 'stop' | 'restart',
  docker: InspectsContainers,
  options: ContainerGuardOptions = {},
): Promise<DockerEndpointRefusal | null> {
  const self = SelfIdentityService.getInstance();
  const selfState = await self.ensureResolved();
  const provider = viewOf(await resolveDockerEndpointProvider());
  const providerVerdict = (service: string, resolved: DockerEndpointContainer, selfProject: string | null, stoppedAs?: string): DockerEndpointRefusal | null => {
    if (options.allowProvider && action === 'restart') return null;
    return stoppedAs ? stoppedContainerRefusal('provider', stoppedAs, service) : refusalFor('provider', service, resolved, selfProject);
  };

  // Null when the endpoint denied the inspect and the container is judged without it.
  let info: InspectedContainer | null = null;
  try {
    info = await docker.getContainer(containerId).inspect() as InspectedContainer;
  } catch (error) {
    const status = (error as { statusCode?: number } | null)?.statusCode;
    // No such container: the operation fails by itself.
    if (status === 404) return null;
    // What is known without the inspect still applies: a resolved provider or
    // Sencho matched by id or name.
    if (provider.state === 'resolved' && namesProviderContainer(containerId, provider.provider)) {
      return providerVerdict(provider.provider.service ?? provider.provider.containerName, provider.provider, self.getIdentity().composeProjectName);
    }
    if (self.isOwnContainer(bareName(containerId))) {
      return action === 'stop' ? refusalFor('sencho', self.getComposeLocation().service ?? 'sencho', null, null) : null;
    }
    // A failed inspect is no proof the container is ordinary: a transport failure
    // (refused, reset, timed out, no socket) can recover before the mutation runs,
    // and an engine error (HTTP 409, 5xx) says nothing about the container. Only a
    // deny (401, 403) is judged further, from the provider's and Sencho's own
    // namespaces and the labeled containers, which are read below; an endpoint
    // that cannot be told apart refuses here.
    const denied = status === 401 || status === 403;
    if (!denied || provider.state === 'unresolved' || selfState === 'unresolved') return inspectFailureRefusal(containerId, error);
  }

  const fullId = info?.Id ?? containerId;
  const labels = info?.Config?.Labels ?? {};
  const service = labels['com.docker.compose.service'] || (info?.Name ?? '').replace(/^\//, '') || containerId;
  const selfProject = self.getIdentity().composeProjectName;

  // The name a refusal gives a container that is not running (what `docker rm` takes), undefined when it is running or its state is not known.
  const stoppedAs = (state: string | undefined, name: string): string | undefined => (isStoppedState(state) ? name || fullId : undefined);
  const infoStoppedAs = stoppedAs(info?.State?.Status, bareName(info?.Name));

  if (info) {
    if (provider.state === 'resolved' && isProviderContainer({ Id: fullId, Name: info.Name, Labels: labels }, provider.provider)) {
      return providerVerdict(service, provider.provider, selfProject, infoStoppedAs);
    }
    const labelValue = labels[INFRASTRUCTURE_LABEL];
    if (labelValue !== undefined) {
      const role = labelValue === 'true' ? 'provider' : 'mislabeled';
      return infoStoppedAs ? stoppedContainerRefusal(role, infoStoppedAs, service) : refusalFor(role, service, null, selfProject);
    }
  }

  let isSelf = self.isOwnContainer(fullId) || self.isOwnContainer(bareName(containerId));
  if (!isSelf && selfState === 'unresolved') {
    const candidates = await getRuntimeContainerIdCandidates();
    if (candidates.length === 0) {
      return {
        reason: 'unresolved',
        service: null,
        message: `Sencho could not identify its own container (${self.getUnresolvedReason() ?? 'Docker did not answer'}), so it cannot tell whether this is the container it runs in. `
          + 'Check the reason in parentheses (for example that the Docker endpoint allows container inspect requests, and that /proc is readable), then retry.',
      };
    }
    isSelf = candidates.some(id => matchesContainerId(fullId, id));
  }
  if (isSelf) {
    if (action !== 'stop') return null;
    return refusalFor('sencho', self.getComposeLocation().service ?? 'sencho', null, null);
  }

  // The containers carrying the infrastructure label are protected wherever they
  // run: a proxy that detection missed has the label alone, and its namespace
  // owner may live in any project. A failed list is not permission either.
  let labeled: ListedContainer[];
  try {
    labeled = labeledContainers(await docker.listContainers({ all: true, filters: { label: [INFRASTRUCTURE_LABEL] } }) as ListedContainer[]);
  } catch (error) {
    return {
      reason: 'unresolved',
      service,
      message: `Sencho could not list the containers that carry ${INFRASTRUCTURE_LABEL} (${getErrorMessage(error, 'Docker error')}), so it cannot tell whether "${service}" carries its Docker connection or owns a namespace one of them runs in. `
        + 'Check that the Docker endpoint allows container list requests, then retry.',
    };
  }
  // Without an inspect the label could not be read from the container itself.
  if (!info) {
    const bare = containerId.replace(/^\//, '');
    const asLabeled = labeled.find(c => (!!c.Id && matchesContainerId(c.Id, containerId)) || nameOf(c) === bare);
    if (asLabeled) {
      const listedService = serviceOf(asLabeled) ?? service;
      const listedStoppedAs = stoppedAs(asLabeled.State, nameOf(asLabeled));
      if (provider.state === 'resolved' && isProviderContainer(asLabeled, provider.provider)) {
        return providerVerdict(listedService, provider.provider, selfProject, listedStoppedAs);
      }
      const role = asLabeled.Labels?.[INFRASTRUCTURE_LABEL] === 'true' ? 'provider' : 'mislabeled';
      return listedStoppedAs ? stoppedContainerRefusal(role, listedStoppedAs, listedService) : refusalFor(role, listedService, null, selfProject);
    }
  }

  // Stopping the owner of a namespace the provider, Sencho, or a labeled container runs in takes that container down with it.
  const dependents = new Map<string, { role: 'provider' | 'sencho'; target: NamespaceTarget; label: string }>();
  if (provider.state === 'resolved') {
    dependents.set(provider.provider.containerId, { role: 'provider', target: provider.provider, label: provider.provider.service ?? provider.provider.containerName });
  }
  const identity = self.getIdentity();
  if (selfState === 'resolved' && identity.containerId) {
    dependents.set(identity.containerId, {
      role: 'sencho',
      target: { containerId: identity.containerId, containerName: identity.containerName ?? '' },
      label: self.getComposeLocation().service ?? 'sencho',
    });
  }
  for (const c of labeled) {
    if (typeof c.Id !== 'string' || dependents.has(c.Id)) continue;
    dependents.set(c.Id, { role: 'provider', target: { containerId: c.Id, containerName: nameOf(c) }, label: serviceOf(c) ?? (nameOf(c) || c.Id) });
  }
  for (const dependent of dependents.values()) {
    const owns = await namespaceOwnerRefs(docker, dependent.target);
    if (owns.state === 'unknown') {
      return {
        reason: 'unresolved',
        service,
        message: `Sencho could not inspect the container "${dependent.label}" (${owns.detail}), so it cannot tell whether "${service}" owns a namespace that container runs in. `
          + 'Check that the Docker endpoint allows container inspect requests, then retry.',
      };
    }
    // A provider recreated since it was resolved has a new id; the inspect by name shows which container it is now.
    if (!info && dependent.role === 'provider' && provider.state === 'resolved' && dependent.target === provider.provider
      && owns.target && namesContainer(owns.target, fullId, containerId)) {
      return providerVerdict(service, provider.provider, selfProject);
    }
    if (namesAnyOwner(owns.owners, fullId, info?.Name ?? containerId)) {
      return infoStoppedAs ? stoppedContainerRefusal(dependent.role, infoStoppedAs, service, dependent.label) : namespaceOwnerRefusal(dependent.role, service, dependent.label);
    }
  }

  if (provider.state === 'unresolved' && (selfState !== 'resolved' || sharesSenchoNetwork(info?.NetworkSettings?.Networks, self))) {
    return refusalFor('unknown_provider', service, null, selfProject, provider.reason);
  }
  return null;
}

type NamespaceTarget = { containerId: string; containerName: string };

/** A container named by a `container:<ref>` mode: the reference, and who it is when it could be inspected. */
type NamespaceOwner = { ref: string; id?: string; name?: string };

type NamespaceOwnerRefs =
  | { state: 'ok'; owners: NamespaceOwner[]; target: { id?: string; name?: string } | null }
  | { state: 'unknown'; detail: string };

function bareName(name: string | undefined): string {
  return name?.replace(/^\//, '') ?? '';
}

/** Whether `identity` (an inspected container) is the container with this id, or this id or name. */
function namesContainer(identity: { id?: string; name?: string }, id: string, reference: string): boolean {
  return (!!identity.id && (matchesContainerId(identity.id, id) || matchesContainerId(identity.id, reference)))
    || (!!identity.name && identity.name === bareName(reference));
}

/** Whether any of the namespace owners is the container with this id and name. */
function namesAnyOwner(owners: NamespaceOwner[], id: string, name: string | undefined): boolean {
  return owners.some(owner => matchesContainerId(id, owner.ref)
    || (!!bareName(name) && bareName(name) === bareName(owner.ref))
    || namesContainer(owner, id, name ?? id));
}

/**
 * The containers whose network, pid, or ipc namespace `target` (the provider,
 * Sencho, or a labeled container) runs in (HostConfig `container:<id or name>`),
 * followed through owners that run in another owner's namespace in turn:
 * stopping any of them takes the target down. The target is inspected by id and,
 * when a recreate changed the id since it was resolved, by name. A container that
 * cannot be inspected (other than one that no longer exists) makes the answer
 * `unknown`: a failure here is not a reason to let the operation pass.
 */
async function namespaceOwnerRefs(docker: InspectsContainers, target: NamespaceTarget): Promise<NamespaceOwnerRefs> {
  type Inspected = { Id?: string; Name?: string; HostConfig?: { NetworkMode?: string; PidMode?: string; IpcMode?: string } };
  const inspect = async (reference: string): Promise<Inspected | null> => {
    try {
      return await docker.getContainer(reference).inspect() as Inspected;
    } catch (error) {
      if ((error as { statusCode?: number } | null)?.statusCode === 404) return null;
      throw error;
    }
  };
  const owners: NamespaceOwner[] = [];
  const seen = new Set<string>();
  try {
    const first = await inspect(target.containerId) ?? (target.containerName ? await inspect(target.containerName) : null);
    const queue: Inspected[] = first ? [first] : [];
    while (queue.length > 0) {
      const info = queue.shift() as Inspected;
      for (const mode of [info.HostConfig?.NetworkMode, info.HostConfig?.PidMode, info.HostConfig?.IpcMode]) {
        if (typeof mode !== 'string' || !mode.startsWith('container:')) continue;
        const reference = mode.slice('container:'.length);
        if (!reference || seen.has(reference)) continue;
        seen.add(reference);
        const owner = await inspect(reference);
        owners.push({ ref: reference, id: owner?.Id, name: owner?.Name ? bareName(owner.Name) : undefined });
        if (owner) queue.push(owner);
      }
    }
    return { state: 'ok', owners, target: first ? { id: first.Id, name: first.Name ? bareName(first.Name) : undefined } : null };
  } catch (error) {
    const detail = getErrorMessage(error, 'inspect failed');
    console.warn('[DockerEndpointGuard] Could not inspect %s to check its shared namespaces:', target.containerName || target.containerId, detail);
    return { state: 'unknown', detail };
  }
}
