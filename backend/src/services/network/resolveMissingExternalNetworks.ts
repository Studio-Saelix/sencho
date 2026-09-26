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
   * Present when the model could not be rendered. When
   * `env_block_deploy_on_missing_required` is enabled and a required variable is
   * missing, contains the exact guardrail message naming the variable(s).
   * Otherwise contains a diagnostic that quotes Compose's own redacted stderr,
   * which also carries the timeout and output-cap reasons. Undefined when the
   * model rendered, including when the Docker runtime snapshot was unavailable.
   */
  renderError?: string;
}

const MAX_RENDER_ERROR = 600;

/** What to try when Compose's own words are unavailable or unhelpful. */
const RENDER_GUIDANCE =
  'Check the compose and env files for a YAML syntax error, an unresolved include or merge, or a required variable with no value.';

/**
 * Compose's own words for a render failure, redacted and bounded, on one line.
 *
 * The guess-list alone cannot name the fault: a malformed port spec, a bad
 * include path, or a conflicting mount all fail the render without matching any
 * of its three suggestions, so the operator is sent to check the wrong thing.
 * Compose already states the cause on stderr, so it is surfaced verbatim
 * instead. Collapsing whitespace keeps a multi-line diagnostic readable in a
 * toast, and `renderConfig` reports its timeout and output-cap outcomes on
 * stderr too, so those two reasons arrive here without a separate branch.
 */
function composeStderrDetail(stderr: string): string {
  return sanitizeForLog(redactSensitiveText(stderr)).replace(/\s+/g, ' ').trim().slice(0, MAX_RENDER_ERROR);
}

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
  } catch (error) {
    console.warn(
      '[MissingExternalNetworks] Failed to read guardrail setting for node %s:',
      nodeId,
      sanitizeForLog(getErrorMessage(error, 'unknown')),
    );
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
    const detail = composeStderrDetail(result.stderr);
    return {
      model: null,
      renderError: detail
        ? `Sencho could not render the effective Compose model: ${detail} ${RENDER_GUIDANCE}`
        : `Sencho could not render the effective Compose model. ${RENDER_GUIDANCE}`,
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
