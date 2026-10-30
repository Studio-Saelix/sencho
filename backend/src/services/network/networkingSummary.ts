/**
 * A cheap per-node networking summary for the Fleet view filter: which stacks
 * are exposed beyond loopback (published ports, host networking, or a tunnel
 * connector), which are exposed without an exposure intent,
 * and which have network drift. It reads each stack's authored Compose layers
 * with the light dependency parser (no `docker compose config` render) and one
 * Docker snapshot, so it stays inexpensive across a node's full stack set.
 *
 * Tunnel detection needs the inputs Compose actually uses. The summary resolves
 * the deploy spec's layers, `COMPOSE_FILE`, auto-discovered override files,
 * YAML merge keys, the names a service's `env_file` entries and `environment`
 * set (a key with no value is set only when the interpolation environment
 * answers it, and left unset it still overrides an `env_file`) plus the one
 * `TS_EXTRA_ARGS` value (parsed with the stack's interpolation environment,
 * then discarded), and interpolation, and follows networks and namespaces the
 * same way the detailed views do. When an input cannot be read completely (a
 * required env file or one in a format other than raw, an include or extends, a
 * `!reset` or `!override` tag, an unresolved template in a detection field, a
 * value-less key or env_file reference with no interpolation environment to
 * answer it, or a layer selector it cannot reproduce), the
 * stack is reported as unreadable rather than counted as not exposed. It does
 * not apply Compose profiles, so a profile-gated connector counts as present.
 */
import path from 'path';
import DockerController, { type DependencySnapshot } from '../DockerController';
import { FileSystemService } from '../FileSystemService';
import { DatabaseService } from '../DatabaseService';
import { NodeRegistry } from '../NodeRegistry';
import {
  holdsTemplate,
  mergeDeclaredCompose,
  parseComposeDependencies,
  type DeclaredCompose,
} from '../../helpers/composeDependencyParse';
import {
  detectTunnels,
  tailscaleForwardFlags,
  tunnelExposureByService,
  type TunnelDetectionModel,
} from './tunnelDetection';
import { assembleStackDrift } from '../DriftDetectionService';
import { resolveManagedMeshAttachment } from './managedMeshAttachment';
import { isHostNetwork, isLoopback } from './normalize';
import { getErrorMessage } from '../../utils/errors';
import {
  authoredComposeFileArgs,
  composeFileEnvVarSelection,
  composeInterpolation,
} from '../../utils/authoredComposeArgs';
import { COMPOSE_OVERRIDE_FILENAMES } from '../../utils/composeFilenames';
import { ComposeEnvFileError, ComposeEnvFiles, type ComposeEnvLookup } from '../../utils/composeDotenv';
import { sanitizeForLog } from '../../utils/safeLog';
import { isDebugEnabled } from '../../utils/debug';

/** One signal bucket: how many stacks match, and which. */
export interface NetworkingSummaryBucket {
  count: number;
  stacks: string[];
}

export interface NodeNetworkingSummary {
  /** Stacks that publish a host port on a non-loopback interface, use host networking, or are reached through a tunnel. */
  exposed: NetworkingSummaryBucket;
  /** Stacks with an exposed service (published port, host networking, or tunnel) that has no effective exposure intent. */
  unknownExposure: NetworkingSummaryBucket;
  /** Stacks whose running networking disagrees with the Compose file. */
  networkDrift: NetworkingSummaryBucket;
  /** Stacks whose effective Compose inputs could not be fully read (or whose
   *  Compose file is missing or does not parse), so their exposure is unknown
   *  rather than absent. A stack here can also sit in another bucket for what
   *  was readable. Absent from a node that predates this field, whose
   *  unreadable stacks are then not reported at all. */
  unreadable?: NetworkingSummaryBucket;
}

const bucket = (stacks: string[]): NetworkingSummaryBucket => ({ count: stacks.length, stacks });

interface ComposeLayer {
  name: string;
  content: string;
}

interface ComposeContents {
  layers: ComposeLayer[];
  /** Compose's project directory, where relative `env_file:` paths resolve. */
  projectDir: string;
  /** A layer selector or override could not be read, so the layer set is incomplete. */
  opaque: boolean;
}

