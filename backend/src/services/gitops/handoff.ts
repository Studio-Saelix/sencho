import type { RepoIdentity } from './repoIdentity';
import type { RefKind } from '../git/types';
import type { GitOpsGenerationRow } from './types';

/**
 * A portable projection of the managed-project manifest: authored file set
 * and per-file content digests, without node id, stack name, or generation
 * directory. The real GitProjectManifest carries those identity fields;
 * this is deliberately narrower.
 */
export type PortableManifest = {
  files: Array<{ path: string; role: string; contentSha256?: string | null }>;
};

/** Authored Compose invocation shape, without a target project name. */
export type ComposeInputs = {
  composeFileOrder: string[];
  profiles?: string[];
  contextDir?: string | null;
};

/**
 * One accepted generation, described purely by what it contains. Direct and
 * Blueprint dispatch consume the exact same shape; current target mode,
 * binding revision, and any execution-local path travel separately in
 * DispatchContext, re-read under the dispatch lock rather than carried
 * here, so a stale acceptance can never authorize a routing decision made
 * after it.
 */
export type AcceptedGeneration = {
  contractVersion: 1;
  generationId: string;
  applicationId: string;
  repoIdentity: RepoIdentity;
  configuredRef: string;
  commitSha: string;
  resolvedRefKind: RefKind | null;
  manifestVersion: number;
  portableManifest: PortableManifest | null;
  composeInputs: ComposeInputs | null;
  materializationFingerprint: string;
  changePlanFingerprint: string | null;
  validationOk: boolean;
  sourcePolicyEvidence: unknown | null;
  securityPolicyEvidence: unknown | null;
  supportRequirements: unknown | null;
  compatibilityRequirements: unknown | null;
  /** Capability metadata only; never a secret value. Not yet populated by any producer. */
  secretCapability: unknown | null;
  trigger: string;
  actor: string | null;
  operationId: string;
  previousGenerationId: string | null;
  /** Why some field above could not be proven, recorded honestly rather than guessed. */
  limitations: string[];
};

function parseOptionalJson<T>(raw: string | null, limitationLabel: string, limitations: string[]): T | null {
  if (raw === null) {
    limitations.push(limitationLabel);
    return null;
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    limitations.push(`${limitationLabel}_unparseable`);
    return null;
  }
}

/**
 * Build the portable accepted-generation contract from a persisted
 * generation row. A legacy row predating one of the portable-contract
 * columns decodes that field as null with an explicit limitation recorded,
 * never as invented evidence.
 */
export function buildAcceptedGeneration(row: GitOpsGenerationRow): AcceptedGeneration {
  let repoIdentity: RepoIdentity;
  try {
    repoIdentity = JSON.parse(row.repo_identity_json) as RepoIdentity;
  } catch {
    throw new Error(`Generation ${row.id} has an unparseable repo_identity_json; refusing to build an accepted-generation contract from corrupt evidence.`);
  }

  const limitations: string[] = JSON.parse(row.redacted_limitations_json) as string[];
  const portableManifest = parseOptionalJson<PortableManifest>(row.portable_manifest_json, 'portable_manifest_missing', limitations);
  const composeInputs = parseOptionalJson<ComposeInputs>(row.compose_inputs_json, 'compose_inputs_missing', limitations);
  const sourcePolicyEvidence = parseOptionalJson<unknown>(row.source_policy_evidence_json, 'source_policy_evidence_missing', limitations);
  const securityPolicyEvidence = parseOptionalJson<unknown>(row.security_policy_evidence_json, 'security_policy_evidence_missing', limitations);
  const supportRequirements = parseOptionalJson<unknown>(row.support_requirements_json, 'support_requirements_missing', limitations);
  const compatibilityRequirements = parseOptionalJson<unknown>(row.compatibility_requirements_json, 'compatibility_requirements_missing', limitations);

  return {
    contractVersion: 1,
    generationId: row.id,
    applicationId: row.application_id,
    repoIdentity,
    configuredRef: row.configured_ref,
    commitSha: row.commit_sha,
    resolvedRefKind: row.resolved_ref_kind,
    manifestVersion: row.manifest_version,
    portableManifest,
    composeInputs,
    materializationFingerprint: row.materialization_fingerprint,
    changePlanFingerprint: row.change_plan_fingerprint,
    validationOk: row.validation_ok === 1,
    sourcePolicyEvidence,
    securityPolicyEvidence,
    supportRequirements,
    compatibilityRequirements,
    secretCapability: null,
    trigger: row.trigger,
    actor: row.actor,
    operationId: row.operation_id,
    previousGenerationId: row.previous_generation_id,
    limitations,
  };
}

/**
 * Current target mode and binding, re-read under the dispatch lock rather
 * than carried on AcceptedGeneration, so a routing decision is always made
 * from the current state, never a value an earlier acceptance froze.
 */
export type DispatchContext = {
  targetMode: 'direct' | 'blueprint';
  nodeId: number | null;
  bindingRevision: string | null;
};

export type DispatchResult =
  | { status: 'dispatched' }
  | { status: 'blocked'; reason: string };

export interface TargetAdapter {
  dispatch(generation: AcceptedGeneration, context: DispatchContext): Promise<DispatchResult>;
}

/**
 * Fails closed until Blueprint rollout orchestration exists. Never
 * inspects selectors, target sets, or placement: an accepted generation
 * for a Blueprint-mode application is evaluated the same as Direct, but
 * dispatch stops here.
 */
export class BlueprintTargetAdapter implements TargetAdapter {
  async dispatch(_generation: AcceptedGeneration, _context: DispatchContext): Promise<DispatchResult> {
    return { status: 'blocked', reason: 'Blueprint rollout orchestration is not yet implemented.' };
  }
}
