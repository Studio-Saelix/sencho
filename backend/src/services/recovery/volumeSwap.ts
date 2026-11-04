import { errorMessageForLog, sanitizeForLog } from '../../utils/safeLog';
import { RecoveryError } from './redaction';
import { RECOVERY_WORK_DIR_PREFIX } from './restoreIntents';
import type { RecoveryHelperRunner } from './restic/helperRunner';
import { RECOVERY_HELPER_PROBE_PATH } from './restic/helperImage';
import { helperFailureNote } from './restic/resticOutput';

/**
 * The typed wrapper over the helper probe's `swap` subcommands.
 *
 * The helper is the only thing that moves entries in the live volume. This
 * module runs it, parses its one JSON line, and answers a status; it never
 * decides what to do with that status. The reconciler and the operation runner
 * own the decisions, so the same answer from a crash resume and from a live run
 * takes the same branch.
 */

export const SWAP_ACTIONS = ['prepare', 'commit', 'status', 'rollback', 'cleanup'] as const;
export type SwapAction = (typeof SWAP_ACTIONS)[number];

export type SwapStatus =
  | 'absent'
  | 'planned'
  | 'moving_originals'
  | 'moving_incoming'
  | 'swapped'
  // Every entry moved but the journal does not record the commit yet, so the root
  // metadata is not proven. Only a completed `commit` may answer `swapped`.
  | 'metadata_pending'
  | 'rolled_back'
  | 'cleaned'
  | 'inconsistent';

const SWAP_STATUSES: ReadonlySet<string> = new Set<SwapStatus>([
  'absent', 'planned', 'moving_originals', 'moving_incoming', 'swapped', 'metadata_pending',
  'rolled_back', 'cleaned', 'inconsistent',
]);

export interface SwapReport {
  status: SwapStatus;
  originals: string[];
  incoming: string[];
  moved: number;
}

/** The work directory, relative to the volume root, for one intent. */
export function swapWorkDir(intentId: string): string {
  return `${RECOVERY_WORK_DIR_PREFIX}${intentId}`;
}

/** The path a staged restore materializes into, relative to the volume root. */
export function swapIncomingDir(intentId: string): string {
  return `${swapWorkDir(intentId)}/incoming`;
}

/** True when a status means no entry can have moved yet. */
export function swapHasMoved(status: SwapStatus): boolean {
  return status === 'moving_originals' || status === 'moving_incoming'
    || status === 'swapped' || status === 'metadata_pending';
}

export function parseSwapReport(line: string): SwapReport | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== 'object') return null;
    const record = parsed as Record<string, unknown>;
    if (typeof record.status !== 'string' || !SWAP_STATUSES.has(record.status)) return null;
    return {
      status: record.status as SwapStatus,
      originals: stringArray(record.originals),
      incoming: stringArray(record.incoming),
      moved: typeof record.moved === 'number' && Number.isSafeInteger(record.moved) ? record.moved : 0,
    };
  } catch {
    return null;
  }
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

/**
 * The probe reports a refusal as `{"error": ...}` on stdout, with nothing on
 * stderr, so the log reads it from the same first line the status comes from.
 */
function reportedError(line: string | undefined): string[] {
  const trimmed = (line ?? '').trim();
  if (!trimmed.startsWith('{')) return [];
  try {
    const parsed: unknown = JSON.parse(trimmed);
    const message = parsed && typeof parsed === 'object' ? (parsed as { error?: unknown }).error : undefined;
    return typeof message === 'string' ? [message] : [];
  } catch {
    return [];
  }
}

export interface SwapRunResult {
  /** True when the helper exited 0 and answered a status. */
  ok: boolean;
  /** The status the helper reported, when it reported one. */
  report: SwapReport | null;
  /** Why the helper did not answer, when it did not. */
  errorClass: 'interrupted' | 'node_error' | 'capability_unavailable' | null;
}

/**
 * One swap step against one volume. A non-zero exit is not thrown: it is an
 * answer (`ok: false`) with whatever status the helper managed to print, because
 * the caller's next step is `swap status`, not an HTTP error.
 */
export async function runSwapStep(input: {
  runner: RecoveryHelperRunner;
  operationId: string;
  volumeName: string;
  intentId: string;
  action: SwapAction;
  signal?: AbortSignal;
}): Promise<SwapRunResult> {
  const lines: string[] = [];
  let result;
  try {
    result = await input.runner.run({
      profile: 'swap',
      operationId: input.operationId,
      cmd: [
        RECOVERY_HELPER_PROBE_PATH,
        'swap',
        input.action,
        '--root',
        '/restore',
        '--id',
        input.intentId,
      ],
      mounts: { target: input.volumeName },
      signal: input.signal,
      onStdoutLine: (line) => {
        if (lines.length === 0) lines.push(line);
      },
    });
  } catch (err) {
    // A missing image or a daemon refusal is the node's capability, not a
    // refusal of this swap. A helper that started and died answers below.
    if (err instanceof RecoveryError) {
      return { ok: false, report: null, errorClass: 'capability_unavailable' };
    }
    console.warn('[Recovery] Swap helper could not run:', errorMessageForLog(err));
    return { ok: false, report: null, errorClass: 'node_error' };
  }
  const report = parseSwapReport(lines[0] ?? '');
  if (result.aborted) return { ok: false, report, errorClass: 'interrupted' };
  if (result.killed) {
    console.warn('[Recovery] Swap helper for %s was killed', sanitizeForLog(input.intentId));
    return { ok: false, report, errorClass: 'node_error' };
  }
  if (result.exitCode !== 0) {
    console.warn(
      '[Recovery] Swap helper %s for %s exited %d: %s',
      input.action,
      sanitizeForLog(input.intentId),
      result.exitCode,
      helperFailureNote(result.stderrTail ?? '', reportedError(lines[0])),
    );
    return { ok: false, report, errorClass: null };
  }
  if (!report) {
    console.warn('[Recovery] Swap helper for %s exited 0 without a status', sanitizeForLog(input.intentId));
    return { ok: false, report: null, errorClass: 'node_error' };
  }
  return { ok: true, report, errorClass: null };
}
