/**
 * Rollback restore eligibility (fail closed on known-bad evidence).
 *
 * Pure evaluateRollbackEligibility maps known signals to a verdict.
 * assessGenerationEligibility gathers best-effort evidence for a recovery row.
 */
import type { StackUpdateRecoveryGenerationRow } from './DatabaseService';
import DockerController from './DockerController';
import { enforcePolicyForImageRefs } from './PolicyEnforcement';
import { RollbackGenerationStore } from './RollbackGenerationStore';
import { getErrorMessage } from '../utils/errors';
import { sanitizeForLog } from '../utils/safeLog';

type HeldImagesParse =
  | { ok: true; ids: string[]; rollbackTags: string[] }
  | { ok: false };

function parseHeldImageState(servicesJson: string): HeldImagesParse {
  try {
    const parsed: unknown = JSON.parse(servicesJson);
    if (!Array.isArray(parsed)) return { ok: false };
    const ids = new Set<string>();
    const tags = new Set<string>();
    for (const svc of parsed) {
      if (!svc || typeof svc !== 'object') continue;
      const replicas = (svc as { replicas?: unknown }).replicas;
      if (!Array.isArray(replicas)) continue;
      for (const replica of replicas) {
        if (!replica || typeof replica !== 'object') continue;
        const imageId = (replica as { imageId?: unknown }).imageId;
        if (typeof imageId === 'string' && imageId.trim()) ids.add(imageId);
        const rollbackTag = (replica as { rollbackTag?: unknown }).rollbackTag;
        if (typeof rollbackTag === 'string' && rollbackTag.trim()) tags.add(rollbackTag);
      }
    }
    return { ok: true, ids: [...ids], rollbackTags: [...tags] };
  } catch {
    return { ok: false };
  }
}

export type RollbackEligibilityVerdict =
  | 'eligible'
  | 'eligible_with_warning'
  | 'prohibited'
  | 'unknown';

export interface RollbackEligibilityInput {
  /** null = unknown */
  generationIntegrityOk: boolean | null;
  heldImagesPresent: boolean | null;
  /** true when known blocked; null = unknown */
  securityPostureBlocked: boolean | null;
}

/**
 * Rules (fail closed on known bad):
 * - securityPostureBlocked === true → prohibited
 * - generationIntegrityOk === false → prohibited
 * - heldImagesPresent === false → eligible_with_warning
 * - any remaining null → unknown (unless already prohibited)
 * - else eligible
 */
export function evaluateRollbackEligibility(
  input: RollbackEligibilityInput,
): RollbackEligibilityVerdict {
  if (input.securityPostureBlocked === true || input.generationIntegrityOk === false) {
    return 'prohibited';
  }
  if (input.heldImagesPresent === false) return 'eligible_with_warning';
  if (
    input.generationIntegrityOk === null
    || input.heldImagesPresent === null
    || input.securityPostureBlocked === null
  ) {
    return 'unknown';
  }
  return 'eligible';
}

async function checkGenerationIntegrity(
  row: StackUpdateRecoveryGenerationRow,
): Promise<boolean | null> {
  // Only explicit content_path generations use the content store.
  const contentKey = row.content_path;
  if (!contentKey) return null;
  try {
    return await RollbackGenerationStore.verifyGenerationContent(
      row.node_id,
      row.stack_name,
      contentKey,
    );
  } catch (error) {
    console.warn(
      '[RollbackEligibility] Integrity check failed for %s: %s',
      sanitizeForLog(row.id),
      sanitizeForLog(getErrorMessage(error, 'unknown')),
    );
    return null;
  }
}

async function checkHeldImagesPresent(
  row: StackUpdateRecoveryGenerationRow,
  held: HeldImagesParse,
): Promise<boolean | null> {
  if (!held.ok) return null;
  if (held.ids.length === 0) return true;
  try {
    const docker = DockerController.getInstance(row.node_id).getDocker();
    for (const imageId of held.ids) {
      try {
        await docker.getImage(imageId).inspect();
      } catch (error) {
        const status = (error as { statusCode?: number }).statusCode;
        const message = getErrorMessage(error, '').toLowerCase();
        if (status === 404 || message.includes('no such image') || message.includes('not found')) {
          return false;
        }
        throw error;
      }
    }
    return true;
  } catch (error) {
    console.warn(
      '[RollbackEligibility] Docker check failed for %s: %s',
      sanitizeForLog(row.id),
      sanitizeForLog(getErrorMessage(error, 'unknown')),
    );
    return null;
  }
}

async function checkSecurityPostureBlocked(
  row: StackUpdateRecoveryGenerationRow,
  held: HeldImagesParse,
): Promise<boolean | null> {
  if (!held.ok) return null;
  const refs = [...new Set([...held.rollbackTags, ...held.ids])];
  if (refs.length === 0) return false;
  try {
    const gate = await enforcePolicyForImageRefs(row.stack_name, row.node_id, refs, {
      bypass: false,
      actor: 'rollback-eligibility',
      auditMethod: 'GET',
      auditPath: '/api/stacks/rollback-eligibility',
    });
    return !gate.ok;
  } catch (error) {
    console.warn(
      '[RollbackEligibility] Security posture check failed for %s: %s',
      sanitizeForLog(row.id),
      sanitizeForLog(getErrorMessage(error, 'unknown')),
    );
    return null;
  }
}

/** Best-effort eligibility for a recovery generation row. */
export async function assessGenerationEligibility(
  row: StackUpdateRecoveryGenerationRow,
): Promise<RollbackEligibilityVerdict> {
  const held = parseHeldImageState(row.services_json);
  // Malformed recovery state cannot be assessed safely; refuse restore.
  if (!held.ok) return 'prohibited';
  const generationIntegrityOk = await checkGenerationIntegrity(row);
  const heldImagesPresent = await checkHeldImagesPresent(row, held);
  const securityPostureBlocked = await checkSecurityPostureBlocked(row, held);
  return evaluateRollbackEligibility({
    generationIntegrityOk,
    heldImagesPresent,
    securityPostureBlocked,
  });
}