interface TunnelInputs {
  declared: DeclaredCompose;
  tunneled: Set<string>;
  unreadable: boolean;
}

/** Why a stack is reported unreadable: a fixed reason and the error's code or
 *  class name. Never the message, which can hold a path. */
function noteUnreadable(stack: string, reason: string, error?: unknown): void {
  let cause = '';
  if (error !== undefined) {
    const code = (error as { code?: unknown })?.code;
    let kind = 'unknown';
    if (typeof code === 'string') kind = code;
    else if (error instanceof Error) kind = error.name;
    cause = ` (${sanitizeForLog(kind)})`;
  }
  console.warn('[NetworkingSummary] Stack %s reported unreadable: %s%s.', sanitizeForLog(stack), reason, cause);
}

function isMissingFile(error: unknown): boolean {
  return !!error && typeof error === 'object' && 'code' in error && (error as { code?: unknown }).code === 'ENOENT';
}

/** A post-parse field that can still hide a connector behind an unexpanded template. */
function unresolvedDetectionField(declared: DeclaredCompose): boolean {
  return declared.services.some(service =>
    service.unresolvedDetection === true
    || (service.needsInterpolation === true && (
      holdsTemplate(service.image)
      || holdsTemplate(service.networkMode)
      || service.networks.some(holdsTemplate)
      || (service.envKeys ?? []).some(holdsTemplate)
      || (service.envFiles ?? []).some(entry => holdsTemplate(entry.path))
    )),
  );
}

/** Read the primary compose file plus the auto-discovered override, if any. */
async function readMainLayers(nodeId: number, stack: string, stackDir: string, opaque: boolean): Promise<ComposeContents> {
  const fsSvc = FileSystemService.getInstance(nodeId);
  const main = await fsSvc.getStackContentWithMtime(stack);
  const layers: ComposeLayer[] = [{ name: main.filename, content: main.content }];
  let incomplete = opaque;
  if (!opaque) {
    // Compose loads the first override that exists among its default names,
    // regardless of which base filename it found, and ignores the rest.
    for (const override of COMPOSE_OVERRIDE_FILENAMES) {
      const absolute = path.join(stackDir, override);
      try {
        await fsSvc.access(absolute);
      } catch (error) {
        if (isMissingFile(error)) continue;
        noteUnreadable(stack, 'the auto-discovered override cannot be checked', error);
        incomplete = true;
        break;
      }
      try {
        layers.push({ name: override, content: await fsSvc.readEnvFile(absolute) });
      } catch (error) {
        noteUnreadable(stack, 'the auto-discovered override cannot be read', error);
        incomplete = true;
      }
      break;
    }
  }
  return { layers, projectDir: stackDir, opaque: incomplete };
}

/**
 * The compose layers a run loads, in order, and the project directory relative
 * `env_file:` paths resolve against. A selector that cannot be read falls back
 * to the primary file and marks the result opaque, so known signals still
 * count while absence is never claimed.
 */
