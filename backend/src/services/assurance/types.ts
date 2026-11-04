/**
 * The Compose Assurance contract: one canonical rule registry that every
 * assurance surface reads from, plus the normalized finding shape they produce.
 *
 * Canonical rule ids are the existing Compose Doctor ids. They are already
 * persisted in `preflight_findings.rule_id` and `preflight_acknowledgements`
 * (and keyed by the Networking aggregation), so keeping them means no data
 * migration and no change to existing acknowledgements. Policy-pack ids and
 * external scanner ids are aliases that resolve onto a canonical id.
 *
 * Ids are permanent: a retired rule is `deprecated`, never deleted or reused.
 */

/** Graded severity of a single assurance finding. `blocker` is reserved for
 *  Sencho's own technical blockers; an external scanner never produces one. */
export type AssuranceSeverity = 'blocker' | 'high' | 'warning' | 'info';

/** What kind of problem the finding describes, independent of severity. */
export type FindingClass =
  | 'technical-blocker'
  | 'security'
  | 'reliability'
  | 'portability'
  | 'exposure'
  | 'change-risk'
  | 'information';

/** Which layer of evidence produced a finding. */
export type EvidenceLayer = 'authored' | 'effective' | 'runtime' | 'fleet' | 'change';

/**
 * A piece of evidence a rule needs before it can reach a verdict. The runner
 * checks these before calling the rule and records each skipped rule, so a run
 * that could not collect one kind of evidence reports partial coverage instead
 * of a silent pass.
 */
export type EvidenceRequirement =
  | 'source' // ctx.sourceReadable
  | 'effective-model' // ctx.model !== null
  | 'env-context' // ctx.envContextAvailable
  | 'node-state' // ctx.nodeStateAvailable
  | 'exposure-context' // ctx.exposureAvailable
  | 'compose-version'; // ctx.composeVersionSkew !== null

/** The fact a finding is about, independent of the rule that reported it. */
export type SubjectKind =
  | 'stack'
  | 'service'
  | 'port'
  | 'bind'
  | 'network'
  | 'volume'
  | 'env-var'
  | 'env-file'
  | 'container-name'
  | 'image';

/** The surface area of the Compose model a rule inspects. */
export type RuleCategory =
  | 'render'
  | 'environment'
  | 'ports'
  | 'mounts'
  | 'security'
  | 'reliability'
  | 'compose-semantics'
  | 'node-state'
  | 'exposure'
  | 'self-protection';

/** A rule that did not run, and the evidence it lacked. */
export interface AssuranceCoverageSkip {
  ruleId: CanonicalRuleId;
  missing: readonly EvidenceRequirement[];
  affectsVerdict: boolean;
}

/**
 * Which checks ran. `complete` means every active verdict-affecting rule either
 * ran or was not applicable. `unrecorded` means the run predates coverage or
 * came from an older node.
 */
export interface AssuranceCoverage {
  state: 'complete' | 'partial' | 'unrecorded';
  evaluated: number;
  /** Platform-gated rules that do not apply on this node (POSIX rules on win32). */
  notApplicable: number;
  skipped: readonly AssuranceCoverageSkip[];
}

/** A reference to a published benchmark control. Only added once verified
 *  against a primary source; an empty list is the honest default. */
export interface StandardsReference {
  framework: 'cis-docker' | 'owasp-docker';
  version: string;
  control: string;
}

export type AliasRelation = 'equivalent' | 'related';

/** An external scanner check that correlates with a canonical rule. */
export interface ExternalAlias {
  scanner: 'trivy';
  id: string;
  /**
   * `equivalent`: the external check evaluates the same fact, so it dedupes
   * onto the canonical rule and takes the registry severity.
   * `related`: it only correlates. It never dedupes, never shares an
   * acknowledgement, and never takes the canonical rule's severity.
   */
  relation: AliasRelation;
}

/**
 * One entry in the canonical registry. `compose-doctor` rules are evaluated by
 * the Compose Doctor runner; `catalog` rules are declared expectations with no
 * evaluator yet, so no surface may claim they were checked.
 */
