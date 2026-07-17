/**
 * Async resolver for missing external networks (deploy + GET only).
 * Doctor and Networking facts use the pure classifier with existing I/O.
 */

import DockerController from '../DockerController';
import { ComposeService } from '../ComposeService';
import { DatabaseService } from '../DatabaseService';
import { FileSystemService } from '../FileSystemService';
import { parseEffectiveModel, type EffectiveModel } from '../preflight/effectiveModel';
import { parseMissingRequiredVars } from '../../helpers/envVarParse';
import { getErrorMessage } from '../../utils/errors';
import { redactSensitiveText, sanitizeForLog } from '../../utils/safeLog';
import {
  classifyMissingExternalNetworks,
  type MissingExternalNetwork,
} from './missingExternalNetworks';

export type MissingExternalNetworksStatus = 'ok' | 'render_unavailable' | 'runtime_unavailable';

export interface MissingExternalNetworksEnvelope {
  status: MissingExternalNetworksStatus;
  autoCreateEnabled: boolean;
  stackName: string;
  networks: MissingExternalNetwork[];
  /** Count of external network declarations when the model rendered; 0 otherwise. */
  declaredExternalCount: number;
}

const MAX_RENDER_ERROR = 600;

function isAutoCreateEnabled(nodeId: number): boolean {
  try {
    return DatabaseService.getInstance().getGlobalSettings()['auto_create_missing_external_networks'] === '1';
  } catch (error) {
    console.warn(
      '[MissingExternalNetworks] Failed to read auto-create setting for node %s:',
      nodeId,
      sanitizeForLog(getErrorMessage(error, 'unknown')),
    );
    return false;
  }
}

async function renderModel(
  nodeId: number,
  stackName: string,
): Promise<{ model: EffectiveModel | null; renderError: string | null }> {
  try {
    const result = await ComposeService.getInstance(nodeId).renderConfig(stackName);
    if (result.rendered !== null) {
      try {
        return { model: parseEffectiveModel(JSON.parse(result.rendered), stackName), renderError: null };
      } catch (parseErr) {
        console.warn(
          '[MissingExternalNetworks] Effective model parse failed for %s:',
          sanitizeForLog(stackName),
          sanitizeForLog(getErrorMessage(parseErr, 'unknown')),
        );
        return { model: null, renderError: 'Sencho could not parse the rendered Compose model.' };
      }
    }
    const missing = parseMissingRequiredVars(result.stderr);
    return {
      model: null,
      renderError: missing.length
        ? `Required variable${missing.length > 1 ? 's' : ''} ${missing.join(', ')} ${missing.length > 1 ? 'have' : 'has'} no value, so the effective model cannot be rendered.`
        : 'Sencho could not render the effective Compose model. Check the compose and env files for a YAML syntax error, an unresolved include or merge, or a required variable with no value.',
    };
  } catch (err) {
    const msg = redactSensitiveText(getErrorMessage(err, 'docker compose could not be started.'))
      .slice(0, MAX_RENDER_ERROR)
      .trim()
      || 'Sencho could not run docker compose on this node.';
    return { model: null, renderError: msg };
  }
}

export async function resolveMissingExternalNetworks(
  nodeId: number,
  stackName: string,
): Promise<MissingExternalNetworksEnvelope> {
  const autoCreateEnabled = isAutoCreateEnabled(nodeId);
  const { model } = await renderModel(nodeId, stackName);
  if (!model) {
    return {
      status: 'render_unavailable',
      autoCreateEnabled,
      stackName,
      networks: [],
      declaredExternalCount: 0,
    };
  }

  const declaredExternalCount = Object.values(model.networks).filter((n) => n.external).length;

  let existingNames: Set<string>;
  try {
    const knownStacks = await FileSystemService.getInstance(nodeId).getStacks();
    const snapshot = await DockerController.getInstance(nodeId).getDependencySnapshot(knownStacks);
    existingNames = new Set(snapshot.networks.map((n) => n.name));
  } catch (error) {
    console.warn(
      '[MissingExternalNetworks] Runtime snapshot unavailable for %s:',
      sanitizeForLog(stackName),
      sanitizeForLog(getErrorMessage(error, 'unknown')),
    );
    return {
      status: 'runtime_unavailable',
      autoCreateEnabled,
      stackName,
      networks: [],
      declaredExternalCount,
    };
  }

  return {
    status: 'ok',
    autoCreateEnabled,
    stackName,
    networks: classifyMissingExternalNetworks(model, existingNames),
    declaredExternalCount,
  };
}
