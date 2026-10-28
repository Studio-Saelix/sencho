/**
 * The detached helper that replaces the container carrying this node's Docker
 * API (a Docker socket proxy in Sencho's own Compose project) during a Fleet
 * Update or Reapply.
 *
 * It runs in its own container, started from the running Sencho image by ID,
 * and talks to Docker through the host socket the provider itself mounts, so
 * recreating the provider never cuts its own connection. The sequence:
 *
 *   stage    (attached, before anything stops) proves the socket reaches the
 *            same engine, renders the Compose project, makes the provider image
 *            available, and snapshots the running provider for rollback.
 *   replace  (detached, the last breath) recreates the provider, waits for it,
 *            then either recreates Sencho (`stack` scope) or leaves it running
 *            (`provider` scope). Either way it waits for Sencho to report that
 *            it reaches Docker through the new provider (the ack). Any failure
 *            restores the snapshot. The outcome file is the only success signal.
 *
 * Everything the helper does goes through `HelperDeps`, so the sequence is
 * unit-tested without Docker; `endpointProviderHelper.ts` wires the real ones.
 */

export const ENDPOINT_PROVIDER_DIR = 'endpoint-provider';
/** The data directory as the helper container sees it. */
export const HELPER_DATA_DIR = '/app/data';
/** Where the helper container mounts the provider's host socket. */
export const HELPER_SOCKET_PATH = '/var/run/docker.sock';

export type ProviderReplaceMode = 'update' | 'reapply';

/**
 * What the helper is allowed to recreate. `stack` recreates Sencho after the
 * provider (a shared-project Update or Reapply, whose ack comes from the new
 * Sencho process). `provider` replaces only the endpoint container and leaves
 * Sencho running: the process that spawned the helper verifies Docker through
 * the new container and answers, so no Sencho release or restart is involved.
 */
export type ProviderReplaceScope = 'provider' | 'stack';

export interface ProviderReplacePlan {
  schemaVersion: 1;
  operationId: string;
  mode: ProviderReplaceMode;
  /** Absent in plans written before provider-only replacement existed, which always recreated Sencho. */
  scope?: ProviderReplaceScope;
  project: string;
  workingDir: string;
  configFiles: string[];
  providerService: string;
  senchoService: string;
  providerContainerId: string;
  /** A rewritten Compose file (Sencho repin) to copy onto the host before recreating. */
  composeCopy: { stagedPath: string; targetPath: string } | null;
  pruneOnUpdate: boolean;
  providerReadySeconds: number;
  ackSeconds: number;
}

export type StageResult =
  | { ok: true; providerImage: string; previousImageId: string; previousImageRef: string | null }
  | { ok: false; message: string };

/** Written by the new Sencho process once it has checked Docker through the replacement provider. */
export interface ProviderAck {
  operationId: string;
  ok: boolean;
  detail: string | null;
}

export type ProviderPhase = 'provider' | 'sencho' | 'verify';

/** The helper's durable verdict. `ok: true` is written only after a positive ack. */
export type ProviderOutcome =
  | { operationId: string; ok: true }
  | {
    operationId: string;
    ok: false;
    phase: ProviderPhase;
    error: string;
    /** `attempted: false` means the replacement never reached the rollback step. */
    rollback: { attempted: false } | { attempted: true; restored: boolean; error: string | null };
  };

/** The parts of `docker container inspect` a rollback needs to recreate the container. */
export interface ContainerSnapshot {
  Id: string;
  Name: string;
  Image: string;
  Config: Record<string, unknown> & { Image?: string; Hostname?: string; Labels?: Record<string, string>; Healthcheck?: { Test?: string[] } };
  HostConfig: Record<string, unknown>;
  NetworkSettings?: { Networks?: Record<string, NetworkEndpoint | null> };
  State?: { Running?: boolean; Status?: string; Health?: { Status?: string } };
}

export interface NetworkEndpoint {
  Aliases?: string[] | null;
  IPAMConfig?: Record<string, unknown> | null;
  Links?: string[] | null;
  DriverOpts?: Record<string, string> | null;
  MacAddress?: string;
}

