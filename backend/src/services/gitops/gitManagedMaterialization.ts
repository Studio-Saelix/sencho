/**
 * Git-managed Blueprint materialization and artifact freeze.
 *
 * A converted source keeps polling, so a new commit arrives as a staged
 * candidate generation on the Blueprint application. The Direct pipeline is
 * refused for a claimed source, which means nothing promotes the candidate into
 * its applied directory and nothing resolves the accepted generation's artifact
 * set. Both are required before the rollout can be authorized: the dispatch
 * reads the applied materialization, and the authorization preflight refuses an
 * unresolved artifact set.
 *
 * This module owns the hub-side half: promote the accepted generation's
 * candidate to its applied directory (no writes to the live source stack, which
 * the rollout itself overwrites target by target), then resolve the artifact set
 * from that materialization's compose text through the shared approved-content
 * parser. Both operations are idempotent so the reconciler's retry path can
 * re-run them after a transient registry failure.
 */
import { promises as fsPromises } from 'fs';
import path from 'path';
import { GitOpsStore } from './store';
import { GitOpsApplicationRow, GitOpsGenerationRow } from './types';
import { stackManagedRoot } from './directApplication';
import { resolveAndRecordArtifactSet } from './artifactResolve';
import { parseApprovedServiceSpecs } from './approvedServiceSpecs';
import { envelopeFor } from './blueprintProducers';
import { GitOpsTransitions } from './transitions';
import { validateCandidateRelPath } from './createStagingMarker';
import { CANDIDATE_COMPLETE_MARKER, GENERATIONS_DIR } from '../GitProjectManifestService';
import { DatabaseService } from '../DatabaseService';
import { NodeRegistry } from '../NodeRegistry';
import { sanitizeForLog } from '../../utils/safeLog';

export type GitManagedMaterializeOutcome =
  | { status: 'materialized'; composeContent: string }
  | { status: 'already_materialized'; composeContent: string }
  | { status: 'missing'; reason: string };

export type GitManagedFreezeStatus = 'resolved' | 'none' | 'refused';

export interface GitManagedFreezeResult {
  status: GitManagedFreezeStatus;
  /** The refusal or failure that explains a non-resolved outcome, for the operator-facing note. */
  reason: string | null;
}

/**
 * Read the compose the accepted generation's applied materialization holds.
 *
 * Shared with the rollout dispatch so the freeze and the deploy can never read
 * two different files for one generation.
 */
export async function readAppliedComposeContent(
  app: GitOpsApplicationRow,
  genRow: GitOpsGenerationRow,
): Promise<string> {
  const stackName = app.configured_source_stack_name;
  if (!stackName) {
    throw new Error('Bound application has no retained source stack identity');
  }
  if (!genRow.applied_dir || genRow.applied_dir.trim() === '') {
    throw new Error('accepted generation has no applied materialization directory');
  }
  const managedRoot = stackManagedRoot(stackName);
  const appliedAbs = path.resolve(managedRoot, genRow.applied_dir);
  if (!appliedAbs.startsWith(managedRoot + path.sep)) {
    throw new Error('applied materialization path escapes the managed root');
  }
  const composePath = path.resolve(appliedAbs, 'compose.yaml');
  if (!composePath.startsWith(appliedAbs + path.sep)) {
    throw new Error('compose path escapes the applied materialization directory');
  }
  try {
    return await fsPromises.readFile(composePath, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      throw new Error('accepted generation materialization is missing compose.yaml', { cause: err });
    }
    throw err;
  }
}

/**
 * Promote the accepted generation's staged candidate into its applied
 * directory, the hub-side half of the promotion the Direct pipeline runs when it
 * writes a node's stack files.
 *
 * Refuses anything that is not the live accepted generation of a Blueprint
 * target, requires the candidate's completeness marker (a partial build is never
 * promoted), and adopts an applied directory that already exists. The rename is
 * atomic, so a concurrent materialization either wins or is adopted here rather
 * than leaving a half-copied directory.
 */