export interface AssuranceRule {
  /** Closed union, so an unregistered id cannot compile. */
  id: CanonicalRuleId;
  /** Bump on a semantic change to what the rule detects or how it is graded. */
  version: number;
  status: 'active' | 'catalog' | 'deprecated';
  deprecation?: { since: string; reason: string; replacedBy?: CanonicalRuleId };
  /** `null` for catalog rules, which have no evaluator. */
  engine: 'compose-doctor' | null;
  title: string;
  category: RuleCategory;
  description: string;
  defaultSeverity: AssuranceSeverity;
  /** Every severity this rule may emit, including the default. */
  severities: readonly AssuranceSeverity[];
  findingClass: FindingClass;
  /** `false` marks a note: shown for context, excluded from All Clear and readiness. */
  affectsVerdict: boolean;
  evidenceLayers: readonly EvidenceLayer[];
  requires: readonly EvidenceRequirement[];
  platforms: 'any' | 'posix';
  composeModes: readonly ('compose' | 'swarm')[];
  subject: SubjectKind;
  defaultConfidence: FindingConfidence;
  standards: readonly StandardsReference[];
  aliases: {
    policyPack: readonly string[];
    external: readonly ExternalAlias[];
  };
  capabilities: { acknowledge: boolean; enforce: boolean; remediate: boolean };
}

export type FindingConfidence = 'confirmed' | 'inferred' | 'unverified';

/**
 * The canonical ids. Compose Doctor ids come first in the order the runner
 * evaluates them; the catalog ids follow. A rule added to the runner with an
 * id that is missing here fails to compile.
 */
export type CanonicalRuleId =
  // Compose Doctor (active)
  | 'render-failed'
  | 'env-unset'
  | 'env-literal-dollar'
  | 'env-file-missing'
  | 'port-conflict-node'
  | 'port-conflict-internal'
  | 'port-exposed-all-interfaces'
  | 'bind-path-missing'
  | 'bind-path-permission'
  | 'docker-socket-mount'
  | 'docker-socket-proxy'
  | 'docker-socket-proxy-writable'
  | 'docker-socket-proxy-published'
  | 'docker-socket-proxy-mutating'
  | 'docker-socket-proxy-exposure'
  | 'docker-socket-proxy-client'
  | 'privileged'
  | 'network-mode-host'
  | 'uid-gid-risk'
  | 'image-latest'
  | 'no-restart-policy'
  | 'no-healthcheck'
  | 'healthcheck-disabled'
  | 'healthcheck-inherited'
  | 'healthcheck-unverifiable'
  | 'healthcheck-inconsistent'
  | 'deploy-swarm-only'
  | 'node-state-unavailable'
  | 'compose-version-mismatch'
  | 'external-network-missing'
  | 'external-volume-missing'
  | 'new-network'
  | 'new-volume'
  | 'anonymous-volume'
  | 'container-name-internal-dup'
  | 'container-name-collision'
  | 'exposure-internal-published'
  | 'exposure-internal-tunneled'
  | 'sensitive-service-broad-exposure'
  | 'tunnel-exposure'
  | 'exposure-unclassified'
  | 'exposure-port-vs-dossier'
  | 'reverse-proxy-undocumented'
  | 'effective-model-expanded'
  | 'self-managed-stack'
  // Catalog (no evaluator yet)
  | 'broad-host-bind-mount'
  | 'public-database-port'
  | 'root-user'
  | 'plaintext-secret'
  | 'no-resource-limits'
  | 'image-not-digest-pinned'
  | 'writable-root-filesystem'
  | 'default-capabilities';

/** A finding from an external scanner with no canonical alias. */
export type ExternalRuleId = `external:${string}:${string}`;

/** The normalized finding identity. `basis: 'legacy'` means the row predates
 *  the contract; consumers must never deduplicate on a legacy identity. */
export type IdentityBasis = 'structured' | 'legacy';

/** The evidence a rule needs, in the order they are checked. */
export const EVIDENCE_REQUIREMENTS: readonly EvidenceRequirement[] = [
  'source',
  'effective-model',
  'env-context',
  'node-state',
  'exposure-context',
  'compose-version',
];

/** Which evidence layer a requirement belongs to. */
export const REQUIREMENT_LAYER: Record<EvidenceRequirement, EvidenceLayer> = {
  source: 'authored',
  'effective-model': 'effective',
  'env-context': 'authored',
  'node-state': 'runtime',
  'exposure-context': 'authored',
  'compose-version': 'runtime',
};
