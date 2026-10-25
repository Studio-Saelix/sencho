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
 * inspect fails, and when Compose's recreate decision cannot be predicted. It
 * otherwise lets the operation through: when the stack provably holds neither
 * protected container, for a remote node (its own Sencho guards it), for a
 * restart of Sencho itself, and when Docker is unreachable (the operation then
 * fails by itself with its own error).
 *
 * One evaluator, two call sites: the mutating Compose entry points
 * (`ComposeService`) and container stop/restart/removal (`DockerController`).
 * Scheduler, webhook, GitOps, Blueprint, mesh, and bulk update all reach one of
 * the two.
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
  /** A service-scoped operation: refused only when it targets a protected service. */
  | { kind: 'service'; service: string; restart?: boolean };

type ListedContainer = {
  Id?: string;
  Names?: string[];
  Labels?: Record<string, string>;
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

function serviceOf(container: ListedContainer): string | null {
  return container.Labels?.['com.docker.compose.service'] ?? null;
}

function isDockerUnavailable(error: unknown): boolean {
  const err = error as NodeJS.ErrnoException;
  const message = String(err?.message ?? '').toLowerCase();
  return err?.code === 'ECONNREFUSED'
    || (err?.code === 'ENOENT' && /docker\.sock/i.test(err.message ?? ''))
    || message.includes('econnrefused')
    || message.includes('cannot connect to the docker daemon');
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
  let hasVolumesFrom = false;
  for (const [key, list] of [['volumes_from', service?.volumes_from], ['links', service?.links]] as const) {
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      if (typeof entry !== 'string') continue;
      // A volumes_from entry naming a container is resolved to an id as well, so its hash is unreliable too.
      if (key === 'volumes_from') hasVolumesFrom = true;
      if (entry.startsWith('container:')) continue;
      const name = entry.split(':')[0];
      if (name) linked.add(name);
    }
  }
  return { linked: [...linked], namespace: [...namespace], hashUnreliable: namespace.size > 0 || hasVolumesFrom };
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
    case 'sencho': return 'is the running Sencho instance';
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

function unknownRecreateRefusal(role: ProtectedRole, service: string, via?: string, hashUnreliable = false): DockerEndpointRefusal {
  const subject = via ? `owns a namespace that "${via}" runs in, and "${via}" ${carriesClause(role)}` : carriesClause(role);
  const cause = hashUnreliable
    ? '(the service, or a service it is wired to, uses volumes_from or a service: network, pid, or ipc mode, and the configuration hash Docker records for such a service never equals the one Compose renders, so the two cannot be compared). '
    : '(Compose did not report its configuration hash, its image could not be inspected, or its pull policy can replace the image). ';
  return {
    reason: 'unresolved',
    service,
    message: `Sencho could not tell whether this operation would recreate service "${service}", which ${subject} `
      + cause
      + 'It is refused rather than guessed; '
      + (role === 'sencho' && !via
        ? `use Reapply in ${REAPPLY_PATH} to recreate Sencho on purpose.`
        : 'recreate the service from the host (docker compose up -d) while Sencho is idle.'),
  };
}

/** The stack's containers (running or stopped), matched by project name or working directory. */
async function listStackContainers(nodeId: number, stackName: string): Promise<ListedContainer[]> {
  const composeDir = NodeRegistry.getInstance().getComposeDir(nodeId);
  const all = await DockerController.getInstance(nodeId).getDocker().listContainers({ all: true }) as ListedContainer[];
  return all.filter(container => {
    const labels = container.Labels ?? {};
    return labels['com.docker.compose.project'] === stackName
      || workingDirMatchesStack(labels['com.docker.compose.project.working_dir'], stackName, composeDir);
  });
}

/**
 * The provider's container is matched by id and by Compose project and service,
 * because a recreate gives the provider a new id while the cached answer still
 * names the old one.
 */
function isProviderContainer(
  container: { Id?: string; Labels?: Record<string, string> },
  provider: DockerEndpointContainer,
): boolean {
  if (container.Id && container.Id === provider.containerId) return true;
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
type Recreate = 'yes' | 'no' | 'unknown' | 'unreliable';

/** Compose pull policies that can fetch a newer image on `up`. */
const PULLING_POLICY = /^(always|refresh|daily|weekly|every_.+)$/i;

/**
 * Whether `service` itself would be recreated by `compose up -d`: a different
 * config hash, a different local image id behind its tag (a pull that landed
 * outside Sencho), or a digest-pin overlay rewriting its image all do.
 */
async function ownRecreate(
  input: EndpointGuardInput,
  stackContainers: ListedContainer[],
  service: string,
  rendered: RenderedService | undefined,
): Promise<Recreate> {
  const mutation = input.mutation;
  if (mutation.kind === 'up' && mutation.pinnedServices?.includes(service)) return 'yes';
  // A pull policy that can fetch a newer image on `up` can replace the container
  // behind a hash and a local image id that both still match.
  if (rendered?.pullPolicy && PULLING_POLICY.test(rendered.pullPolicy)) return 'unknown';
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
  return 'no';
}

/**
 * Whether `compose up -d` would stop or recreate `service`: its own recreate
 * decision, or that of anything it is wired to, because Compose recreates or
 * restarts a service when a service it links to, mounts volumes from, runs in
 * the namespace of, or lists in `depends_on` with `restart: true` is recreated.
 * `unreliable` takes precedence over `unknown` so the refusal names the hash
 * limitation; either way the operation is refused.
 */
async function wouldRecreate(
  input: EndpointGuardInput,
  stackContainers: ListedContainer[],
  service: string,
  rendered: Map<string, RenderedService>,
): Promise<Recreate> {
  let unknown = false;
  let unreliable = false;
  const visited = new Set<string>();
  const queue = [service];
  while (queue.length > 0) {
    const name = queue.shift() as string;
    if (visited.has(name)) continue;
    visited.add(name);
    const view = rendered.get(name);
    const own = await ownRecreate(input, stackContainers, name, view);
    if (own === 'yes') return 'yes';
    if (own === 'unknown') unknown = true;
    if (own === 'unreliable') unreliable = true;
    // A link to a service the render does not contain (a disabled profile) cannot be recreated.
    queue.push(...(view?.linkedServices ?? []).filter(linked => rendered.has(linked)));
  }
  if (unreliable) return 'unreliable';
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

  let stackContainers: ListedContainer[];
  try {
    stackContainers = await listStackContainers(nodeId, stackName);
  } catch (error) {
    // With Docker unreachable the operation fails by itself with its own error.
    if (isDockerUnavailable(error)) return null;
    return {
      reason: 'unresolved',
      service: null,
      message: `Sencho could not list the containers of "${stackName}" (${getErrorMessage(error, 'Docker error')}), so it cannot tell whether this operation would stop the container that carries its Docker connection.`,
    };
  }
  // Nothing exists yet, so nothing can be stopped.
  if (stackContainers.length === 0) return null;

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

  // The label is read from the running containers (what is actually deployed)
  // and from the rendered file (what the next deploy would deploy), so removing
  // it from the file does not unprotect a container that still carries it.
  const rendered = await readRendered(input.probes);
  // An invalid value in the file refuses before anything runs, so it can be
  // fixed by editing the file. An invalid value on a running container cannot
  // be fixed from here without recreating it, so that container is protected
  // like a labeled one instead of locking the whole stack.
  for (const [service, view] of rendered) {
    if (view.infrastructure !== undefined && view.infrastructure !== 'true') return invalidLabelRefusal(service, view.infrastructure);
  }
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

  const selfProject = selfContainers[0]?.Labels?.['com.docker.compose.project'] ?? null;
  const providerInfo = provider.state === 'resolved' ? provider.provider : null;
  const providerReason = provider.state === 'unresolved' ? provider.reason : null;
  for (const entry of found) {
    // A protected container without a Compose service label (a stale or hand-made
    // container carrying the stack label) is still protected, under its name.
    const services = [...new Set(entry.containers.map(c => serviceOf(c) ?? c.Names?.[0]?.replace(/^\//, '') ?? c.Id ?? 'unknown'))];
    for (const service of services) {
      if (mutation.kind === 'service' && mutation.service !== service) continue;
      const restartsSelf = mutation.kind === 'restart' || (mutation.kind === 'service' && mutation.restart === true);
      if (restartsSelf && entry.role === 'sencho' && !entry.via) continue;
      if (mutation.kind === 'up') {
        const recreate = await wouldRecreate(input, stackContainers, service, rendered);
        if (recreate === 'no') continue;
        if (recreate === 'unknown' || recreate === 'unreliable') return unknownRecreateRefusal(entry.role, service, entry.via, recreate === 'unreliable');
      }
      return entry.via
        ? namespaceOwnerRefusal(entry.role, service, entry.via)
        : refusalFor(entry.role, service, providerInfo, selfProject, providerReason);
    }
  }
  return null;
}

/** The rendered services, empty when the stack cannot be rendered (the Compose operation then fails by itself). */
async function readRendered(probes: EndpointGuardProbes): Promise<Map<string, RenderedService>> {
  try {
    const rendered = await probes.renderConfig();
    if (rendered) return readRenderedServices(rendered);
    console.warn('[DockerEndpointGuard] Compose config could not be rendered; %s is read from running containers only', INFRASTRUCTURE_LABEL);
  } catch (error) {
    console.warn('[DockerEndpointGuard] Could not read %s from the Compose config:', INFRASTRUCTURE_LABEL, getErrorMessage(error, 'render failed'));
  }
  return new Map();
}

type InspectedContainer = {
  Id?: string;
  Name?: string;
  Config?: { Labels?: Record<string, string> };
  NetworkSettings?: { Networks?: Record<string, { NetworkID?: string } | null> };
};

export interface InspectsContainers {
  getContainer(id: string): { inspect(): Promise<unknown> };
}

/**
 * Container-level guard for stop, restart, and removal (removal is evaluated as
 * a stop). It mirrors the stack level: the provider (by id, by Compose service,
 * or by label) is always refused; a container that may be the provider when it
 * cannot be told apart is refused; the Sencho container is refused on stop and
 * removal only (a restart brings it back, which is the one intended way to
 * bounce Sencho). The owner of a network, pid, or ipc namespace that the
 * provider or Sencho runs in is refused as well, whatever the action.
 */
export async function evaluateDockerEndpointContainer(
  containerId: string,
  action: 'stop' | 'restart',
  docker: InspectsContainers,
): Promise<DockerEndpointRefusal | null> {
  const self = SelfIdentityService.getInstance();
  const selfState = await self.ensureResolved();
  const provider = viewOf(await resolveDockerEndpointProvider());

  let info: InspectedContainer;
  try {
    info = await docker.getContainer(containerId).inspect() as InspectedContainer;
  } catch (error) {
    const status = (error as { statusCode?: number } | null)?.statusCode;
    // No such container, or Docker unreachable: the operation fails by itself.
    if (status === 404 || isDockerUnavailable(error)) return null;
    // Inspect is denied or failing. What is known without it still applies: a
    // resolved provider or Sencho matched by id is refused, and so is anything
    // that cannot be told apart while the provider or Sencho is unresolved. An
    // ordinary container is not held hostage by a proxy that denies inspect.
    if (provider.state === 'resolved' && namesProviderContainer(containerId, provider.provider)) {
      return refusalFor('provider', provider.provider.service ?? provider.provider.containerName, provider.provider, self.getIdentity().composeProjectName);
    }
    if (self.isOwnContainer(containerId)) {
      return action === 'stop' ? refusalFor('sencho', self.getComposeLocation().service ?? 'sencho', null, null) : null;
    }
    if (provider.state === 'unresolved' || selfState === 'unresolved') {
      return {
        reason: 'unresolved',
        service: null,
        message: `Sencho could not inspect container "${containerId}" (${getErrorMessage(error, 'Docker error')}), so it cannot tell whether this operation would stop the container that carries its Docker connection.`,
      };
    }
    return null;
  }

  const fullId = info.Id ?? containerId;
  const labels = info.Config?.Labels ?? {};
  const service = labels['com.docker.compose.service'] || (info.Name ?? '').replace(/^\//, '') || containerId;
  const selfProject = self.getIdentity().composeProjectName;
  const subject = { Id: fullId, Labels: labels };

  if (provider.state === 'resolved' && isProviderContainer(subject, provider.provider)) {
    return refusalFor('provider', service, provider.provider, selfProject);
  }
  const labelValue = labels[INFRASTRUCTURE_LABEL];
  if (labelValue === 'true') return refusalFor('provider', service, null, selfProject);
  if (labelValue !== undefined) return refusalFor('mislabeled', service, null, selfProject);

  let isSelf = self.isOwnContainer(fullId) || self.isOwnContainer(containerId);
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

  // Stopping the owner of a namespace the provider or Sencho runs in takes that container down with it.
  const dependents: Array<{ role: 'provider' | 'sencho'; target: NamespaceTarget; label: string }> = [];
  if (provider.state === 'resolved') {
    dependents.push({ role: 'provider', target: provider.provider, label: provider.provider.service ?? provider.provider.containerName });
  }
  const identity = self.getIdentity();
  if (selfState === 'resolved' && identity.containerId) {
    dependents.push({
      role: 'sencho',
      target: { containerId: identity.containerId, containerName: identity.containerName ?? '' },
      label: self.getComposeLocation().service ?? 'sencho',
    });
  }
  for (const dependent of dependents) {
    const owns = await runsInNamespaceOf(docker, dependent.target, fullId, info.Name);
    if (owns.state === 'yes') return namespaceOwnerRefusal(dependent.role, service, dependent.label);
    if (owns.state === 'unknown') {
      return {
        reason: 'unresolved',
        service,
        message: `Sencho could not inspect the container "${dependent.label}" (${owns.detail}), so it cannot tell whether "${service}" owns a namespace that container runs in. `
          + 'Check that the Docker endpoint allows container inspect requests, then retry.',
      };
    }
  }

  if (provider.state === 'unresolved' && (selfState !== 'resolved' || sharesSenchoNetwork(info.NetworkSettings?.Networks, self))) {
    return refusalFor('unknown_provider', service, null, selfProject, provider.reason);
  }
  return null;
}

type NamespaceTarget = { containerId: string; containerName: string };

/**
 * Whether `target` (the provider, or Sencho) runs in a network, pid, or ipc
 * namespace owned by the container `ownerId` (Compose `network_mode`, `pid`, or
 * `ipc` set to `service:x`): stopping the owner then takes the target down with
 * it. The target is inspected by id and, when a recreate changed the id since
 * it was resolved, by name. A target that cannot be inspected is `unknown`: the
 * owner's own inspect worked, so a failure here is not a reason to let it pass.
 */
async function runsInNamespaceOf(
  docker: InspectsContainers,
  target: NamespaceTarget,
  ownerId: string,
  ownerName: string | undefined,
): Promise<{ state: 'yes' | 'no' } | { state: 'unknown'; detail: string }> {
  type NamespaceModes = { HostConfig?: { NetworkMode?: string; PidMode?: string; IpcMode?: string } };
  const inspect = async (reference: string): Promise<NamespaceModes | null> => {
    try {
      return await docker.getContainer(reference).inspect() as NamespaceModes;
    } catch (error) {
      if ((error as { statusCode?: number } | null)?.statusCode === 404) return null;
      throw error;
    }
  };
  const ownerNames = [ownerName?.replace(/^\//, '')].filter((n): n is string => !!n);
  try {
    const info = await inspect(target.containerId) ?? (target.containerName ? await inspect(target.containerName) : null);
    if (!info) return { state: 'no' };
    const runsInOwner = [info.HostConfig?.NetworkMode, info.HostConfig?.PidMode, info.HostConfig?.IpcMode].some(mode => {
      if (typeof mode !== 'string' || !mode.startsWith('container:')) return false;
      const reference = mode.slice('container:'.length);
      return matchesContainerId(ownerId, reference) || ownerNames.includes(reference);
    });
    return { state: runsInOwner ? 'yes' : 'no' };
  } catch (error) {
    const detail = getErrorMessage(error, 'inspect failed');
    console.warn('[DockerEndpointGuard] Could not inspect %s to check its shared namespaces:', target.containerName || target.containerId, detail);
    return { state: 'unknown', detail };
  }
}
