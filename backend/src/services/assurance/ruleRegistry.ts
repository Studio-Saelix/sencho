/**
 * The canonical Compose Assurance rule registry.
 *
 * One entry per rule every assurance surface can report: the Compose Doctor
 * rules the runner evaluates today, plus catalog entries for hardening checks
 * that are declared but not evaluated yet (their evaluators land with the hardening work).
 *
 * Order is meaningful. Compose Doctor rules appear in the order the runner
 * evaluates them, which is also the display order within a severity group, and
 * the catalog rules follow. A new rule appends; it never renumbers another.
 *
 * Compatibility: ids are permanent. Removing a rule means `status: 'deprecated'`
 * with a reason (and an optional `replacedBy`), never deletion. A change to what
 * a rule detects, its default severity, its finding class, or `affectsVerdict`
 * requires a version bump. `assurance-registry-lock.test.ts` holds the literal
 * lock that forces that edit to be deliberate.
 */
import type {
  AssuranceRule, AssuranceSeverity, CanonicalRuleId, EvidenceLayer, EvidenceRequirement,
  ExternalAlias, FindingClass, FindingConfidence, RuleCategory, SubjectKind,
} from './types';
import { REQUIREMENT_LAYER } from './types';

interface DoctorRuleSeed {
  id: CanonicalRuleId;
  title: string;
  description: string;
  category: RuleCategory;
  defaultSeverity: AssuranceSeverity;
  /** Every severity the rule may emit; defaults to the default severity alone. */
  severities?: readonly AssuranceSeverity[];
  findingClass: FindingClass;
  /** Defaults to true; `false` marks a note. */
  affectsVerdict?: boolean;
  /** Defaults to none (the rule runs on every context). */
  requires?: readonly EvidenceRequirement[];
  subject?: SubjectKind;
  platforms?: 'any' | 'posix';
  confidence?: FindingConfidence;
  /** Defaults to the layers implied by `requires`, or `authored` when none. */
  evidenceLayers?: readonly EvidenceLayer[];
  policyPack?: readonly string[];
  external?: readonly ExternalAlias[];
}

interface CatalogRuleSeed {
  id: CanonicalRuleId;
  title: string;
  description: string;
  category: RuleCategory;
  defaultSeverity: AssuranceSeverity;
  findingClass: FindingClass;
  subject?: SubjectKind;
  policyPack?: readonly string[];
  external?: readonly ExternalAlias[];
}

function layersFor(requires: readonly EvidenceRequirement[], override?: readonly EvidenceLayer[]): readonly EvidenceLayer[] {
  if (override) return override;
  if (requires.length === 0) return ['authored'];
  return [...new Set(requires.map(requirement => REQUIREMENT_LAYER[requirement]))];
}

/** An evaluated rule. Its id is the id the runner reports hits under. */
function doctorRule(seed: DoctorRuleSeed): AssuranceRule {
  const requires = seed.requires ?? [];
  const affectsVerdict = seed.affectsVerdict ?? true;
  return {
    id: seed.id,
    version: 1,
    status: 'active',
    engine: 'compose-doctor',
    title: seed.title,
    category: seed.category,
    description: seed.description,
    defaultSeverity: seed.defaultSeverity,
    severities: seed.severities ?? [seed.defaultSeverity],
    findingClass: seed.findingClass,
    affectsVerdict,
    evidenceLayers: layersFor(requires, seed.evidenceLayers),
    requires,
    platforms: seed.platforms ?? 'any',
    composeModes: ['compose'],
    subject: seed.subject ?? 'service',
    defaultConfidence: seed.confidence ?? 'confirmed',
    standards: [],
    aliases: { policyPack: seed.policyPack ?? [], external: seed.external ?? [] },
    capabilities: { acknowledge: affectsVerdict, enforce: false, remediate: false },
  };
}

/**
 * A declared hardening expectation with no evaluator. It appears in policy
 * packs and in reference material, but no surface may claim it was checked:
 * `engine: null`, `status: 'catalog'`, and `affectsVerdict: false`.
 */
