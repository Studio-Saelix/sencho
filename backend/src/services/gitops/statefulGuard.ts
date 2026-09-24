/**
 * Stateful-withdrawal guard for automated GitOps acceptance.
 *
 * The automated acceptance paths (the source controller's poll acceptance and
 * the webhook auto-apply for automatic policies) have no human in the loop, so
 * before a staged candidate is accepted they must prove it does not withdraw
 * or rename a stateful service relative to the generation in force. A service
 * whose name leaves the stateful set (removed, renamed, or stripped of its
 * volumes) is a withdrawal: applying it can destroy or orphan the data that
 * service owned.
 *
 * The check reads managed evidence only: the candidate's staged compose files
 * and the applied copy (falling back to the staged copy) of the generation in
 * force. Unreadable evidence is a hold, never an acceptance, and callers
 * record the hold as a review block so the projection names the block instead
 * of reading as an unexplained review.
 *
 * With no accepted generation there is no managed baseline to compare
 * against, so the check passes: the first acceptance defines the baseline, and
 * protecting it is the operator's choice of source policy or of accepting
 * under review.
 */
import * as fs from 'fs';
import * as path from 'path';
import { BlueprintAnalyzer } from '../BlueprintAnalyzer';
import { gitSourceLocalComposeFiles } from '../../utils/gitComposeFiles';
import { loadDotEnv } from '../ImageUpdateService';
import { sanitizeForLog } from '../../utils/safeLog';
import { stackManagedRoot } from './directApplication';
import { GitOpsStore } from './store';
import { GitOpsTransitions, type EventEnvelope } from './transitions';
import type { GitOpsApplicationRow, GitOpsGenerationRow } from './types';

export type StatefulWithdrawalCheck =
  | { status: 'clear' }
  | { status: 'withdrawn'; services: string[] }
  | { status: 'unreadable'; reason: string };

/**
 * Read a generation's staged compose files off disk: the paths come from the
 * application row, mapped the same way staging laid them out, with the
 * generation's staged .env merged under process.env exactly as the update
 * scanner resolves them. Returns null when the evidence cannot be read
 * (missing staging directory, unreadable compose file, a .env that exists but
 * cannot be read; an absent .env is normal and interpolates compose-only):
 * callers then hold rather than proceed on missing evidence.
 */
export function readStagedGeneration(
    stackName: string,
    app: GitOpsApplicationRow,
    generation: GitOpsGenerationRow,
): { contents: string[]; mergedEnv: Record<string, string> } | null {
    try {
        const candidateDir = path.join(stackManagedRoot(stackName), generation.candidate_dir);
        const composePaths = parseComposePaths(app);
        if (composePaths === null || composePaths.length === 0) return null;
        const contents: string[] = [];
        for (const local of gitSourceLocalComposeFiles(composePaths)) {
            contents.push(fs.readFileSync(path.join(candidateDir, local), 'utf8'));
        }
        const envVars = readStagedEnv(candidateDir, stackName, generation.id);
        if (envVars === null) return null;
        const merged: Record<string, string> = { ...envVars };
        for (const [k, v] of Object.entries(process.env)) {
            if (v !== undefined) merged[k] = v;
        }
        return { contents, mergedEnv: merged };
    } catch (e) {
        console.warn(
            `[GitOps] staged candidate unreadable for ${sanitizeForLog(stackName)} (generation ${sanitizeForLog(generation.id)}):`,
            e instanceof Error ? e.message : String(e),
        );
        return null;
    }
}

/**
 * The staged .env, or null when a present-but-unreadable one must hold the
 * caller. A missing .env is normal (the staging step only writes one when
 * sync_env produced it), but a present-yet-unreadable one would silently
 * narrow the interpolation inputs, so it is surfaced rather than skipped.
 */
function readStagedEnv(
    candidateDir: string,
    stackName: string,
    generationId: string,
): Record<string, string> | null {
    try {
        return loadDotEnv(fs.readFileSync(path.join(candidateDir, '.env'), 'utf8'));
    } catch (e) {
        const missing = (e as NodeJS.ErrnoException).code === 'ENOENT';
        if (missing) return {};
        console.warn(
            `[GitOps] staged .env unreadable for ${sanitizeForLog(stackName)} (generation ${sanitizeForLog(generationId)}); holding candidate:`,
            e instanceof Error ? e.message : String(e),
        );
        return null;
    }
}

/**
 * Stateful services the candidate would withdraw or rename relative to the
 * generation in force. `clear` also covers "nothing stateful ran before";
 * `unreadable` means the comparison could not be made from evidence, and the
 * caller must hold rather than accept.
 */