async function readComposeContents(nodeId: number, stack: string): Promise<ComposeContents> {
  const fsSvc = FileSystemService.getInstance(nodeId);
  const stackDir = path.resolve(NodeRegistry.getInstance().getComposeDir(nodeId), stack);
  let spec;
  try {
    spec = DatabaseService.getInstance().getGitSource(stack)?.applied_deploy_spec ?? null;
  } catch (error) {
    noteUnreadable(stack, 'the deploy spec cannot be read', error);
    return readMainLayers(nodeId, stack, stackDir, true);
  }

  if (spec && spec.files.length > 0) {
    try {
      const args = authoredComposeFileArgs(stack, nodeId);
      const files: string[] = [];
      let contextDir: string | undefined;
      for (let index = 0; index < args.length; index += 1) {
        if (args[index] === '-f' && args[index + 1] !== undefined) {
          files.push(args[index + 1]);
          index += 1;
        } else if (args[index] === '--project-directory' && args[index + 1] !== undefined) {
          contextDir = args[index + 1];
          index += 1;
        }
      }
      if (files.length > 0) {
        const layers: ComposeLayer[] = [];
        for (const file of files) {
          layers.push({ name: file, content: await fsSvc.readEnvFile(path.resolve(stackDir, file)) });
        }
        return {
          layers,
          projectDir: contextDir ?? path.dirname(path.resolve(stackDir, files[0])),
          opaque: false,
        };
      }
    } catch (error) {
      noteUnreadable(stack, 'a deploy spec layer cannot be read', error);
      return readMainLayers(nodeId, stack, stackDir, true);
    }
    noteUnreadable(stack, 'the deploy spec names no compose file');
    return readMainLayers(nodeId, stack, stackDir, true);
  }

  let selection;
  try {
    selection = await composeFileEnvVarSelection(stack, nodeId);
  } catch (error) {
    noteUnreadable(stack, 'the COMPOSE_FILE selection cannot be read', error);
    return readMainLayers(nodeId, stack, stackDir, true);
  }
  if (selection.kind === 'value') {
    const files = selection.value.split(selection.pathSeparator).filter(Boolean);
    try {
      const layers: ComposeLayer[] = [];
      for (const file of files) {
        layers.push({ name: file, content: await fsSvc.readEnvFile(path.resolve(stackDir, file)) });
      }
      if (layers.length > 0) {
        return {
          layers,
          projectDir: path.dirname(path.resolve(stackDir, files[0])),
          opaque: false,
        };
      }
    } catch (error) {
      noteUnreadable(stack, 'a COMPOSE_FILE layer cannot be read', error);
      return readMainLayers(nodeId, stack, stackDir, true);
    }
  }
  const selectionUnreadable = selection.kind === 'unknown' || selection.kind === 'invalid';
  if (selectionUnreadable) noteUnreadable(stack, `the COMPOSE_FILE selection is ${selection.kind}`);
  return readMainLayers(nodeId, stack, stackDir, selectionUnreadable);
}

/**
 * The stack's interpolation variables when a detection field or a service
 * env_file needs them, with the same warnings the counters always gave when a
 * value cannot be read. A failed lookup leaves the template in place, which the
 * caller reports as unreadable (or counts as forwarding for `TS_EXTRA_ARGS`).
 */
async function interpolationLookup(nodeId: number, stack: string): Promise<ComposeEnvLookup | undefined> {
  try {
    const interpolation = await composeInterpolation(stack, nodeId);
    if (interpolation.kind === 'lookup') return interpolation.lookup;
    if (interpolation.reason === 'unreadable') {
      console.warn('[NetworkingSummary] Stack %s env files cannot be read the way Compose reads them; tunnel inputs left unresolved.',
        sanitizeForLog(stack));
    } else if (isDebugEnabled()) {
      // Ordinary configurations this reader does not model, so not a warning.
      console.log('[NetworkingSummary:diag] Stack %s tunnel inputs left unresolved: %s.', sanitizeForLog(stack), interpolation.reason);
    }
    return undefined;
  } catch (error) {
    // A deploy spec or project env-file selection this run cannot read, or a
    // defect. Those messages carry stack names and paths, never an env value. A
    // ComposeEnvFileError message can hold one, so only its class name is kept.
    const detail = error instanceof ComposeEnvFileError
      ? 'ComposeEnvFileError'
      : error instanceof Error ? `${error.name}: ${error.message}` : 'unknown';
    console.warn('[NetworkingSummary] Stack %s interpolation failed; tunnel inputs left unresolved:',
      sanitizeForLog(stack), sanitizeForLog(detail));
    return undefined;
  }
}

/** The tunnel-reached services in the stack's effective inputs, and whether
 *  those inputs were complete enough to establish absence. */
