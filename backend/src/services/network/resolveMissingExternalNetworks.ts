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
  /**
   * Present when the model could not be rendered due to a missing required variable or
   * another compose-config failure. When `env_block_deploy_on_missing_required` is enabled,
   * contains the exact guardrail message naming the missing variable(s). Otherwise
   * contains a neutral diagnostic. Undefined when the model rendered successfully or
   * when the render error was a Docker spawn/timeout failure.
   */
  renderError?: string;
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

function isGuardrailEnabled(nodeId: number): boolean {
  try {
    return (
      DatabaseService.getInstance().getGlobalSettings()['env_block_deploy_on_missing_required'] === '1'
    );
  } catch {
    return false;
  }
}

async function renderModel(
  nodeId: number,
  stackName: string,
  guardrailEnabled: boolean,
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
    if (missing.length > 0) {
      if (guardrailEnabled) {
        const plural = missing.length > 1;
        return {
          model: null,
          renderError: `Deploy blocked: required environment variable${plural ? 's' : ''} ${missing.join(', ')} ` +
            `${plural ? 'are' : 'is'} missing. Define ${plural ? 'them' : 'it'} in a .env or env_file, then deploy again.`,
        };
      }
      return {
        model: null,
        renderError: `Required variable${missing.length > 1 ? 's' : ''} ${missing.join(', ')} ${missing.length > 1 ? 'have' : 'has'} no value, so the effective model cannot be rendered.`,
      };
    }
    return {
      model: null,
      renderError: 'Sencho could not render the effective Compose model. Check the compose and env files for a YAML syntax error, an unresolved include or merge, or a required variable with no value.',
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
  const guardrailEnabled = isGuardrailEnabled(nodeId);
  const { model, renderError } = await renderModel(nodeId, stackName, guardrailEnabled);
  if (!model) {
    return {
      status: 'render_unavailable',
      autoCreateEnabled,
      stackName,
      networks: [],
      declaredExternalCount: 0,
      renderError: renderError ?? undefined,
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