export function checkStatefulWithdrawal(
    stackName: string,
    app: GitOpsApplicationRow,
    generation: GitOpsGenerationRow,
): StatefulWithdrawalCheck {
    const staged = readStagedGeneration(stackName, app, generation);
    if (!staged) {
        return { status: 'unreadable', reason: 'the staged candidate could not be read' };
    }
    const next = statefulNamesAcrossFiles(staged.contents);
    if (next === null) {
        return { status: 'unreadable', reason: 'the staged candidate compose does not parse' };
    }
    if (!app.accepted_generation_id) return { status: 'clear' };
    const previous = GitOpsStore.getInstance().getGeneration(app.accepted_generation_id);
    if (!previous || previous.application_id !== app.id) {
        return { status: 'unreadable', reason: 'the generation in force is missing or belongs to another application' };
    }
    const previousContents = readAppliedGenerationContents(stackName, app, previous);
    if (previousContents === null) {
        return { status: 'unreadable', reason: 'the generation in force could not be read' };
    }
    const previousNames = statefulNamesAcrossFiles(previousContents.contents);
    if (previousNames === null) {
        return { status: 'unreadable', reason: 'the generation in force compose does not parse' };
    }
    const withdrawn = [...previousNames].filter((name) => !next.has(name));
    return withdrawn.length > 0 ? { status: 'withdrawn', services: withdrawn } : { status: 'clear' };
}

/**
 * Record that the automatic path refused a candidate for safety. The candidate
 * stays staged for review; the write is what lets the projection name the
 * block. A failed write is logged, not thrown (the hold itself already
 * stands), and reported back so the caller can say the reason was not
 * recorded instead of implying the attention queue will show it.
 */
export function holdForStatefulReview(
    app: GitOpsApplicationRow,
    generation: GitOpsGenerationRow,
    envelope: EventEnvelope,
): boolean {
    try {
        GitOpsTransitions.getInstance().sourceReviewBlocked({
            applicationId: app.id,
            generationId: generation.id,
            reason: 'stateful_withdrawal',
            envelope,
        });
        return true;
    } catch (e) {
        console.warn(
            `[GitOps] stateful review block not recorded for ${sanitizeForLog(app.id)}:`,
            e instanceof Error ? e.message : String(e),
        );
        return false;
    }
}

/**
 * Read the compose content of the generation in force: the applied copy (what
 * was promoted) first, falling back to the staged candidate copy (accepted but
 * not yet promoted). Reports the first readable copy, or a reason when neither
 * is readable.
 */
function readAppliedGenerationContents(
    stackName: string,
    app: GitOpsApplicationRow,
    generation: GitOpsGenerationRow,
): { contents: string[] } | null {
    const dirs = [generation.applied_dir, generation.candidate_dir].filter((dir) => dir.trim() !== '');
    const failures: string[] = [];
    for (const dir of dirs) {
        const read = readComposeContents(path.join(stackManagedRoot(stackName), dir), app);
        if (read.ok) return { contents: read.contents };
        failures.push(`${dir}: ${read.error}`);
    }
    console.warn(
        `[GitOps] generation-in-force content unreadable for ${sanitizeForLog(stackName)} (generation ${sanitizeForLog(generation.id)}): ${failures.map((failure) => sanitizeForLog(failure)).join('; ')}`,
    );
    return null;
}

type ComposeContentsRead =
    | { ok: true; contents: string[] }
    | { ok: false; error: string };

function readComposeContents(dir: string, app: GitOpsApplicationRow): ComposeContentsRead {
    try {
        const composePaths = parseComposePaths(app);
        if (composePaths === null) return { ok: false, error: 'the compose path list is not valid json' };
        if (composePaths.length === 0) return { ok: false, error: 'the application has no compose paths' };
        const contents: string[] = [];
        for (const local of gitSourceLocalComposeFiles(composePaths)) {
            contents.push(fs.readFileSync(path.join(dir, local), 'utf8'));
        }
        return { ok: true, contents };
    } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
}

function parseComposePaths(app: GitOpsApplicationRow): string[] | null {
    if (!app.compose_paths_json) return [];
    try {
        return JSON.parse(app.compose_paths_json) as string[];
    } catch {
        return null;
    }
}

/** Names of services with a named volume or bind mount, across all files. Null when a file does not parse. */
function statefulNamesAcrossFiles(contents: string[]): Set<string> | null {
    const names = new Set<string>();
    for (const content of contents) {
        const parsed = BlueprintAnalyzer.statefulServiceNames(content);
        if (parsed === null) return null;
        for (const name of parsed) names.add(name);
    }
    return names;
}
