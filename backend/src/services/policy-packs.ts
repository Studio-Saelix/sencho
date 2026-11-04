import type { VulnSeverity } from './DatabaseService';
import type { CanonicalRuleId } from './assurance/types';
import { getAssuranceRule, policyPackIdForRule } from './assurance/ruleRegistry';

/**
 * Static, read-only policy-pack catalog.
 *
 * Policy packs are curated bundles of security expectations for a deployment
 * posture (homelab, production, public edge, ...). This module is the single
 * source of truth for the catalog: it has no database, no I/O, and no
 * enforcement wiring. The Security page renders it as an educational reference
 * so operators can understand what good looks like for their environment.
 *
 * Rule identity comes from the Compose Assurance registry: each pack rule is
 * built from a canonical id, and its pack id is the registry's policy-pack
 * alias for that rule. This module keeps only the pack's own surface copy (what
 * it checks, why it matters, how to fix it, and the pack's severity), so a pack
 * can never invent a rule the registry does not know, and Security, Doctor, and
 * Networking can join on `canonicalRuleId` without a second mapping.
 *
 * `warning` rules are advisory; `enforceable` rules are the ones a future
 * enforcement phase can promote into a block-on-deploy scan policy. The marker
 * is metadata only here: nothing in this module blocks a deploy.
 */

export type PolicyRuleEnforcement = 'warning' | 'enforceable';

export interface PolicyPackRule {
    /** The pack-facing id: the registry's policy-pack alias for this rule. */
    id: string;
    /** The canonical rule this pack rule evaluates. */
    canonicalRuleId: CanonicalRuleId;
    name: string;
    severity: Exclude<VulnSeverity, 'UNKNOWN'>;
    /** What the rule inspects in a Compose stack or image. */
    whatItChecks: string;
    /** Why the check matters for security or reliability. */
    why: string;
    /** Concrete remediation guidance. */
    howToFix: string;
    /** Advisory (`warning`) or promotable to a block-on-deploy policy (`enforceable`). */
    enforcement: PolicyRuleEnforcement;
}

export interface PolicyPack {
    /** Stable identifier for the pack. */
    id: string;
    name: string;
    /** One-line description of the posture the pack targets. */
    tagline: string;
    /** Descriptive copy about how the pack is meant to be used. */
    tierCopy: string;
    rules: PolicyPackRule[];
}

/** The pack's own copy for a canonical rule. */
type RuleCopy = Omit<PolicyPackRule, 'id' | 'canonicalRuleId' | 'enforcement'>;

/**
 * Pack copy, keyed by canonical rule id. Every entry must have exactly one
 * policy-pack alias in the registry; `rule()` fails loudly at module load when
 * it does not, so a pack cannot reference a rule no surface can evaluate or
 * report.
 */