function catalogRule(seed: CatalogRuleSeed): AssuranceRule {
  return {
    id: seed.id,
    version: 1,
    status: 'catalog',
    engine: null,
    title: seed.title,
    category: seed.category,
    description: seed.description,
    defaultSeverity: seed.defaultSeverity,
    severities: [seed.defaultSeverity],
    findingClass: seed.findingClass,
    affectsVerdict: false,
    evidenceLayers: ['authored'],
    requires: [],
    platforms: 'any',
    composeModes: ['compose'],
    subject: seed.subject ?? 'service',
    defaultConfidence: 'confirmed',
    standards: [],
    aliases: { policyPack: seed.policyPack ?? [], external: seed.external ?? [] },
    capabilities: { acknowledge: false, enforce: false, remediate: false },
  };
}

export const ASSURANCE_RULES: readonly AssuranceRule[] = [
  // ----- Compose Doctor -----------------------------------------------------
  doctorRule({
    id: 'render-failed',
    title: 'Compose model could not be rendered',
    description: 'The effective Compose model could not be produced, so no other structural check could run.',
    category: 'render',
    defaultSeverity: 'blocker',
    findingClass: 'technical-blocker',
    evidenceLayers: ['effective'],
    subject: 'stack',
  }),
  doctorRule({
    id: 'env-unset',
    title: 'Unset variable',
    description: 'A variable the Compose model references is set neither in the environment nor in any consulted env file, so Compose substitutes an empty string.',
    category: 'environment',
    defaultSeverity: 'high',
    findingClass: 'reliability',
    requires: ['env-context'],
    subject: 'env-var',
  }),
  doctorRule({
    id: 'env-literal-dollar',
    title: 'Literal dollar sign in an environment value',
    description: 'A literal dollar sequence inside an environment value is read as variable interpolation, which can corrupt a hash or a secret.',
    category: 'environment',
    defaultSeverity: 'high',
    findingClass: 'reliability',
    // Reads a prepared summary of Compose's own warnings, so it does not need the
    // authored env context: when that context is unreadable the service still
    // emits a generic warning from the raw stderr names.
    confidence: 'inferred',
    subject: 'env-var',
  }),
  doctorRule({
    id: 'env-file-missing',
    title: 'Missing env file',
    description: 'The Compose file declares a required env_file that is absent from the stack directory, so Compose refuses to start the stack.',
    category: 'environment',
    defaultSeverity: 'high',
    findingClass: 'technical-blocker',
    requires: ['env-context'],
    subject: 'env-file',
  }),
  doctorRule({
    id: 'port-conflict-node',
    title: 'Host port is already in use',
    description: 'A published host port is already bound by another workload on the node, so the deploy fails.',
    category: 'ports',
    defaultSeverity: 'blocker',
    findingClass: 'technical-blocker',
    requires: ['effective-model', 'node-state'],
    subject: 'port',
  }),
  doctorRule({
    id: 'port-conflict-internal',
    title: 'Two services publish the same host port',
    description: 'Two services in the same stack claim the same host port on overlapping interfaces, so only one can bind it.',
    category: 'ports',
    defaultSeverity: 'blocker',
    findingClass: 'technical-blocker',
    requires: ['effective-model'],
    subject: 'port',
  }),
  doctorRule({
    id: 'port-exposed-all-interfaces',
    title: 'Port exposed on all interfaces',
    description: 'A published port binds every host interface, so it is reachable from every network the host is attached to.',
    category: 'ports',
    defaultSeverity: 'high',
    findingClass: 'exposure',
    requires: ['effective-model'],
    subject: 'port',
  }),
  doctorRule({
    id: 'bind-path-missing',
    title: 'Bind mount path is missing',
    description: 'A bind-mount source inside the compose base directory does not exist, so Docker creates a root-owned directory on deploy.',
    category: 'mounts',
    defaultSeverity: 'high',
    findingClass: 'reliability',
    requires: ['effective-model'],
    subject: 'bind',
  }),
  doctorRule({
    id: 'bind-path-permission',
    title: 'Bind mount may have wrong ownership',
    description: 'A bind-mount source is owned by root while the service runs as a non-root user, which commonly blocks writes.',
    category: 'mounts',
    defaultSeverity: 'warning',
    findingClass: 'reliability',
    requires: ['effective-model'],
    platforms: 'posix',
    confidence: 'inferred',
    subject: 'bind',
  }),
  doctorRule({
    id: 'docker-socket-mount',
    title: 'Docker socket mounted',
    description: 'A service mounts the Docker socket directly without acting as a socket proxy, granting broad control over the host.',
    category: 'security',
    defaultSeverity: 'high',
    findingClass: 'security',
    requires: ['effective-model'],
    policyPack: ['no-docker-socket'],
  }),
  doctorRule({
    id: 'docker-socket-proxy',
    title: 'Docker socket proxy detected',
    description: 'A service intentionally mounts the Docker socket because it is a socket proxy; its reach and enabled API groups need review.',
    category: 'security',
    defaultSeverity: 'info',
    findingClass: 'information',
    requires: ['effective-model'],
  }),
  doctorRule({
    id: 'docker-socket-proxy-writable',
    title: 'Docker socket proxy mounts the socket read-write',
    description: 'A socket proxy mounts the Docker socket read-write, so compromising the proxy grants full control over the host.',
    category: 'security',
    defaultSeverity: 'high',
    findingClass: 'security',
    requires: ['effective-model'],
  }),
  doctorRule({
    id: 'docker-socket-proxy-published',
    title: 'Docker socket proxy publishes a host port',
    description: 'A socket proxy publishes a host port, which can expose the proxied Docker API beyond the Compose network.',
    category: 'security',
    defaultSeverity: 'high',
    findingClass: 'security',
    requires: ['effective-model'],
  }),
  doctorRule({
    id: 'docker-socket-proxy-mutating',
    title: 'Docker socket proxy allows mutating API access',
    description: 'A socket proxy enables POST or DELETE, permitting write and delete operations through the proxied Docker API.',
    category: 'security',
    defaultSeverity: 'warning',
    findingClass: 'security',
    requires: ['effective-model'],
  }),
  doctorRule({
    id: 'docker-socket-proxy-exposure',
    title: 'Docker socket proxy on a non-internal network',
    description: 'A socket proxy joins a network that is not marked internal, which widens who can reach the proxied Docker API.',
    category: 'security',
    defaultSeverity: 'warning',
    findingClass: 'security',
    requires: ['effective-model'],
  }),
  doctorRule({
    id: 'docker-socket-proxy-client',
    title: 'Docker API access routed through socket proxy',
    description: 'A service reaches the Docker API through a socket proxy instead of mounting the socket directly.',
    category: 'security',
    defaultSeverity: 'info',
    findingClass: 'information',
    affectsVerdict: false,
    requires: ['effective-model'],
  }),
  doctorRule({
    id: 'privileged',
    title: 'Privileged container',
    description: 'A service runs with privileged enabled, which disables most container isolation.',
    category: 'security',
    defaultSeverity: 'high',
    findingClass: 'security',
    requires: ['effective-model'],
    policyPack: ['no-privileged'],
  }),
  doctorRule({
    id: 'network-mode-host',
    title: 'Host network mode',
    description: 'A service uses host networking, which bypasses network isolation and ignores published-port mappings.',
    category: 'security',
    defaultSeverity: 'high',
    findingClass: 'security',
    requires: ['effective-model'],
    policyPack: ['no-host-network'],
  }),
  doctorRule({
    id: 'uid-gid-risk',
    title: 'Check UID/GID alignment',
    description: 'A service sets a user id and mounts host paths Sencho cannot inspect, where ownership mismatches are a common failure.',
    category: 'mounts',
    defaultSeverity: 'warning',
    findingClass: 'reliability',
    requires: ['effective-model'],
    confidence: 'inferred',
  }),
  doctorRule({
    id: 'image-latest',
    title: 'Image uses a moving tag',
    description: 'An image reference resolves to the moving latest tag or carries no tag, so deploys are not reproducible.',
    category: 'reliability',
    defaultSeverity: 'warning',
    findingClass: 'change-risk',
    requires: ['effective-model'],
    subject: 'image',
    policyPack: ['pin-image-tag'],
    external: [{ scanner: 'trivy', id: 'DS001', relation: 'related' }],
  }),
  doctorRule({
    id: 'no-restart-policy',
    title: 'No restart policy',
    description: 'A service has no restart policy, so it stays down after a crash or host reboot until someone notices.',
    category: 'reliability',
    defaultSeverity: 'warning',
    findingClass: 'reliability',
    requires: ['effective-model'],
    policyPack: ['restart-policy'],
  }),
  doctorRule({
    id: 'no-healthcheck',
    title: 'No effective healthcheck detected',
    description: 'No healthcheck is declared in Compose, the running container, or the local image, so readiness cannot be observed.',
    category: 'reliability',
    defaultSeverity: 'warning',
    findingClass: 'reliability',
    requires: ['effective-model'],
    policyPack: ['healthcheck-defined'],
    external: [{ scanner: 'trivy', id: 'DS026', relation: 'related' }],
  }),
  doctorRule({
    id: 'healthcheck-disabled',
    title: 'Healthcheck explicitly disabled',
    description: 'A service disables its healthcheck, so Docker never reports readiness for it.',
    category: 'reliability',
    defaultSeverity: 'warning',
    findingClass: 'reliability',
    requires: ['effective-model'],
  }),
  doctorRule({
    id: 'healthcheck-inherited',
    title: 'Healthcheck inherited from image',
    description: 'A service declares no Compose healthcheck and inherits one from the running container or the local image.',
    category: 'reliability',
    defaultSeverity: 'info',
    findingClass: 'information',
    affectsVerdict: false,
    requires: ['effective-model'],
  }),
  doctorRule({
    id: 'healthcheck-unverifiable',
    title: 'Healthcheck inheritance could not be verified',
    description: 'A service declares no Compose healthcheck and Docker evidence was unavailable to tell whether the image provides one.',
    category: 'reliability',
    defaultSeverity: 'info',
    findingClass: 'information',
    requires: ['effective-model'],
    confidence: 'unverified',
  }),
  doctorRule({
    id: 'healthcheck-inconsistent',
    title: 'Replica healthcheck coverage is inconsistent',
    description: 'Running replicas of a service have mixed effective healthcheck coverage, so readiness is not uniform.',
    category: 'reliability',
    defaultSeverity: 'warning',
    findingClass: 'reliability',
    requires: ['effective-model'],
  }),
  doctorRule({
    id: 'deploy-swarm-only',
    title: 'Swarm-only deploy fields',
    description: 'A service sets deploy fields that standalone Compose ignores because they only apply to Swarm.',
    category: 'compose-semantics',
    defaultSeverity: 'warning',
    findingClass: 'portability',
    requires: ['effective-model'],
  }),
  doctorRule({
    id: 'node-state-unavailable',
    title: 'Node-state checks skipped',
    description: 'The node Docker snapshot could not be read, so external-resource, host-port, and container-name checks did not run.',
    category: 'node-state',
    defaultSeverity: 'info',
    findingClass: 'information',
    requires: ['effective-model'],
    evidenceLayers: ['runtime'],
    subject: 'stack',
  }),
  doctorRule({
    id: 'compose-version-mismatch',
    title: 'Created by another Docker Compose version',
    description: 'Running containers were created by a different Compose version, so the next deploy or update may recreate them.',
    category: 'node-state',
    defaultSeverity: 'info',
    findingClass: 'information',
    affectsVerdict: false,
    requires: ['node-state', 'compose-version'],
    subject: 'container-name',
  }),
  doctorRule({
    id: 'external-network-missing',
    title: 'External network not found',
    description: 'A network declared external does not exist on the node, so the deploy fails.',
    category: 'compose-semantics',
    defaultSeverity: 'blocker',
    findingClass: 'technical-blocker',
    requires: ['effective-model', 'node-state'],
    subject: 'network',
  }),
  doctorRule({
    id: 'external-volume-missing',
    title: 'External volume not found',
    description: 'A volume declared external does not exist on the node, so the deploy fails.',
    category: 'compose-semantics',
    defaultSeverity: 'blocker',
    findingClass: 'technical-blocker',
    requires: ['effective-model', 'node-state'],
    subject: 'volume',
  }),
  doctorRule({
    id: 'new-network',
    title: 'New network will be created',
    description: 'Deploying creates a network the node does not have yet.',
    category: 'compose-semantics',
    defaultSeverity: 'info',
    findingClass: 'information',
    requires: ['effective-model', 'node-state'],
    subject: 'network',
  }),
  doctorRule({
    id: 'new-volume',
    title: 'New volume will be created',
    description: 'Deploying creates a named volume the node does not have yet.',
    category: 'compose-semantics',
    defaultSeverity: 'info',
    findingClass: 'information',
    requires: ['effective-model', 'node-state'],
    subject: 'volume',
  }),
  doctorRule({
    id: 'anonymous-volume',
    title: 'Anonymous volume in use',
    description: 'A service mounts an anonymous volume, which is easy to miss in backups and orphaned when the container is recreated.',
    category: 'mounts',
    defaultSeverity: 'info',
    findingClass: 'information',
    requires: ['effective-model'],
  }),
  doctorRule({
    id: 'container-name-internal-dup',
    title: 'Duplicate container_name',
    description: 'Two services set the same container_name, which Docker rejects because container names must be unique.',
    category: 'compose-semantics',
    defaultSeverity: 'blocker',
    findingClass: 'technical-blocker',
    requires: ['effective-model'],
    subject: 'container-name',
  }),
  doctorRule({
    id: 'container-name-collision',
    title: 'container_name already in use',
    description: 'A container_name is already used by another workload on the node, so the deploy fails with a name conflict.',
    category: 'compose-semantics',
    defaultSeverity: 'blocker',
    findingClass: 'technical-blocker',
    requires: ['effective-model', 'node-state'],
  }),
  doctorRule({
    id: 'exposure-internal-published',
    title: 'Service classified internal publishes a host port',
    description: 'A service classified internal or same-node publishes a host port, which contradicts that intent.',
    category: 'exposure',
    defaultSeverity: 'high',
    findingClass: 'exposure',
    requires: ['effective-model', 'exposure-context'],
    confidence: 'inferred',
  }),
  doctorRule({
    id: 'exposure-internal-tunneled',
    title: 'Service classified internal is reachable through a tunnel',
    description: 'A service classified internal or same-node is reachable through a tunnel connector, which contradicts that intent.',
    category: 'exposure',
    defaultSeverity: 'high',
    severities: ['high', 'warning'],
    findingClass: 'exposure',
    requires: ['effective-model', 'exposure-context'],
    confidence: 'inferred',
  }),
  doctorRule({
    id: 'sensitive-service-broad-exposure',
    title: 'Sensitive service exposed on all interfaces',
    description: 'A service that looks like a database or admin tool publishes a port on all interfaces.',
    category: 'exposure',
    defaultSeverity: 'high',
    findingClass: 'exposure',
    requires: ['effective-model'],
    confidence: 'inferred',
  }),
  doctorRule({
    id: 'tunnel-exposure',
    title: 'Tunnel connector detected',
    description: 'A tunnel connector publishes services beyond the node, so the tunnel path and its reach need review.',
    category: 'exposure',
    defaultSeverity: 'info',
    findingClass: 'information',
    affectsVerdict: false,
    requires: ['effective-model'],
  }),
  doctorRule({
    id: 'exposure-unclassified',
    title: 'Stack is reachable without an exposure intent',
    description: 'A stack that publishes host ports or is tunnel-reachable has no exposure intent, so mismatches cannot be flagged.',
    category: 'exposure',
    defaultSeverity: 'warning',
    findingClass: 'exposure',
    requires: ['effective-model', 'exposure-context'],
  }),
  doctorRule({
    id: 'exposure-port-vs-dossier',
    title: 'Published port is not in the documented access URLs',
    description: 'A published host port is not referenced by the dossier access URLs, so the documentation may be stale.',
    category: 'exposure',
    defaultSeverity: 'warning',
    findingClass: 'exposure',
    requires: ['effective-model', 'exposure-context'],
  }),
  doctorRule({
    id: 'reverse-proxy-undocumented',
    title: 'Reverse-proxy labels without a documented URL',
    description: 'A service carries reverse-proxy labels but the stack has no documented access URL or reverse-proxy intent.',
    category: 'exposure',
    defaultSeverity: 'warning',
    findingClass: 'exposure',
    requires: ['effective-model', 'exposure-context'],
  }),
  doctorRule({
    id: 'effective-model-expanded',
    title: 'Effective model adds services',
    description: 'The effective model includes services that are not in the authored file, pulled in through include, extends, or profiles.',
    category: 'compose-semantics',
    defaultSeverity: 'info',
    findingClass: 'information',
    requires: ['effective-model', 'source'],
    subject: 'stack',
  }),
  doctorRule({
    id: 'self-managed-stack',
    title: 'This stack is the running Sencho instance',
    description: 'Sencho discovered its own compose project as a managed stack, so destructive stack actions are blocked here.',
    category: 'self-protection',
    defaultSeverity: 'warning',
    findingClass: 'change-risk',
    evidenceLayers: ['runtime'],
    subject: 'stack',
  }),

  // ----- Catalog (declared, not evaluated) ----------------------------------
  catalogRule({
    id: 'broad-host-bind-mount',
    title: 'No broad host bind mounts',
    description: 'A container mounts a sensitive host path such as /, /etc, /var, or the host home directory.',
    category: 'mounts',
    defaultSeverity: 'high',
    findingClass: 'security',
    subject: 'bind',
    policyPack: ['no-broad-bind-mounts'],
  }),
  catalogRule({
    id: 'public-database-port',
    title: 'No public database ports',
    description: 'A database service publishes its port to the host instead of staying on the internal Compose network.',
    category: 'ports',
    defaultSeverity: 'high',
    findingClass: 'exposure',
    subject: 'port',
    policyPack: ['no-public-db-ports'],
  }),
  catalogRule({
    id: 'root-user',
    title: 'Run as non-root',
    description: 'A container runs as root when a non-root user is available.',
    category: 'security',
    defaultSeverity: 'warning',
    findingClass: 'security',
    policyPack: ['run-as-non-root'],
    external: [{ scanner: 'trivy', id: 'DS002', relation: 'related' }],
  }),
  catalogRule({
    id: 'plaintext-secret',
    title: 'No plaintext secrets',
    description: 'Credentials, tokens, or keys are stored alongside the stack instead of in a secret store or an excluded env file.',
    category: 'security',
    defaultSeverity: 'high',
    findingClass: 'security',
    subject: 'env-var',
    policyPack: ['no-plaintext-secrets'],
  }),
  catalogRule({
    id: 'no-resource-limits',
    title: 'Resource limits set',
    description: 'A service declares no memory or CPU limit, so it can starve every other stack on the node.',
    category: 'reliability',
    defaultSeverity: 'info',
    findingClass: 'reliability',
    policyPack: ['resource-limits'],
  }),
  catalogRule({
    id: 'image-not-digest-pinned',
    title: 'Pin image digest',
    description: 'An image is referenced by tag rather than by content digest, so it can be repointed after review.',
    category: 'reliability',
    defaultSeverity: 'info',
    findingClass: 'change-risk',
    subject: 'image',
    policyPack: ['pin-digest'],
  }),
  catalogRule({
    id: 'writable-root-filesystem',
    title: 'Read-only root filesystem',
    description: 'A container keeps a writable root filesystem, which lets an attacker drop tools or persist inside it.',
    category: 'security',
    defaultSeverity: 'warning',
    findingClass: 'security',
    policyPack: ['read-only-rootfs'],
  }),
  catalogRule({
    id: 'default-capabilities',
    title: 'Drop unnecessary capabilities',
    description: 'A container keeps the default Linux capability set instead of dropping what it does not use.',
    category: 'security',
    defaultSeverity: 'warning',
    findingClass: 'security',
    policyPack: ['drop-capabilities'],
  }),
];

