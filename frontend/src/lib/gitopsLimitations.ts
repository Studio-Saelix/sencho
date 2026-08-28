// Operator wording for the caveats a live projection can carry.
//
// A limitation on the live arm is not a failure. It says the state being shown
// is real but one piece of evidence behind it could not be proven, so a reader
// knows which part to distrust. The absent arm is different: there, a
// limitation means an application we expected could not be reached at all, and
// `absentFault` in gitopsState.ts handles that as a fault.
//
// The backend messages are written for whoever is reading a log ("repo identity
// json is invalid"), so they are deliberately not surfaced. These sentences say
// what is uncertain and what follows from it.
//
// Each entry was checked against the site that emits it rather than against the
// code's name. Several names suggest something narrower or wider than the
// condition actually tested.
//
// A backend code with no entry here degrades to the fallback below rather than
// vanishing, so drift is safe rather than silent. The accompanying test lists
// every code the live arm can carry, which is narrower than every code the
// backend emits: the absent-arm faults and the history-row defect are handled
// elsewhere and deliberately have no copy here.

import type { GitOpsLimitation } from '@/types/gitops';

/**
 * Keyed on an open string, not a union.
 *
 * The wire type is `code: string` and a limitation can be minted at write time
 * and merged into the projection later, so a node running a newer build can
 * legitimately send a code this build has never heard of. Closing the type here
 * would only move that surprise to a type assertion.
 *
 * The value is optional so a lookup miss is a fact the compiler produces
 * rather than one a comment asserts. This project does not set
 * `noUncheckedIndexedAccess`, so a plain `Record<string, string>` would type
 * every miss as a `string` and make the fallback below look like dead code to
 * anything that trusts the types.
 */
export const GITOPS_LIMITATION_COPY: Record<string, string | undefined> = {
  // --- derived while projecting -------------------------------------------
  repo_identity_invalid:
    'The stored repository identity could not be read, so this state cannot be tied back to a specific repository.',
  candidate_generation_invalid:
    'The pending change points at a generation that is missing or belongs to another application, so it must be fetched again before it can be applied.',
  accepted_generation_invalid:
    'The recorded accepted generation is missing or belongs to another application, so this state cannot be trusted until the source has been fetched and applied again.',
  artifact_pointer_missing:
    'An artifact record this state refers to is no longer present, so what was built for this generation cannot be described.',
  artifact_evidence_json_invalid:
    'An artifact record could not be read, so what is running cannot be compared against what was expected.',
  connectivity_invalid:
    'The stored reachability of this node is not a value Sencho recognises, so it is being treated as unknown.',
  lkg_generation_missing:
    'The generation recorded as last known good is gone, so there is nothing to fall back to.',
  lkg_artifact_invalid:
    'The artifact captured with the last known good is missing or does not belong to it, so that fallback is no longer fully qualified.',
  evidence_limitations_invalid:
    'The record of what could not be proven is itself unreadable, so there may be further caveats that cannot be shown.',
  artifact_observation_invalid:
    'What is running on this node could not be read, so it is reported as unidentified rather than as matching.',
  artifact_observation_decode_failed:
    'What is running on this node could not be read, so it is reported as unidentified rather than as matching.',

  // --- recorded at write time, merged in later ------------------------------
  recovery_unproven:
    'A recovery ran but could not be tied to a specific generation, so the pointers were left where they were rather than moved on an unproven claim.',
  lkg_artifact_unprovable:
    'The artifact captured with the last known good could not be proven during recovery, so the fallback is available but no longer qualified.',
  source_acceptance_unprovable:
    'The approval that authorized the generation now in place could not be restored, so this node is running an accepted generation with no approval attached to it.',
  artifact_expectation_unprovable:
    'The expected artifact could not be restored during recovery, so drift between what is running and what was intended is not being checked on this node.',
  manifest_absent:
    'No managed manifest was found for this stack, so the commit recorded before Sencho tracked it is kept only as evidence and not treated as current.',
  manifest_corrupt:
    'The managed manifest could not be read, so the commit recorded before Sencho tracked it is kept only as evidence and not treated as current.',
  manifest_identity_invalid:
    'The managed manifest does not identify this stack on this node from the repository configured now, so its commit is kept only as evidence.',
  manifest_commit_unresolved:
    'The managed manifest records no commit, so the commit recorded before Sencho tracked this stack cannot be confirmed against what is on disk. Fetch to resolve one.',
  manifest_commit_mismatch:
    'The managed manifest names a different commit than the one recorded as applied, so neither is treated as current. Fetch again to settle which one is on disk.',
  legacy_pending:
    'A pending commit was recorded before Sencho tracked this stack and carries no proof of which repository or branch it came from. Fetch again to rebuild it.',
  blueprint_reapproval_required:
    'The stored approval does not cover what this Blueprint currently asks for, so it needs approving again before it can roll out.',
};

/**
 * Operator wording for one limitation, or a safe fallback.
 *
 * An unrecognised code names itself rather than being dropped. Saying nothing
 * would report full confidence in a state the backend flagged, which is the one
 * outcome this affordance exists to prevent.
 */
export function limitationCaveat(limitation: GitOpsLimitation): string {
  return GITOPS_LIMITATION_COPY[limitation.code]
    ?? `Part of this state could not be proven (${limitation.code}).`;
}

/**
 * The caveats worth showing for a projection's limitations, de-duplicated.
 *
 * One condition can be recorded per target and again per application, so the
 * same sentence can arrive several times over. Repeating it would read as
 * several separate problems.
 */
export function limitationCaveats(limitations: readonly GitOpsLimitation[]): string[] {
  return [...new Set(limitations.map(limitationCaveat))];
}