async function readTunnelInputs(nodeId: number, stack: string, contents: ComposeContents): Promise<TunnelInputs | null> {
  const initial = contents.layers.map(layer => parseComposeDependencies(layer.content, { allowEmptyServices: true, mergeKeys: true }));
  if (initial.some(layer => layer.parseError)) return null;

  const needsLookup = initial.some(layer => layer.services.some(service =>
    service.needsInterpolation === true
    || service.tailscaleFlags?.includes('unresolved') === true
    || (service.envFiles?.length ?? 0) > 0));
  const lookup = needsLookup ? await interpolationLookup(nodeId, stack) : undefined;
  const parsed = lookup
    ? contents.layers.map(layer => parseComposeDependencies(layer.content, { lookup, allowEmptyServices: true, mergeKeys: true }))
    : initial;
  if (parsed.some(layer => layer.parseError)) return null;

  const declared = mergeDeclaredCompose(parsed);
  const unfollowed = declared.hasInclude === true || declared.hasExtends === true || declared.hasLayerTags === true;
  if (unfollowed) noteUnreadable(stack, 'the compose files use include, extends, or a !reset/!override tag');
  let unreadable = contents.opaque || unfollowed;
  if (!lookup && initial.some(layer => layer.services.some(service => service.needsInterpolation === true))) {
    unreadable = true;
  }
  if (lookup && unresolvedDetectionField(declared)) unreadable = true;

  const fsSvc = FileSystemService.getInstance(nodeId);
  for (const service of declared.services) {
    // Compose merges env_file values into the container environment, so a
    // provider key or Tailscale forwarding flag can live there too. Later files
    // override the same key; a service `environment` entry overrides every
    // env_file, even one with no value that leaves the key unset. The files are
    // read in order with the stack's interpolation environment (the reader's
    // base lookup), so a name that only inherits an unset variable is absent.
    // With no lookup, a file that consulted it cannot be judged.
    let lookupNeeded = false;
    const reader = new ComposeEnvFiles(lookup ?? (() => {
      lookupNeeded = true;
      return undefined;
    }));
    for (const envFile of service.envFiles ?? []) {
      if (holdsTemplate(envFile.path)) {
        noteUnreadable(stack, `service ${sanitizeForLog(service.name)} has an env_file path that is an unresolved template`);
        unreadable = true;
        continue;
      }
      if (envFile.unsupportedFormat) {
        noteUnreadable(stack, `service ${sanitizeForLog(service.name)} has an env_file with a format other than raw`);
        unreadable = true;
        continue;
      }
      try {
        reader.read(await fsSvc.readEnvFile(path.resolve(contents.projectDir, envFile.path)), { raw: envFile.raw });
      } catch (error) {
        if (!envFile.required && isMissingFile(error)) continue;
        // Keys and flags this file would add are unknown, so no absence can be claimed.
        noteUnreadable(stack, `service ${sanitizeForLog(service.name)} has an env_file that cannot be read`, error);
        unreadable = true;
      }
    }
    if (lookupNeeded) unreadable = true;
    const keys = new Set(reader.assignedNames());
    for (const key of service.unsetEnvKeys ?? []) keys.delete(key);
    for (const key of service.envKeys ?? []) keys.add(key);
    service.envKeys = [...keys];
    const extraArgs = reader.assigned('TS_EXTRA_ARGS');
    if (!service.tailscaleArgsDeclared && extraArgs !== undefined) {
      // The reader has already interpolated (or kept literal) this value, so a
      // `$` left in it is text, not a template for the flag reader to expand.
      service.tailscaleFlags = tailscaleForwardFlags({ TS_EXTRA_ARGS: extraArgs.split('$').join('$$') });
    }
  }

  const model: TunnelDetectionModel = {
    services: declared.services.map(service => ({
      name: service.name,
      image: service.image,
      envKeys: service.envKeys ?? [],
      networkMode: service.networkMode,
      networks: service.networks.map(key => ({ key })),
      ports: service.ports,
      binds: (service.binds ?? []).map(target => ({ target })),
      capAdd: service.capAdd,
      devices: service.devices,
      commandHints: [...(service.commandHints ?? []), ...(service.entrypointHints ?? [])],
      tailscaleFlags: service.tailscaleFlags,
    })),
    networks: Object.assign(Object.create(null) as TunnelDetectionModel['networks'], Object.fromEntries(Object.entries(declared.networks)
      .map(([key, resource]) => [key, { name: resource.name ?? key, external: resource.external }]))),
  };

  return {
    declared,
    tunneled: new Set(tunnelExposureByService(detectTunnels(model)).keys()),
    unreadable,
  };
}