const BY_ID = new Map<string, AssuranceRule>(ASSURANCE_RULES.map(rule => [rule.id, rule]));

const POLICY_PACK_INDEX = new Map<string, CanonicalRuleId>();
const EXTERNAL_INDEX = new Map<string, { ruleId: CanonicalRuleId; relation: ExternalAlias['relation'] }>();
const ORDER = new Map<string, number>(ASSURANCE_RULES.map((rule, i) => [rule.id, i]));

function aliasKey(scanner: string, id: string): string {
  return `${scanner}:${id}`;
}

for (const rule of ASSURANCE_RULES) {
  for (const alias of rule.aliases.policyPack) {
    if (BY_ID.has(alias)) throw new Error(`Assurance alias "${alias}" collides with a canonical rule id`);
    const existing = POLICY_PACK_INDEX.get(alias);
    if (existing !== undefined) throw new Error(`Assurance policy-pack alias "${alias}" is claimed by ${existing} and ${rule.id}`);
    POLICY_PACK_INDEX.set(alias, rule.id);
  }
  for (const alias of rule.aliases.external) {
    const key = aliasKey(alias.scanner, alias.id);
    if (EXTERNAL_INDEX.has(key)) throw new Error(`Assurance external alias "${key}" is claimed more than once`);
    EXTERNAL_INDEX.set(key, { ruleId: rule.id, relation: alias.relation });
  }
}