export interface HelperDocker {
  ping(): Promise<void>;
  inspect(containerId: string): Promise<ContainerSnapshot | null>;
  /** Ids of every container (running or not) Compose labels as this project's service. */
  serviceContainers(project: string, service: string): Promise<string[]>;
  remove(containerId: string): Promise<void>;
  create(options: Record<string, unknown>): Promise<string>;
  connect(network: string, containerId: string, endpoint: Record<string, unknown>): Promise<void>;
  start(containerId: string): Promise<void>;
  pruneDanglingImages(): Promise<void>;
}

export interface HelperDeps {
  docker: HelperDocker;
  /** Runs `docker compose -p <project> -f <files...> <args>` in the project working directory. */
  compose(args: string[]): Promise<{ ok: boolean; output: string }>;
  readJson(path: string): Promise<unknown | null>;
  writeJson(path: string, value: unknown): Promise<void>;
  /** Removes a handoff file so a stale phase marker cannot outlive a rollback. */
  removeFile(path: string): Promise<void>;
  copyFile(from: string, to: string): Promise<void>;
  sleep(ms: number): Promise<void>;
  now(): number;
  log(message: string): void;
}

export function operationDir(dataDir: string, operationId: string): string {
  return `${dataDir}/${ENDPOINT_PROVIDER_DIR}/${operationId}`;
}

export const helperFiles = {
  plan: (dataDir: string, id: string) => `${operationDir(dataDir, id)}/plan.json`,
  snapshot: (dataDir: string, id: string) => `${operationDir(dataDir, id)}/rollback.json`,
  /** Written once the provider container has been recreated, before the helper waits for the ack. */
  recreated: (dataDir: string, id: string) => `${operationDir(dataDir, id)}/provider-recreated.json`,
  ack: (dataDir: string, id: string) => `${operationDir(dataDir, id)}/ack.json`,
  outcome: (dataDir: string, id: string) => `${operationDir(dataDir, id)}/outcome.json`,
  log: (dataDir: string, id: string) => `${operationDir(dataDir, id)}/helper.log`,
};

const PROVIDER_RUNNING_POLL_MS = 2_000;
const ACK_POLL_MS = 2_000;

function trimOutput(output: string): string {
  const text = output.trim();
  return text.length > 2_000 ? `${text.slice(0, 2_000)}...` : text;
}

/**
 * Before anything stops: proves the mounted socket reaches the engine that
 * runs the provider, renders the project, makes the provider image available,
 * and writes the rollback snapshot. Returns a refusal message on any doubt.
 */
export async function stageProviderReplacement(plan: ProviderReplacePlan, deps: HelperDeps): Promise<StageResult> {
  try {
    await deps.docker.ping();
  } catch (error) {
    return { ok: false, message: `The helper could not reach Docker through the host socket the Docker endpoint mounts (${errorText(error)}).` };
  }

  const current = await deps.docker.inspect(plan.providerContainerId);
  const labels = current?.Config.Labels ?? {};
  if (!current
    || labels['com.docker.compose.project'] !== plan.project
    || labels['com.docker.compose.service'] !== plan.providerService) {
    return {
      ok: false,
      message: `The host socket the Docker endpoint mounts does not show its container "${plan.providerService}", so it belongs to a different Docker engine. Mount the host's Docker socket into the endpoint service directly.`,
    };
  }
  if (!current.State?.Running) {
    return { ok: false, message: `The Docker endpoint container for "${plan.providerService}" is not running.` };
  }

  const rendered = await deps.compose(['config', '--format', 'json']);
  if (!rendered.ok) {
    return { ok: false, message: `The Compose project failed to render: ${trimOutput(rendered.output)}` };
  }
  let services: Record<string, { image?: unknown }>;
  try {
    const parsed = JSON.parse(rendered.output) as { services?: Record<string, { image?: unknown }> };
    services = parsed.services ?? {};
  } catch {
    return { ok: false, message: 'The rendered Compose project could not be read.' };
  }
  const providerImage = services[plan.providerService]?.image;
  if (!services[plan.senchoService]) {
    return { ok: false, message: `The Compose project no longer declares the Sencho service "${plan.senchoService}".` };
  }
  if (typeof providerImage !== 'string' || !providerImage) {
    return { ok: false, message: `The Compose project does not declare an image for "${plan.providerService}", so it cannot be replaced safely.` };
  }

  const pulled = await deps.compose(['pull', '--quiet', '--policy', plan.mode === 'update' ? 'always' : 'missing', plan.providerService]);
  if (!pulled.ok) {
    return { ok: false, message: `Could not pull ${providerImage} for "${plan.providerService}": ${trimOutput(pulled.output)}` };
  }

  await deps.writeJson(helperFiles.snapshot(HELPER_DATA_DIR, plan.operationId), current);
  return { ok: true, providerImage, previousImageId: current.Image, previousImageRef: current.Config.Image ?? null };
}

