/**
 * Shared exposure-context reader consumed by BOTH ComposeDoctorService (preflight
 * exposure rules) and the live networking findings engine, so their severities can
 * never diverge. Fail-soft via a discriminated result: a DB read failure is distinct
 * from a genuinely unset intent, so callers must not treat `available: false` as
 * "no intent" (that would fabricate false unclassified/mismatch findings).
 */
import { DatabaseService } from '../DatabaseService';
import { parseAccessUrlPorts } from './normalize';
import type { ExposureIntent } from './types';
import { getErrorMessage } from '../../utils/errors';
import { sanitizeForLog } from '../../utils/safeLog';

export type ExposureContext =
  | { available: false }
  | {
    available: true;
    stackIntent: ExposureIntent | null;
    serviceIntents: Record<string, ExposureIntent>;
    accessUrlPorts: Set<number>;
    hasAccessUrls: boolean;
  };

export function getExposureContext(nodeId: number, stackName: string): ExposureContext {
  try {
    const db = DatabaseService.getInstance();
    const rows = db.getStackExposureIntents(nodeId, stackName);
    const stackIntent = rows.find((r) => r.service === '')?.intent ?? null;
    const serviceIntents: Record<string, ExposureIntent> = {};
    for (const r of rows) if (r.service !== '') serviceIntents[r.service] = r.intent;

    const accessUrls = db.getStackDossier(nodeId, stackName)?.access_urls ?? '';
    return {
      available: true,
      stackIntent,
      serviceIntents,
      accessUrlPorts: parseAccessUrlPorts(accessUrls),
      hasAccessUrls: accessUrls.trim().length > 0,
    };
  } catch (error) {
    console.warn('[Networking] Exposure context unavailable for %s; exposure interpretation skipped:',
      sanitizeForLog(stackName), sanitizeForLog(getErrorMessage(error, 'unknown')));
    return { available: false };
  }
}
