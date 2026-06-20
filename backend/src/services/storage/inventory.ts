/**
 * Storage Inventory: renders a stack's effective Compose model, probes each
 * within-stack bind source, and classifies the stack's storage portability.
 * Advisory and read-only; it never mutates a path, reads mount content, or
 * returns raw docker stderr or any environment value. Node-scoped: it runs on
 * whichever node owns the stack (the route auto-proxies there).
 */
import path from 'path';

import { ComposeService } from '../ComposeService';
import { FileSystemService } from '../FileSystemService';
import { parseEffectiveModel, type EffectiveModel } from '../preflight/effectiveModel';
import { parseMissingRequiredVars } from '../../helpers/envVarParse';
import { probeHostPath } from './probeHostPath';
import { isDockerSocketMount } from './types';
import type { HostPathProbe, PortabilityVerdict, StorageInventory, StorageMount } from './types';

import { getErrorMessage } from '../../utils/errors';
import { redactSensitiveText, sanitizeForLog } from '../../utils/safeLog';

const MAX_RENDER_ERROR = 600;

const UNRENDERABLE_REASON =
  'Sencho could not render the effective Compose model, so storage portability cannot be determined.';

/** Flatten the model into per-service mounts, attaching each bind's probe and external-named status. */
export function buildMounts(model: EffectiveModel, probes: Map<string, HostPathProbe>): StorageMount[] {
  const mounts: StorageMount[] = [];
  for (const svc of model.services) {
    for (const m of svc.storageMounts ?? []) {
      const probe = m.type === 'bind' && m.source ? (probes.get(m.source) ?? null) : null;
      const externalNamed = m.type === 'named' && m.source ? (model.volumes[m.source]?.external ?? false) : false;
      mounts.push({ ...m, service: svc.name, probe, externalNamed });
    }
  }
  return mounts;
}

/** A bind is node-bound when its source resolves outside the stack dir, escapes via a symlink, or is unverified. */
function isExternalBind(m: StorageMount): boolean {
  if (m.type !== 'bind') return false;
  if (!m.probe) return true;
  return m.probe.escapes || !m.probe.withinStackDir;
}

/**
 * A stack carries node-local state when it has any data-bearing mount: a bind
 * (other than the Docker socket, which holds no application data), or a named or
 * anonymous volume. tmpfs is ephemeral and never counts.
 */
function isStateful(mounts: StorageMount[]): boolean {
  return mounts.some(m =>
    (m.type === 'bind' && !isDockerSocketMount(m)) || m.type === 'named' || m.type === 'anonymous');
}

/**
 * Deterministic portability verdict. Status is the single highest verdict
 * (node-bound > partially-portable > portable > unknown); `reasons` accumulates
 * every contributing factor so the UI can show the full picture.
 */
export function classifyPortability(mounts: StorageMount[], renderable: boolean): PortabilityVerdict {
  if (!renderable) return { status: 'unknown', reasons: [UNRENDERABLE_REASON] };

  const reasons: string[] = [];
  const socketMounts = mounts.filter(isDockerSocketMount);
  // A socket bind is node-bound, but it is reported via its own reason, so it is
  // excluded here to avoid a duplicate reason for the one mount.
  const externalBinds = mounts.filter(m => isExternalBind(m) && !isDockerSocketMount(m));
  const withinStackBinds = mounts.filter(m => m.type === 'bind' && !isExternalBind(m));
  const dataVolumes = mounts.filter(m => m.type === 'named' || m.type === 'anonymous');

  for (const s of socketMounts) {
    reasons.push(`Service "${s.service}" mounts the Docker socket, tying the stack to this host's Docker engine.`);
  }
  for (const b of externalBinds) {
    reasons.push(b.probe?.escapes
      ? `"${b.source}" in service "${b.service}" is a symlink to a path outside the stack directory.`
      : `Service "${b.service}" binds "${b.source}", a host path outside the stack directory that must exist on every node you move this stack to.`);
  }

  if (socketMounts.length > 0 || externalBinds.length > 0) {
    return { status: 'node-bound', reasons };
  }

  if (dataVolumes.length > 0) {
    for (const v of dataVolumes) {
      const which = v.type === 'anonymous' ? 'an anonymous volume' : `named volume "${v.source}"`;
      reasons.push(v.externalNamed
        ? `Service "${v.service}" uses ${which}, which expects a pre-existing volume on the node; its data does not move with the files.`
        : `Service "${v.service}" uses ${which}; its data lives on this node and is not carried by moving the files.`);
    }
    if (withinStackBinds.length > 0) {
      reasons.push('Bind mounts inside the stack directory move with the stack files.');
    }
    return { status: 'partially-portable', reasons };
  }

  reasons.push(withinStackBinds.length > 0
    ? 'All mounts are bind paths inside the stack directory, so they move with the stack files.'
    : 'This stack declares no persistent storage, so nothing is tied to this node.');
  return { status: 'portable', reasons };
}

/** Pure assembler: turns a rendered model + probe map into the inventory payload. */
export function assembleStorageInventory(
  stackName: string,
  model: EffectiveModel | null,
  renderError: string | null,
  probes: Map<string, HostPathProbe>,
): StorageInventory {
  if (!model) {
    return {
      stack: stackName, renderable: false, renderError, stateful: false, mounts: [],
      portability: classifyPortability([], false),
    };
  }
  const mounts = buildMounts(model, probes);
  return {
    stack: stackName,
    renderable: true,
    renderError: null,
    stateful: isStateful(mounts),
    mounts,
    portability: classifyPortability(mounts, true),
  };
}

/** Probe each unique bind source once. */
async function probeBindSources(model: EffectiveModel, stackDir: string): Promise<Map<string, HostPathProbe>> {
  const sources = new Set<string>();
  for (const svc of model.services) {
    for (const m of svc.storageMounts ?? []) {
      if (m.type === 'bind' && m.source) sources.add(m.source);
    }
  }
  const probes = new Map<string, HostPathProbe>();
  for (const source of sources) probes.set(source, await probeHostPath(source, stackDir));
  return probes;
}

/** Render the model on the owning node, probe its binds, and assemble the inventory. */
export async function buildStorageInventory(nodeId: number, stackName: string): Promise<StorageInventory> {
  const stackDir = path.join(FileSystemService.getInstance(nodeId).getBaseDir(), stackName);

  let model: EffectiveModel | null = null;
  let renderError: string | null = null;
  try {
    const result = await ComposeService.getInstance(nodeId).renderConfig(stackName);
    if (result.rendered !== null) {
      try {
        model = parseEffectiveModel(JSON.parse(result.rendered), stackName);
      } catch (parseErr) {
        // JSON.parse errors carry no file content, so the message is safe to log.
        console.warn('[StorageInventory] Effective model parse failed for %s:',
          sanitizeForLog(stackName), sanitizeForLog(getErrorMessage(parseErr, 'unknown')));
        renderError = 'Sencho could not parse the rendered Compose model.';
      }
    } else if (result.timedOut) {
      // A timeout is a Sencho-generated condition, not a Compose error; name it so
      // the operator does not hunt for a syntax error that is not there.
      renderError = 'Rendering the effective Compose model timed out on this node.';
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

  const probes = model ? await probeBindSources(model, stackDir) : new Map<string, HostPathProbe>();
  return assembleStorageInventory(stackName, model, renderError, probes);
}