/**
 * Turns an inspected container back into a create request: the same name,
 * the previous image by ID, its config, host config and the first network's
 * endpoint. Other networks are connected after create. Docker-generated
 * values that name the old container (its short-id hostname and alias) are
 * dropped so the restored container does not claim an id it no longer has.
 */
export function createOptionsFromSnapshot(snapshot: ContainerSnapshot): { options: Record<string, unknown>; extraNetworks: Array<[string, Record<string, unknown>]> } {
  const shortId = snapshot.Id.slice(0, 12);
  const config: Record<string, unknown> = { ...snapshot.Config, Image: snapshot.Image };
  if (config.Hostname === shortId) delete config.Hostname;
  const networks = Object.entries(snapshot.NetworkSettings?.Networks ?? {})
    .map(([name, endpoint]): [string, Record<string, unknown>] => [name, endpointConfig(endpoint, shortId)]);
  const [first, ...rest] = networks;
  return {
    options: {
      ...config,
      name: snapshot.Name.replace(/^\//, ''),
      HostConfig: snapshot.HostConfig,
      ...(first ? { NetworkingConfig: { EndpointsConfig: { [first[0]]: first[1] } } } : {}),
    },
    extraNetworks: rest,
  };
}

function endpointConfig(endpoint: NetworkEndpoint | null, shortId: string): Record<string, unknown> {
  const aliases = (endpoint?.Aliases ?? []).filter(alias => alias !== shortId);
  return {
    ...(aliases.length ? { Aliases: aliases } : {}),
    ...(endpoint?.IPAMConfig ? { IPAMConfig: endpoint.IPAMConfig } : {}),
    ...(endpoint?.Links?.length ? { Links: endpoint.Links } : {}),
    ...(endpoint?.DriverOpts ? { DriverOpts: endpoint.DriverOpts } : {}),
  };
}

/** Waits until the container runs, and is healthy when it declares a healthcheck. */
async function waitReady(deps: HelperDeps, containerId: string, seconds: number): Promise<string | null> {
  const deadline = deps.now() + seconds * 1000;
  let last = 'it did not start';
  while (deps.now() < deadline) {
    const state = (await deps.docker.inspect(containerId).catch(() => null))?.State;
    const health = state?.Health?.Status;
    if (state?.Running && (!health || health === 'healthy')) return null;
    if (health === 'unhealthy') return 'its healthcheck reports unhealthy';
    last = state?.Running ? `its healthcheck is ${health ?? 'pending'}` : `it is ${state?.Status ?? 'missing'}`;
    await deps.sleep(PROVIDER_RUNNING_POLL_MS);
  }
  return last;
}

/** Puts the snapshot back: removes whatever now holds the service, recreates the old container and waits for it. */
export async function restoreProvider(plan: ProviderReplacePlan, deps: HelperDeps): Promise<string | null> {
  try {
    const snapshot = await deps.readJson(helperFiles.snapshot(HELPER_DATA_DIR, plan.operationId)) as ContainerSnapshot | null;
    if (!snapshot) return 'the rollback snapshot is missing';
    for (const id of await deps.docker.serviceContainers(plan.project, plan.providerService)) {
      await deps.docker.remove(id);
    }
    const { options, extraNetworks } = createOptionsFromSnapshot(snapshot);
    const restoredId = await deps.docker.create(options);
    for (const [network, endpoint] of extraNetworks) await deps.docker.connect(network, restoredId, endpoint);
    await deps.docker.start(restoredId);
    const notReady = await waitReady(deps, restoredId, plan.providerReadySeconds);
    return notReady ? `the restored container is not ready: ${notReady}` : null;
  } catch (error) {
    return errorText(error);
  }
}

async function readAck(plan: ProviderReplacePlan, deps: HelperDeps): Promise<ProviderAck | null> {
  const raw = await deps.readJson(helperFiles.ack(HELPER_DATA_DIR, plan.operationId));
  if (!raw || typeof raw !== 'object') return null;
  const ack = raw as Partial<ProviderAck>;
  if (ack.operationId !== plan.operationId || typeof ack.ok !== 'boolean') return null;
  return { operationId: plan.operationId, ok: ack.ok, detail: typeof ack.detail === 'string' ? ack.detail : null };
}

/**
 * The last breath. Recreates the provider, then (for `stack` scope) Sencho, and
 * decides the outcome from Sencho's ack. Writes exactly one outcome file.
 */
export async function replaceProvider(plan: ProviderReplacePlan, deps: HelperDeps): Promise<ProviderOutcome> {
  /** The helper log is diagnostic. A broken stderr stream must never skip recovery. */
  const log = (message: string): void => {
    try {
      deps.log(message);
    } catch {
      // Nothing useful can be recorded; recovery must still run.
    }
  };
  /**
   * The outcome file is the only verdict signal Sencho has. Losing it cannot
   * undo a recovery that already ran, so a failed write is logged rather than
   * turned into an exception the outer catch could report as "not attempted".
   */
  const publishOutcome = async (outcome: ProviderOutcome): Promise<void> => {
    try {
      await deps.writeJson(helperFiles.outcome(HELPER_DATA_DIR, plan.operationId), outcome);
    } catch (error) {
      log(`could not write the outcome file: ${errorText(error)}`);
    }
  };
  const fail = async (phase: ProviderPhase, error: string): Promise<ProviderOutcome> => {
    log(`${phase} failed: ${error}; restoring the previous Docker endpoint`);
    const rollbackError = await restoreProvider(plan, deps);
    log(rollbackError ? `restore failed: ${rollbackError}` : 'previous Docker endpoint restored');
    // The marker means "the replacement is installed". A restored (or unknown)
    // endpoint must not leave it behind for a later process to acknowledge.
    try {
      await deps.removeFile(helperFiles.recreated(HELPER_DATA_DIR, plan.operationId));
    } catch (removeError) {
      log(`could not remove the recreation marker: ${errorText(removeError)}`);
    }
    const outcome: ProviderOutcome = {
      operationId: plan.operationId,
      ok: false,
      phase,
      error,
      rollback: { attempted: true, restored: rollbackError === null, error: rollbackError },
    };
    await publishOutcome(outcome);
    return outcome;
  };

  // Lets the route answer before the provider (and the connection it carried) goes away.
  await deps.sleep(3_000);

  if (plan.composeCopy) {
    try {
      await deps.copyFile(plan.composeCopy.stagedPath, plan.composeCopy.targetPath);
    } catch (error) {
      // Nothing was recreated yet, so there is nothing to restore; say so.
      const outcome: ProviderOutcome = {
        operationId: plan.operationId,
        ok: false,
        phase: 'provider',
        error: `Failed to write the updated compose file: ${errorText(error)}`,
        rollback: { attempted: false },
      };
      await publishOutcome(outcome);
      return outcome;
    }
  }

  let recreated = false;
  try {
    log(`recreating ${plan.providerService}`);
    const provider = await deps.compose([
      'up', '-d', '--no-deps', '--force-recreate', '--wait', '--wait-timeout', String(plan.providerReadySeconds), plan.providerService,
    ]);
    if (!provider.ok) return await fail('provider', `Recreating "${plan.providerService}" failed: ${trimOutput(provider.output)}`);
    recreated = true;

    // Durable phase marker: the replacement exists now, so a process that stayed
    // running may verify Docker through it and answer. Without this the ack could
    // be written before the old container was ever replaced. A write failure is
    // itself a reason to recover: the helper cannot announce the new provider.
    try {
      await deps.writeJson(helperFiles.recreated(HELPER_DATA_DIR, plan.operationId), {
        operationId: plan.operationId,
        at: deps.now(),
      });
    } catch (error) {
      return await fail('verify', `Could not record that "${plan.providerService}" was replaced: ${errorText(error)}`);
    }

    if (plan.scope === 'provider') {
      log('Sencho stays running; waiting for it to reconnect through the new Docker endpoint');
    } else {
      log(`recreating ${plan.senchoService}`);
      const sencho = await deps.compose(['up', '-d', '--no-deps', '--force-recreate', plan.senchoService]);
      if (!sencho.ok) return await fail('sencho', `Recreating "${plan.senchoService}" failed: ${trimOutput(sencho.output)}`);
    }

    const deadline = deps.now() + plan.ackSeconds * 1000;
    let ack: ProviderAck | null = null;
    while (!ack && deps.now() < deadline) {
      ack = await readAck(plan, deps);
      if (!ack) await deps.sleep(ACK_POLL_MS);
    }
    if (!ack) {
      return await fail('verify', `Sencho did not confirm Docker access through the new "${plan.providerService}" within ${plan.ackSeconds} seconds.`);
    }
    if (!ack.ok) {
      return await fail('verify', `Sencho could not use Docker through the new "${plan.providerService}": ${ack.detail ?? 'no detail'}`);
    }

    if (plan.pruneOnUpdate) {
      await deps.docker.pruneDanglingImages().catch(error => log(`dangling image prune failed: ${errorText(error)}`));
    }
    const outcome: ProviderOutcome = { operationId: plan.operationId, ok: true };
    try {
      await deps.writeJson(helperFiles.outcome(HELPER_DATA_DIR, plan.operationId), outcome);
    } catch (error) {
      // Sencho would wait out its deadline with no verdict. Treat an
      // unpublishable success as a verification failure so recovery runs.
      return await fail('verify', `The replacement was verified but its outcome could not be recorded: ${errorText(error)}`);
    }
    log('replacement verified');
    return outcome;
  } catch (error) {
    // Every exception after the provider was recreated goes through the same
    // recovery as a failed compose step, and never depends on a handoff write
    // succeeding. Before the replacement there is nothing to restore.
    if (recreated) {
      return await fail('verify', `The replacement could not be completed: ${errorText(error)}`);
    }
    const outcome: ProviderOutcome = {
      operationId: plan.operationId,
      ok: false,
      phase: 'provider',
      error: `The replacement helper could not start the replacement: ${errorText(error)}`,
      rollback: { attempted: false },
    };
    await publishOutcome(outcome);
    return outcome;
  }
}

export function errorText(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return String(error);
}

export function parseOutcome(raw: unknown, operationId: string): ProviderOutcome | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  if (value.operationId !== operationId || typeof value.ok !== 'boolean') return null;
  if (value.ok) return { operationId, ok: true };
  const rollback = value.rollback as Record<string, unknown> | undefined;
  const attempted = !!rollback && rollback.attempted !== false && rollback.error !== 'not attempted';
  return {
    operationId,
    ok: false,
    phase: value.phase === 'sencho' || value.phase === 'verify' ? value.phase : 'provider',
    error: typeof value.error === 'string' ? value.error : 'The Docker endpoint replacement failed.',
    rollback: attempted
      // Outcomes written before this field existed are assumed to come from the
      // rollback path, except the entrypoint's explicit "not attempted" marker.
      // A missing or malformed rollback object is treated as unconfirmed. An
      // older compose-copy failure cannot be told apart from a real restore.
      ? { attempted: true, restored: rollback?.restored === true, error: typeof rollback?.error === 'string' ? rollback.error : null }
      : { attempted: false },
  };
}