export async function computeNodeNetworkingSummary(nodeId: number): Promise<NodeNetworkingSummary> {
  const fsSvc = FileSystemService.getInstance(nodeId);
  const db = DatabaseService.getInstance();
  const stacks = await fsSvc.getStacks();

  // One snapshot for the whole node; absent when Docker is unreachable, in
  // which case drift is simply not computed (the declared signals still work).
  let snapshot: DependencySnapshot | null = null;
  try {
    snapshot = await DockerController.getInstance(nodeId).getDependencySnapshot(stacks);
  } catch (error) {
    console.warn('[NetworkingSummary] Snapshot unavailable on node %d; drift skipped:',
      nodeId, sanitizeForLog(getErrorMessage(error, 'unknown')));
  }

  const exposed: string[] = [];
  const unknownExposure: string[] = [];
  const networkDrift: string[] = [];
  const unreadable: string[] = [];

  for (const stack of stacks) {
    let contents: ComposeContents;
    try {
      contents = await readComposeContents(nodeId, stack);
    } catch (error) {
      // Unreadable compose (missing, a dangling link or one outside its stack dir, or an I/O error).
      console.warn('[NetworkingSummary] Stack %s reported unreadable, compose file unreadable:',
        sanitizeForLog(stack), sanitizeForLog(getErrorMessage(error, 'unknown')));
      unreadable.push(stack);
      continue;
    }
    let inputs: TunnelInputs | null;
    try {
      inputs = await readTunnelInputs(nodeId, stack, contents);
    } catch (error) {
      // A defect in one stack's inputs must not hide every other stack's summary.
      noteUnreadable(stack, 'reading its tunnel inputs failed', error);
      unreadable.push(stack);
      continue;
    }
    if (inputs === null) {
      console.warn('[NetworkingSummary] Stack %s reported unreadable, a compose layer does not parse.', sanitizeForLog(stack));
      unreadable.push(stack);
      continue;
    }
    if (inputs.unreadable) unreadable.push(stack);

    const declared = inputs.declared;

    // A host-network service publishes every container port directly on the host,
    // so it counts as exposed (beyond loopback) and as publishing even with no
    // declared `ports:`. This keeps the summary honest about host networking,
    // matching the Compose Doctor's host-network finding.
    // A service a tunnel connector reaches is exposed without a published port.
    const publishes = (s: typeof declared.services[number]): boolean =>
      s.ports.length > 0 || isHostNetwork(s.networkMode) || inputs.tunneled.has(s.name);
    const publishesPort = declared.services.some(publishes);
    if (declared.services.some(s => isHostNetwork(s.networkMode) || inputs.tunneled.has(s.name) || s.ports.some(p => !isLoopback(p.hostIp)))) exposed.push(stack);

    if (publishesPort) {
      // Unknown only when a publishing service is effectively unclassified: a
      // service-level intent overrides the stack-level row for that service.
      const intents = db.getStackExposureIntents(nodeId, stack);
      const stackIntent = intents.find(i => i.service === '')?.intent ?? null;
      const byService = new Map(intents.filter(i => i.service !== '').map(i => [i.service, i.intent]));
      const anyUnclassified = declared.services
        .filter(publishes)
        .some(s => {
          const intent = byService.get(s.name) ?? stackIntent;
          return intent === null || intent === 'unknown';
        });
      if (anyUnclassified) unknownExposure.push(stack);
    }

    if (snapshot) {
      // Drift compares the runtime with what was read. A stack in the unreadable
      // bucket may therefore show drift for a network a layer it could not read
      // would have declared; the unreadable bucket is the caveat.
      const containers = snapshot.containers.filter(c => c.stack === stack);
      const managedNetworkAttachment = await resolveManagedMeshAttachment(nodeId, stack);
      const report = assembleStackDrift({
        stack,
        declared,
        containers,
        networks: snapshot.networks,
        managedNetworkAttachment,
      });
      if (report.findings.some(f => f.kind === 'network-undeclared' || f.kind === 'network-missing')) networkDrift.push(stack);
    }
  }

  return {
    exposed: bucket(exposed),
    unknownExposure: bucket(unknownExposure),
    networkDrift: bucket(networkDrift),
    unreadable: bucket(unreadable),
  };
}