const RULE_CATALOG: Partial<Record<CanonicalRuleId, RuleCopy>> = {
    'privileged': {
        name: 'No privileged containers',
        severity: 'CRITICAL',
        whatItChecks: 'Services that set privileged: true.',
        why: 'A privileged container can access all host devices and effectively escape isolation, so a single compromised service can take over the host.',
        howToFix: 'Remove privileged: true and grant only the specific capabilities or device mounts the workload actually needs.',
    },
    'docker-socket-mount': {
        name: 'No Docker socket mounts',
        severity: 'CRITICAL',
        whatItChecks: 'Bind mounts of /var/run/docker.sock into a container.',
        why: 'Access to the Docker socket is equivalent to root on the host: the container can start new privileged containers or read every other stack.',
        howToFix: 'Drop the socket mount. Where a tool genuinely needs Docker access, use a scoped proxy with a read-only, filtered API surface.',
    },
    'network-mode-host': {
        name: 'No host networking',
        severity: 'HIGH',
        whatItChecks: 'Services using network_mode: host.',
        why: 'Host networking removes network namespace isolation, exposes every container port on the host directly, and bypasses Compose network segmentation.',
        howToFix: 'Use a bridge network and publish only the ports you need with explicit port mappings.',
    },
    'broad-host-bind-mount': {
        name: 'No broad host bind mounts',
        severity: 'HIGH',
        whatItChecks: 'Bind mounts of sensitive host paths such as /, /etc, /var, or the host home directory.',
        why: 'Mounting broad host paths lets a container read or modify host configuration and other services data, widening the blast radius of a compromise.',
        howToFix: 'Mount only the specific subdirectory the service needs, and prefer named volumes for persistent data.',
    },
    'no-healthcheck': {
        name: 'Healthcheck defined',
        severity: 'MEDIUM',
        whatItChecks: 'Services that declare no healthcheck.',
        why: 'Without a healthcheck the orchestrator cannot tell a hung container from a healthy one, so failures go unnoticed and dependent services start too early.',
        howToFix: 'Add a healthcheck with a command that reflects real readiness, plus sensible interval, timeout, and retries.',
    },
    'public-database-port': {
        name: 'No public database ports',
        severity: 'HIGH',
        whatItChecks: 'Database services that publish their port to the host (for example 5432, 3306, 27017, 6379).',
        why: 'Publishing a database port exposes it to anything that can reach the host, a common path to data theft on internet-adjacent machines.',
        howToFix: 'Remove the host port mapping and let other services reach the database over the internal Compose network instead.',
    },
    'root-user': {
        name: 'Run as non-root',
        severity: 'MEDIUM',
        whatItChecks: 'Containers that run as root when a non-root user is available.',
        why: 'Running as root raises the impact of a container breakout and of any write to a mounted host path.',
        howToFix: 'Set a non-root user with the user directive, or use an image that ships a dedicated runtime user.',
    },
    'image-latest': {
        name: 'Pin image tags',
        severity: 'LOW',
        whatItChecks: 'Images referenced by the latest tag or with no tag at all.',
        why: 'A floating tag makes deploys non-reproducible: the same Compose file can pull different code on different days, including a regressed or compromised build.',
        howToFix: 'Pin a specific version tag, and pin a digest for the strongest guarantee.',
    },
    'no-restart-policy': {
        name: 'Restart policy set',
        severity: 'LOW',
        whatItChecks: 'Services with no restart policy.',
        why: 'Without a restart policy a crashed service stays down until someone notices, which turns a transient fault into an outage.',
        howToFix: 'Set restart: unless-stopped (or on-failure) so the service recovers from crashes and host reboots.',
    },
    'plaintext-secret': {
        name: 'No plaintext secrets',
        severity: 'HIGH',
        whatItChecks: 'Credentials, tokens, or keys detected in Compose files, env values, or image layers.',
        why: 'Secrets committed alongside a stack leak through backups, version control, and image registries, and are trivial to extract from a pulled image.',
        howToFix: 'Move secrets into an .env file kept out of version control, or a secrets manager, and reference them by variable.',
    },
    'no-resource-limits': {
        name: 'Resource limits set',
        severity: 'LOW',
        whatItChecks: 'Services with no memory or CPU limits.',
        why: 'An unbounded service can exhaust host memory or CPU and starve every other stack on the node.',
        howToFix: 'Set memory and CPU limits sized to the workload so one service cannot monopolize the host.',
    },
    'image-not-digest-pinned': {
        name: 'Pin image digest',
        severity: 'LOW',
        whatItChecks: 'Images that are not pinned to a content digest.',
        why: 'A tag can be repointed at a different image after you have reviewed it; a digest is immutable and guarantees you run exactly what you vetted.',
        howToFix: 'Reference the image by digest (image@sha256:...) for workloads that need supply-chain certainty.',
    },
    'writable-root-filesystem': {
        name: 'Read-only root filesystem',
        severity: 'MEDIUM',
        whatItChecks: 'Containers whose root filesystem is writable.',
        why: 'A writable root filesystem lets an attacker drop tools or persist a foothold inside the container.',
        howToFix: 'Set read_only: true and mount tmpfs or named volumes for the few paths that must be writable.',
    },
    'default-capabilities': {
        name: 'Drop unnecessary capabilities',
        severity: 'MEDIUM',
        whatItChecks: 'Containers that keep the default Linux capability set instead of dropping what they do not use.',
        why: 'Extra capabilities give a compromised process more ways to affect the host than the workload actually requires.',
        howToFix: 'Drop ALL capabilities and add back only the ones the service needs (cap_drop / cap_add).',
    },
};

