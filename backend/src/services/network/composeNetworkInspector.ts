/**
 * Compose Network Inspector: renders the authored effective model and pairs it
 * with the live Docker snapshot to produce the per-stack networking facts a
 * Community user reads (network map, membership, published ports/bindings,
 * network_mode, extra_hosts, and runtime drift). Advisory and read-only; it
 * renders the AUTHORED model only (no Mesh overrides) and never returns or logs
 * raw docker stderr, env values, or label values.
 */
import DockerController, { type DependencySnapshot } from '../DockerController';
import { ComposeService } from '../ComposeService';
import { FileSystemService } from '../FileSystemService';
import { parseEffectiveModel, type EffectiveModel } from '../preflight/effectiveModel';
import { parseMissingRequiredVars } from '../../helpers/envVarParse';
import {
  compareStackNetworks, fromEffectiveModel, isAllInterfaces, isLoopback,
} from './normalize';
import type {
  NetworkDriftFacts, NetworkFactNetwork, NetworkFactService, NetworkRuntimeState, StackNetworkFacts,
} from './types';

import { getErrorMessage } from '../../utils/errors';
import { redactSensitiveText, sanitizeForLog } from '../../utils/safeLog';

const MAX_RENDER_ERROR = 600;
const EMPTY_DRIFT: NetworkDriftFacts = {
  runtimeOnlyAttachments: [], declaredButUnused: [], missingFromRuntime: [], foreignNetworkAttachments: [],
};

/**
 * Pure assembler: turns a rendered model plus an optional runtime snapshot into
 * the facts payload. A null model means the render failed (renderError carries a
 * redacted reason); a null snapshot means the runtime is unavailable, so drift
 * is left empty rather than computed against an empty snapshot.
 */
export function assembleStackNetworkFacts(
  stackName: string,
  model: EffectiveModel | null,
  renderError: string | null,
  snapshot: DependencySnapshot | null,
): StackNetworkFacts {
  const runtime: NetworkRuntimeState = snapshot ? 'available' : 'unavailable';

  if (!model) {
    return { stack: stackName, renderable: false, renderError, runtime, networks: [], services: [], drift: EMPTY_DRIFT };
  }

  const networks: NetworkFactNetwork[] = Object.entries(model.networks).map(([key, res]) => ({
    key,
    name: res.name,
    external: res.external,
    internal: res.internal,
    createdByStack: !res.external && key !== 'default',
  }));

  const services: NetworkFactService[] = model.services.map(s => ({
    name: s.name,
    networks: s.networks.map(n => ({ key: n.key, aliases: n.aliases })),
    publishedPorts: s.ports.map(p => ({
      hostIp: p.hostIp,
      startPort: p.startPort,
      endPort: p.endPort,
      protocol: p.protocol,
      allInterfaces: isAllInterfaces(p.hostIp),
      loopbackOnly: isLoopback(p.hostIp),
    })),
    networkMode: s.networkMode,
    extraHosts: s.extraHosts,
  }));

  const drift = snapshot ? compareStackNetworks(fromEffectiveModel(model), snapshot, stackName) : EMPTY_DRIFT;

  return { stack: stackName, renderable: true, renderError: null, runtime, networks, services, drift };
}

/** Render the effective model and snapshot the node, then assemble the facts. */
export async function buildStackNetworkFacts(nodeId: number, stackName: string): Promise<StackNetworkFacts> {
  const fsSvc = FileSystemService.getInstance(nodeId);

  let model: EffectiveModel | null = null;
  let renderError: string | null = null;
  try {
    const result = await ComposeService.getInstance(nodeId).renderConfig(stackName);
    if (result.rendered !== null) {
      try {
        model = parseEffectiveModel(JSON.parse(result.rendered), stackName);
      } catch (parseErr) {
        // JSON.parse errors carry no file content, so the message is safe to log.
        console.warn('[NetworkInspector] Effective model parse failed for %s:',
          sanitizeForLog(stackName), sanitizeForLog(getErrorMessage(parseErr, 'unknown')));
        renderError = 'Sencho could not parse the rendered Compose model.';
      }
    } else {
      // Raw stderr can echo file content/secrets and is never surfaced; only the
      // names of any missing required variables, otherwise a generic nudge.
      const missing = parseMissingRequiredVars(result.stderr);
      renderError = missing.length
        ? `Required variable${missing.length > 1 ? 's' : ''} ${missing.join(', ')} ${missing.length > 1 ? 'have' : 'has'} no value, so the effective model cannot be rendered.`
        : 'Sencho could not render the effective Compose model. Check the compose and env files for a YAML syntax error, an unresolved include or merge, or a required variable with no value.';
    }
  } catch (err) {
    // Spawn failure (docker unavailable). Redact defensively.
    renderError = redactSensitiveText(getErrorMessage(err, 'docker compose could not be started.')).slice(0, MAX_RENDER_ERROR).trim()
      || 'Sencho could not run docker compose on this node.';
  }

  // A null snapshot means the runtime is unavailable (drift is then left empty),
  // never confused with a real empty snapshot.
  let snapshot: DependencySnapshot | null = null;
  try {
    const knownStacks = await fsSvc.getStacks();
    snapshot = await DockerController.getInstance(nodeId).getDependencySnapshot(knownStacks);
  } catch (error) {
    console.warn('[NetworkInspector] Node snapshot unavailable for %s; runtime facts skipped:',
      sanitizeForLog(stackName), sanitizeForLog(getErrorMessage(error, 'unknown')));
  }

  return assembleStackNetworkFacts(stackName, model, renderError, snapshot);
}
