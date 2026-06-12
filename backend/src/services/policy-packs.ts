import type { VulnSeverity } from './DatabaseService';

/**
 * Static, read-only policy-pack catalog.
 *
 * Policy packs are curated bundles of security expectations for a deployment
 * posture (homelab, production, public edge, ...). This module is the single
 * source of truth for the catalog: it has no database, no I/O, and no
 * enforcement wiring. The Security page renders it as an educational reference
 * so operators can understand what good looks like for their environment.
 *
 * Each rule carries a stable id, a severity, plain-language explanations
 * (what it checks, why it matters, how to fix), and an `enforcement` marker.
 * `warning` rules are advisory; `enforceable` rules are the ones a future
 * enforcement phase can promote into a block-on-deploy scan policy. The marker
 * is metadata only here: nothing in this module blocks a deploy.
 */

export type PolicyRuleEnforcement = 'warning' | 'enforceable';

export interface PolicyPackRule {
    /** Stable identifier for the rule within the catalog. */
    id: string;
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

/**
 * Canonical rule definitions, keyed by id. Packs reference these so the
 * what/why/how copy stays consistent everywhere a rule appears; each pack
 * sets its own `enforcement` level for the rule.
 */
type RuleDefinition = Omit<PolicyPackRule, 'enforcement'>;

const RULE_CATALOG = {
    'no-privileged': {
        id: 'no-privileged',
        name: 'No privileged containers',
        severity: 'CRITICAL',
        whatItChecks: 'Services that set privileged: true.',
        why: 'A privileged container can access all host devices and effectively escape isolation, so a single compromised service can take over the host.',
        howToFix: 'Remove privileged: true and grant only the specific capabilities or device mounts the workload actually needs.',
    },
    'no-docker-socket': {
        id: 'no-docker-socket',
        name: 'No Docker socket mounts',
        severity: 'CRITICAL',
        whatItChecks: 'Bind mounts of /var/run/docker.sock into a container.',
        why: 'Access to the Docker socket is equivalent to root on the host: the container can start new privileged containers or read every other stack.',
        howToFix: 'Drop the socket mount. Where a tool genuinely needs Docker access, use a scoped proxy with a read-only, filtered API surface.',
    },
    'no-host-network': {
        id: 'no-host-network',
        name: 'No host networking',
        severity: 'HIGH',
        whatItChecks: 'Services using network_mode: host.',
        why: 'Host networking removes network namespace isolation, exposes every container port on the host directly, and bypasses Compose network segmentation.',
        howToFix: 'Use a bridge network and publish only the ports you need with explicit port mappings.',
    },
    'no-broad-bind-mounts': {
        id: 'no-broad-bind-mounts',
        name: 'No broad host bind mounts',
        severity: 'HIGH',
        whatItChecks: 'Bind mounts of sensitive host paths such as /, /etc, /var, or the host home directory.',
        why: 'Mounting broad host paths lets a container read or modify host configuration and other services data, widening the blast radius of a compromise.',
        howToFix: 'Mount only the specific subdirectory the service needs, and prefer named volumes for persistent data.',
    },
    'healthcheck-defined': {
        id: 'healthcheck-defined',
        name: 'Healthcheck defined',
        severity: 'MEDIUM',
        whatItChecks: 'Services that declare no healthcheck.',
        why: 'Without a healthcheck the orchestrator cannot tell a hung container from a healthy one, so failures go unnoticed and dependent services start too early.',
        howToFix: 'Add a healthcheck with a command that reflects real readiness, plus sensible interval, timeout, and retries.',
    },
    'no-public-db-ports': {
        id: 'no-public-db-ports',
        name: 'No public database ports',
        severity: 'HIGH',
        whatItChecks: 'Database services that publish their port to the host (for example 5432, 3306, 27017, 6379).',
        why: 'Publishing a database port exposes it to anything that can reach the host, a common path to data theft on internet-adjacent machines.',
        howToFix: 'Remove the host port mapping and let other services reach the database over the internal Compose network instead.',
    },
    'run-as-non-root': {
        id: 'run-as-non-root',
        name: 'Run as non-root',
        severity: 'MEDIUM',
        whatItChecks: 'Containers that run as root when a non-root user is available.',
        why: 'Running as root raises the impact of a container breakout and of any write to a mounted host path.',
        howToFix: 'Set a non-root user with the user directive, or use an image that ships a dedicated runtime user.',
    },
    'pin-image-tag': {
        id: 'pin-image-tag',
        name: 'Pin image tags',
        severity: 'LOW',
        whatItChecks: 'Images referenced by the latest tag or with no tag at all.',
        why: 'A floating tag makes deploys non-reproducible: the same Compose file can pull different code on different days, including a regressed or compromised build.',
        howToFix: 'Pin a specific version tag, and pin a digest for the strongest guarantee.',
    },
    'restart-policy': {
        id: 'restart-policy',
        name: 'Restart policy set',
        severity: 'LOW',
        whatItChecks: 'Services with no restart policy.',
        why: 'Without a restart policy a crashed service stays down until someone notices, which turns a transient fault into an outage.',
        howToFix: 'Set restart: unless-stopped (or on-failure) so the service recovers from crashes and host reboots.',
    },
    'no-plaintext-secrets': {
        id: 'no-plaintext-secrets',
        name: 'No plaintext secrets',
        severity: 'HIGH',
        whatItChecks: 'Credentials, tokens, or keys detected in Compose files, env values, or image layers.',
        why: 'Secrets committed alongside a stack leak through backups, version control, and image registries, and are trivial to extract from a pulled image.',
        howToFix: 'Move secrets into an .env file kept out of version control, or a secrets manager, and reference them by variable.',
    },
    'resource-limits': {
        id: 'resource-limits',
        name: 'Resource limits set',
        severity: 'LOW',
        whatItChecks: 'Services with no memory or CPU limits.',
        why: 'An unbounded service can exhaust host memory or CPU and starve every other stack on the node.',
        howToFix: 'Set memory and CPU limits sized to the workload so one service cannot monopolize the host.',
    },
    'pin-digest': {
        id: 'pin-digest',
        name: 'Pin image digest',
        severity: 'LOW',
        whatItChecks: 'Images that are not pinned to a content digest.',
        why: 'A tag can be repointed at a different image after you have reviewed it; a digest is immutable and guarantees you run exactly what you vetted.',
        howToFix: 'Reference the image by digest (image@sha256:...) for workloads that need supply-chain certainty.',
    },
    'read-only-rootfs': {
        id: 'read-only-rootfs',
        name: 'Read-only root filesystem',
        severity: 'MEDIUM',
        whatItChecks: 'Containers whose root filesystem is writable.',
        why: 'A writable root filesystem lets an attacker drop tools or persist a foothold inside the container.',
        howToFix: 'Set read_only: true and mount tmpfs or named volumes for the few paths that must be writable.',
    },
    'drop-capabilities': {
        id: 'drop-capabilities',
        name: 'Drop unnecessary capabilities',
        severity: 'MEDIUM',
        whatItChecks: 'Containers that keep the default Linux capability set instead of dropping what they do not use.',
        why: 'Extra capabilities give a compromised process more ways to affect the host than the workload actually requires.',
        howToFix: 'Drop ALL capabilities and add back only the ones the service needs (cap_drop / cap_add).',
    },
} satisfies Record<string, RuleDefinition>;

// Closed set of rule ids derived from the catalog. Typing `rule()` against this
// turns a mistyped or deleted id into a compile error instead of a runtime throw.
type RuleId = keyof typeof RULE_CATALOG;

function rule(id: RuleId, enforcement: PolicyRuleEnforcement): PolicyPackRule {
    return { ...RULE_CATALOG[id], enforcement };
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
            rule('no-plaintext-secrets', 'warning'),
            rule('pin-image-tag', 'warning'),
            rule('run-as-non-root', 'warning'),
            rule('restart-policy', 'warning'),
        ],
    },
    {
        id: 'production-hardening',
        name: 'Production hardening',
        tagline: 'Sensible hardening for services that face real traffic.',
        tierCopy: 'Warns on risky exposure, missing healthchecks, and the highest-impact misconfigurations.',
        rules: [
            rule('no-privileged', 'enforceable'),
            rule('no-docker-socket', 'enforceable'),
            rule('no-plaintext-secrets', 'enforceable'),
            rule('no-host-network', 'warning'),
            rule('healthcheck-defined', 'warning'),
            rule('drop-capabilities', 'warning'),
            rule('read-only-rootfs', 'warning'),
            rule('pin-image-tag', 'warning'),
        ],
    },
    {
        id: 'strict-production',
        name: 'Strict production',
        tagline: 'Zero-tolerance posture for critical workloads.',
        tierCopy: 'The strictest baseline, intended for workloads where reproducibility and isolation are non-negotiable.',
        rules: [
            rule('no-privileged', 'enforceable'),
            rule('no-docker-socket', 'enforceable'),
            rule('no-host-network', 'enforceable'),
            rule('no-broad-bind-mounts', 'enforceable'),
            rule('no-plaintext-secrets', 'enforceable'),
            rule('run-as-non-root', 'enforceable'),
            rule('healthcheck-defined', 'enforceable'),
            rule('resource-limits', 'enforceable'),
            rule('pin-digest', 'enforceable'),
        ],
    },
    {
        id: 'public-edge',
        name: 'Public edge service',
        tagline: 'Focused on services exposed to the public internet.',
        tierCopy: 'Emphasizes secret leakage, exposed ports, and the misconfigurations that matter most at the edge.',
        rules: [
            rule('no-plaintext-secrets', 'enforceable'),
            rule('no-public-db-ports', 'enforceable'),
            rule('no-host-network', 'enforceable'),
            rule('no-privileged', 'enforceable'),
            rule('healthcheck-defined', 'warning'),
            rule('pin-image-tag', 'warning'),
        ],
    },
    {
        id: 'internal-service',
        name: 'Internal service',
        tagline: 'Least-privilege defaults for east-west internal services.',
        tierCopy: 'Avoids public exposure and broad host access while keeping internal services easy to run.',
        rules: [
            rule('no-public-db-ports', 'warning'),
            rule('no-broad-bind-mounts', 'warning'),
            rule('run-as-non-root', 'warning'),
            rule('drop-capabilities', 'warning'),
            rule('resource-limits', 'warning'),
            rule('pin-image-tag', 'warning'),
        ],
    },
]);
