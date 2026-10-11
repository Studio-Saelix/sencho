import type { DriftImageAge, StackDriftReport, StackDriftFinding } from './DriftDetectionService';
import { sanitizeForLog } from '../utils/safeLog';
import { getErrorMessage } from '../utils/errors';

/** The slice of Docker this needs: inspect one image by reference or id. */
export interface ImageInspector {
  getImage(ref: string): { inspect(): Promise<{ Created?: string }> };
}

/** When an image was built, in epoch ms, or null when Docker cannot say. */
async function builtAt(docker: ImageInspector, ref: string): Promise<number | null> {
  try {
    const created = Date.parse((await docker.getImage(ref).inspect()).Created ?? '');
    return Number.isNaN(created) ? null : created;
  } catch (error) {
    // An image that is not in the local store is the ordinary reason, so only
    // anything else is worth a log line. Either way the answer is "unknown".
    if ((error as { statusCode?: number })?.statusCode !== 404) {
      console.warn('[Drift] Could not inspect image %s:', sanitizeForLog(ref), sanitizeForLog(getErrorMessage(error, 'inspect failed')));
    }
    return null;
  }
}

/**
 * Whether the image a service is running was built after the one compose now
 * names. Only a proven answer is returned: an image missing from the local
 * store, an unreadable build time, replicas that disagree, or two images built
 * at the same moment all read as `unknown`, never as a guess.
 */
export async function classifyImageAge(
  docker: ImageInspector,
  declared: string,
  running: readonly string[],
): Promise<DriftImageAge> {
  if (running.length === 0) return 'unknown';
  const [declaredAt, ...builtTimes] = await Promise.all([declared, ...running].map((ref) => builtAt(docker, ref)));
  const runningAt = builtTimes.filter((at): at is number => at !== null);
  if (declaredAt === null || runningAt.length !== builtTimes.length) return 'unknown';
  if (runningAt.every((at) => at > declaredAt)) return 'running-newer';
  if (runningAt.every((at) => at < declaredAt)) return 'running-older';
  return 'unknown';
}

/**
 * Adds the derived image age to every image-mismatch finding. The engine's own
 * comparison stays a pure string diff; this is the one extra read, and a
 * finding it cannot judge simply carries `unknown`.
 */
export async function annotateImageAge(docker: () => ImageInspector, report: StackDriftReport): Promise<StackDriftReport> {
  if (!report.findings.some((f) => f.kind === 'image-mismatch')) return report;
  const findings: StackDriftFinding[] = await Promise.all(report.findings.map(async (finding) => {
    if (finding.kind !== 'image-mismatch') return finding;
    return { ...finding, imageAge: await imageAgeOf(docker, finding) };
  }));
  return { ...report, findings };
}

/** The age of one image-mismatch finding; any failure to ask Docker reads as `unknown`, never as a failed drift report. */
async function imageAgeOf(docker: () => ImageInspector, finding: StackDriftFinding): Promise<DriftImageAge> {
  if (finding.expected === undefined || finding.actual === undefined) return 'unknown';
  try {
    return await classifyImageAge(docker(), finding.expected, finding.actual.split(', '));
  } catch (error) {
    console.warn('[Drift] Could not read image age for %s:', sanitizeForLog(finding.service), sanitizeForLog(getErrorMessage(error, 'unknown')));
    return 'unknown';
  }
}