export function getAssuranceRule(id: string): AssuranceRule | undefined {
  return BY_ID.get(id);
}

/** Registry position, for deterministic ordering within a severity group. */
export function assuranceRuleOrder(id: string): number {
  return ORDER.get(id) ?? Number.MAX_SAFE_INTEGER;
}

/** The rules the Compose Doctor runner evaluates, in registry order. */
export const COMPOSE_DOCTOR_RULES: readonly AssuranceRule[] = ASSURANCE_RULES.filter(
  rule => rule.status === 'active' && rule.engine === 'compose-doctor',
);

/** Note rules: shown for context, excluded from All Clear, severity, and readiness. */
export const PREFLIGHT_NOTE_RULES: readonly AssuranceRule[] = COMPOSE_DOCTOR_RULES.filter(rule => !rule.affectsVerdict);

/** The pack id a canonical rule is exposed under, when a pack references it. */
export function policyPackIdForRule(id: CanonicalRuleId): string | undefined {
  return getAssuranceRule(id)?.aliases.policyPack[0];
}

export function canonicalRuleForPolicyPackAlias(alias: string): CanonicalRuleId | undefined {
  return POLICY_PACK_INDEX.get(alias);
}

export function canonicalRuleForExternalAlias(
  scanner: 'trivy',
  id: string,
): { ruleId: CanonicalRuleId; relation: ExternalAlias['relation'] } | undefined {
  return EXTERNAL_INDEX.get(aliasKey(scanner, id));
}

/** Every external alias, for the docs and the alias tests. */
export const EXTERNAL_ALIASES: readonly (ExternalAlias & { ruleId: CanonicalRuleId })[] = ASSURANCE_RULES.flatMap(
  rule => rule.aliases.external.map(alias => ({ ...alias, ruleId: rule.id })),
);