export async function materializeAcceptedGeneration(
  applicationId: string,
  generationId: string,
): Promise<GitManagedMaterializeOutcome> {
  const store = GitOpsStore.getInstance();
  const app = store.getApplication(applicationId);
  if (!app) return { status: 'missing', reason: 'the application could not be read' };
  if (app.target_mode !== 'blueprint') {
    return { status: 'missing', reason: 'the application is not a Blueprint target' };
  }
  if (app.accepted_generation_id !== generationId) {
    return { status: 'missing', reason: 'the generation is not the accepted one' };
  }
  const genRow = store.getGeneration(generationId);
  if (!genRow || genRow.application_id !== applicationId) {
    return { status: 'missing', reason: 'the generation could not be read' };
  }
  const stackName = app.configured_source_stack_name;
  if (!stackName) {
    return { status: 'missing', reason: 'the application has no retained source stack identity' };
  }

  const managedRoot = stackManagedRoot(stackName);
  const candidateProblem = validateCandidateRelPath(genRow.candidate_dir, managedRoot);
  if (candidateProblem) return { status: 'missing', reason: candidateProblem };
  const appliedProblem = validateAppliedRelPath(genRow.applied_dir, managedRoot);
  if (appliedProblem) return { status: 'missing', reason: appliedProblem };
  const candidateAbs = path.resolve(managedRoot, genRow.candidate_dir);
  const appliedAbs = path.resolve(managedRoot, genRow.applied_dir);

  if (await composeExists(appliedAbs)) {
    return { status: 'already_materialized', composeContent: await readAppliedComposeContent(app, genRow) };
  }
  if (!(await composeExists(candidateAbs))) {
    return { status: 'missing', reason: 'the staged candidate is absent or incomplete' };
  }
  if (!(await pathExists(path.join(candidateAbs, CANDIDATE_COMPLETE_MARKER)))) {
    return { status: 'missing', reason: 'the staged candidate is incomplete' };
  }

  await fsPromises.mkdir(path.dirname(appliedAbs), { recursive: true });
  try {
    await fsPromises.rename(candidateAbs, appliedAbs);
  } catch (err) {
    // A concurrent materialization may have renamed the candidate first. Adopt
    // its result rather than reporting a failure for work that did land.
    if (await composeExists(appliedAbs)) {
      return { status: 'already_materialized', composeContent: await readAppliedComposeContent(app, genRow) };
    }
    return {
      status: 'missing',
      reason: `the candidate could not be materialized: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  return { status: 'materialized', composeContent: await readAppliedComposeContent(app, genRow) };
}

/**
 * Resolve the accepted generation's expected artifact set from its applied
 * compose text, through the same approved-content parser the Inline freeze uses.
 *
 * `nodeId` names the node whose platform decides which manifest child a
 * multi-arch reference resolves to. The retry path passes the target it is
 * checking; acceptance passes the first live target. `resolveAndRecordArtifactSet`
 * records an unavailable row on a failed resolve, which is the evidence the
 * retry gate dates its next attempt from, so this never throws for a registry
 * that is down.
 */
export async function freezeGitManagedArtifactSet(args: {
  applicationId: string;
  generationId: string;
  actor: string | null;
  trigger: string;
  nodeId?: number;
}): Promise<GitManagedFreezeResult> {
  const store = GitOpsStore.getInstance();
  const app = store.getApplication(args.applicationId);
  if (!app || app.target_mode !== 'blueprint') return { status: 'none', reason: null };
  if (app.accepted_generation_id !== args.generationId) return { status: 'none', reason: null };

  const genRow = store.getGeneration(args.generationId);
  if (!genRow) return { status: 'none', reason: null };

  // The dispatch deploys one compose file, so a generation that materializes
  // more than one is a shape this freeze cannot model. Refused rather than
  // resolved from a subset: a set missing an override's services would read a
  // healthy stack as drifted.
  const composeFileCount = composeFileOrderLength(genRow.compose_inputs_json);
  if (composeFileCount !== null && composeFileCount > 1) {
    const reason = `the accepted generation materializes ${composeFileCount} compose files, which this freeze cannot model`;
    GitOpsTransitions.getInstance().setGitManagedArtifactLimitation({
      applicationId: args.applicationId,
      detail: reason,
    });
    return { status: 'refused', reason };
  }

  let composeContent: string;
  try {
    composeContent = await readAppliedComposeContent(app, genRow);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(
      '[GitOps] Git-managed artifact freeze skipped for %s: %s',
      sanitizeForLog(args.applicationId),
      sanitizeForLog(reason),
    );
    return { status: 'none', reason };
  }

  const parsed = parseApprovedServiceSpecs(composeContent);
  if ('refusal' in parsed) {
    // Refused rather than resolved without specs: recording a best-effort parse
    // as the approved identity would let a healthy stack read as drifted. The
    // projection reports the unresolved set, which is the honest state, and the
    // persisted limitation is what names the cause instead of leaving only the
    // generic unresolved-artifact refusal on the surface.
    console.warn(
      '[GitOps] Git-managed artifact freeze skipped for %s: %s',
      sanitizeForLog(args.applicationId),
      sanitizeForLog(parsed.refusal),
    );
    GitOpsTransitions.getInstance().setGitManagedArtifactLimitation({
      applicationId: args.applicationId,
      detail: parsed.refusal,
    });
    return { status: 'refused', reason: parsed.refusal };
  }

  const nodeId = args.nodeId ?? firstLiveTargetNode(store, app);
  if (nodeId === null) return { status: 'none', reason: 'no live target node to resolve against' };
  const stackName = app.configured_source_stack_name;
  if (!stackName) return { status: 'none', reason: 'the application has no retained source stack identity' };

  // "Resolved" means an expectation actually moved, so the retry caller can hold
  // this tick's comparison and let the next one judge evidence nobody has seen
  // yet. Either pointer counts: the application's set is what authorization
  // reads, and a target's expected pointer is what the drift comparison reads.
  const beforeApp = app.artifact_set_id;
  const beforeTarget = store.getTarget(app.id, nodeId)?.expected_artifact_set_id ?? null;
  await resolveAndRecordArtifactSet({
    stackName,
    nodeId,
    applicationId: args.applicationId,
    generationId: args.generationId,
    buildContexts: [],
    envelope: envelopeFor(args.actor, args.trigger),
    approvedServices: parsed.specs,
  });
  const afterApp = store.getApplication(args.applicationId)?.artifact_set_id ?? null;
  const afterTarget = store.getTarget(app.id, nodeId)?.expected_artifact_set_id ?? null;
  const appMoved = afterApp !== null && afterApp !== beforeApp;
  const targetMoved = afterTarget !== null && afterTarget !== beforeTarget;
  if (appMoved || targetMoved) {
    // A resolve proves the shape is modellable, so any prior refusal reason is
    // stale. Cleared here rather than on the next acceptance so the surface
    // stops naming a cause that no longer applies.
    GitOpsTransitions.getInstance().setGitManagedArtifactLimitation({
      applicationId: args.applicationId,
      detail: null,
    });
  }
  return {
    status: appMoved || targetMoved ? 'resolved' : 'none',
    reason: null,
  };
}

/**
 * Materialize then freeze, for the reconciler's retry path.
 *
 * The retry must re-run both halves: a candidate that could not be promoted at
 * acceptance (a transient filesystem failure, or a crash between the acceptance
 * commit and the materialize call) has no applied directory, and a freeze alone
 * would read nothing and leave the generation stranded for ever.
 */
export async function materializeAndFreezeGitManagedArtifactSet(args: {
  applicationId: string;
  generationId: string;
  actor: string | null;
  trigger: string;
  nodeId?: number;
}): Promise<GitManagedFreezeResult> {
  try {
    await materializeAcceptedGeneration(args.applicationId, args.generationId);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(
      '[GitOps] Git-managed materialization retry failed for %s: %s',
      sanitizeForLog(args.applicationId),
      sanitizeForLog(reason),
    );
    return { status: 'none', reason };
  }
  return freezeGitManagedArtifactSet(args);
}

/**
 * Materialize an accepted generation and resolve its artifact set in one call.
 *
 * Both accept paths (the manual route and the automatic controller) use this so
 * an operator's next click and the policy's own dispatch see the same prepared
 * state. A failure here leaves the acceptance standing and returns a note: the
 * reconciler's retry path owns the recovery, and the acceptance itself is not
 * undone by a filesystem or registry problem.
 */
export async function prepareAcceptedGitManagedGeneration(args: {
  applicationId: string;
  generationId: string;
  actor: string | null;
  trigger: string;
}): Promise<{ materialized: boolean; artifact: GitManagedFreezeStatus; note: string | null }> {
  let materialized: GitManagedMaterializeOutcome;
  try {
    materialized = await materializeAcceptedGeneration(args.applicationId, args.generationId);
  } catch (err) {
    console.error(
      '[GitOps] Git-managed materialization failed for %s: %s',
      sanitizeForLog(args.applicationId),
      sanitizeForLog(err instanceof Error ? err.message : String(err)),
    );
    return { materialized: false, artifact: 'none', note: 'the accepted generation could not be materialized yet; the next reconcile retries it' };
  }
  if (materialized.status === 'missing') {
    return { materialized: false, artifact: 'none', note: materialized.reason };
  }
  let artifact: GitManagedFreezeResult;
  try {
    artifact = await freezeGitManagedArtifactSet({
      applicationId: args.applicationId,
      generationId: args.generationId,
      actor: args.actor,
      trigger: args.trigger,
    });
  } catch (err) {
    // The freeze is expected to be total, but a throw here must not escape a
    // caller whose acceptance has already committed.
    const reason = err instanceof Error ? err.message : String(err);
    console.error(
      '[GitOps] Git-managed artifact freeze failed for %s: %s',
      sanitizeForLog(args.applicationId),
      sanitizeForLog(reason),
    );
    return { materialized: true, artifact: 'none', note: 'the artifact identity could not be resolved yet; the next reconcile retries it' };
  }
  return {
    materialized: true,
    artifact: artifact.status,
    note: artifact.status === 'resolved'
      ? null
      : artifact.reason ?? 'the artifact identity could not be resolved yet; the next reconcile retries it',
  };
}

/**
 * The applied-side counterpart of `validateCandidateRelPath`.
 *
 * The generation row's `applied_dir` decides where a rename lands, so it gets
 * the same shape checks the candidate side has: safe relative segments, the
 * `generations/applied-` prefix, and containment in the stack's managed root.
 * Without this a corrupt row could name another generation's directory and have
 * that content adopted as this generation's materialization.
 */
function validateAppliedRelPath(rel: unknown, managedRoot: string): string | null {
  if (typeof rel !== 'string' || rel.length === 0) return 'applied_dir is not a path';
  if (path.isAbsolute(rel)) return 'applied_dir is absolute';
  const segments = rel.split(/[\\/]/);
  if (segments.some((segment) => segment === '..' || segment === '.' || segment === '')) {
    return 'applied_dir has an unsafe segment';
  }
  if (!rel.startsWith(`${GENERATIONS_DIR}/applied-`)) {
    return `applied_dir must start with ${GENERATIONS_DIR}/applied-`;
  }
  const base = path.resolve(managedRoot);
  const resolved = path.resolve(base, rel);
  return resolved.startsWith(base + path.sep) ? null : 'applied_dir escapes the managed root';
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fsPromises.access(target);
    return true;
  } catch {
    return false;
  }
}

async function composeExists(dir: string): Promise<boolean> {
  return pathExists(path.join(dir, 'compose.yaml'));
}

/**
 * The number of compose files a generation declares, or null when the row does
 * not say. Read defensively: the value is a hint for a refusal, not a contract,
 * and a malformed blob must not turn the freeze into a throw.
 */
function composeFileOrderLength(composeInputsJson: string | null): number | null {
  if (!composeInputsJson) return null;
  try {
    const decoded = JSON.parse(composeInputsJson) as { composeFileOrder?: unknown };
    if (!Array.isArray(decoded.composeFileOrder)) return null;
    return decoded.composeFileOrder.length;
  } catch {
    return null;
  }
}

function firstLiveTargetNode(store: GitOpsStore, app: GitOpsApplicationRow): number | null {
  for (const target of store.listTargets(app.id)) {
    if (target.target_status !== 'active') continue;
    if (DatabaseService.getInstance().getNode(target.node_id)) return target.node_id;
  }
  return NodeRegistry.getInstance().getDefaultNodeId();
}
