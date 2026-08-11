/**
 * Rollback restore eligibility (fail closed on known-bad evidence).
 *
 * Pure evaluateRollbackEligibility maps known signals to a verdict.
 * assessGenerationEligibility gathers best-effort evidence for a recovery row.
 */
import type { StackUpdateRecoveryGenerationRow } from './DatabaseService';
import DockerController from './DockerController';
import { RollbackGenerationStore } from './RollbackGenerationStore';
import { getErrorMessage } from '../utils/errors';
import { sanitizeForLog } from '../utils/safeLog';

function collectHeldImageIds(servicesJson: string): string[] {
  try {
    const parsed: unknown = JSON.parse(servicesJson);
    if (!Array.isArray(parsed)) return [];
    const ids = new Set<string>();
    for (const svc of parsed) {
      if (!svc || typeof svc !== 'object') continue;
      const replicas = (svc as { replicas?: unknown }).replicas;
      if (!Array.isArray(replicas)) continue;
      for (const replica of replicas) {
        if (!replica || typeof replica !== 'object') continue;
        const imageId = (replica as { imageId?: unknown }).imageId;
        if (typeof imageId === 'string' && imageId.trim()) ids.add(imageId);
      }
    }
    return [...ids];
  } catch {
    return [];
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
): Promise<boolean | null> {
  const ids = collectHeldImageIds(row.services_json);
  if (ids.length === 0) return true;
  try {
    const docker = DockerController.getInstance(row.node_id).getDocker();
    for (const imageId of ids) {
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

/** Best-effort eligibility for a recovery generation row. */
export async function assessGenerationEligibility(
  row: StackUpdateRecoveryGenerationRow,
): Promise<RollbackEligibilityVerdict> {
  const generationIntegrityOk = await checkGenerationIntegrity(row);
  const heldImagesPresent = await checkHeldImagesPresent(row);
  // Security posture hook reserved for later quarantine/signature work.
  const securityPostureBlocked: boolean | null = null;
  return evaluateRollbackEligibility({
    generationIntegrityOk,
    heldImagesPresent,
    securityPostureBlocked,
  });
}