/** Build a pack rule from its canonical rule. Throws at module load when the
 *  registry has no pack alias for it, so the mismatch cannot ship. */
function rule(canonicalRuleId: CanonicalRuleId, enforcement: PolicyRuleEnforcement): PolicyPackRule {
    const copy = RULE_CATALOG[canonicalRuleId];
    const id = policyPackIdForRule(canonicalRuleId);
    if (!copy || !id || !getAssuranceRule(canonicalRuleId)) {
        throw new Error(`Policy pack rule ${canonicalRuleId} has no registry entry with a policy-pack alias`);
    }
    return { id, canonicalRuleId, ...copy, enforcement };
}

/**
 * The default catalog. Frozen so callers cannot mutate the shared definitions.
 * Order is intentional: gentlest posture first, strictest last.
 */
export const DEFAULT_POLICY_PACKS: readonly PolicyPack[] = Object.freeze([
    {
        id: 'homelab-baseline',
        name: 'Homelab baseline',
        tagline: 'Gentle defaults for a single-operator homelab.',
        tierCopy: 'Advisory guidance that flags the few habits worth keeping without getting in your way.',
        rules: [
            rule('plaintext-secret', 'warning'),
            rule('image-latest', 'warning'),
            rule('root-user', 'warning'),
            rule('no-restart-policy', 'warning'),
        ],
    },
    {
        id: 'production-hardening',
        name: 'Production hardening',
        tagline: 'Sensible hardening for services that face real traffic.',
        tierCopy: 'Warns on risky exposure, missing healthchecks, and the highest-impact misconfigurations.',
        rules: [
            rule('privileged', 'enforceable'),
            rule('docker-socket-mount', 'enforceable'),
            rule('plaintext-secret', 'enforceable'),
            rule('network-mode-host', 'warning'),
            rule('no-healthcheck', 'warning'),
            rule('default-capabilities', 'warning'),
            rule('writable-root-filesystem', 'warning'),
            rule('image-latest', 'warning'),
        ],
    },
    {
        id: 'strict-production',
        name: 'Strict production',
        tagline: 'Zero-tolerance posture for critical workloads.',
        tierCopy: 'The strictest baseline, intended for workloads where reproducibility and isolation are non-negotiable.',
        rules: [
            rule('privileged', 'enforceable'),
            rule('docker-socket-mount', 'enforceable'),
            rule('network-mode-host', 'enforceable'),
            rule('broad-host-bind-mount', 'enforceable'),
            rule('plaintext-secret', 'enforceable'),
            rule('root-user', 'enforceable'),
            rule('no-healthcheck', 'enforceable'),
            rule('no-resource-limits', 'enforceable'),
            rule('image-not-digest-pinned', 'enforceable'),
        ],
    },
    {
        id: 'public-edge',
        name: 'Public edge service',
        tagline: 'Focused on services exposed to the public internet.',
        tierCopy: 'Emphasizes secret leakage, exposed ports, and the misconfigurations that matter most at the edge.',
        rules: [
            rule('plaintext-secret', 'enforceable'),
            rule('public-database-port', 'enforceable'),
            rule('network-mode-host', 'enforceable'),
            rule('privileged', 'enforceable'),
            rule('no-healthcheck', 'warning'),
            rule('image-latest', 'warning'),
        ],
    },
    {
        id: 'internal-service',
        name: 'Internal service',
        tagline: 'Least-privilege defaults for east-west internal services.',
        tierCopy: 'Avoids public exposure and broad host access while keeping internal services easy to run.',
        rules: [
            rule('public-database-port', 'warning'),
            rule('broad-host-bind-mount', 'warning'),
            rule('root-user', 'warning'),
            rule('default-capabilities', 'warning'),
            rule('no-resource-limits', 'warning'),
            rule('image-latest', 'warning'),
        ],
    },
]);
