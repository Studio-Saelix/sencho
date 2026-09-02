// Generates the tables in docs/features/git-transport-support.mdx from
// docs/git-transport-support.yaml.
//
// Everything between the GENERATED markers is produced here; the rest of the
// MDX file (intro prose, the "How these claims are verified" section) is
// hand-written and left untouched. The validator (git-support-matrix.test.ts)
// imports renderFullMdx and asserts the committed file is byte-identical to
// what it produces, so the page can never silently drift from the YAML.
const fs = require('fs');
const { loadClaimSet, MDX_PATH } = require('./loadClaimSet');

const MARKER_BEGIN = '<!-- GENERATED:BEGIN (run `npm run matrix:render` in backend/ to regenerate, do not edit by hand) -->';
const MARKER_END = '<!-- GENERATED:END -->';

const TRANSPORT_LABELS = { https: 'HTTPS', ssh: 'SSH' };
const TRANSPORT_NOTES = {
    https: 'Personal Access Token for private repositories, or no credential at all for public ones. TLS verification uses the system trust store by default, or a per-source custom CA when configured.',
    ssh: 'A read-only deploy key with strict host-key verification. Standard (22) and nonstandard ports are both supported.',
};

const REF_LABELS = { branch: 'Branch', tag: 'Tag', sha: 'Commit SHA' };
const REF_NOTES = {
    branch: 'Tracks the head of a branch; each pull resolves and pins the exact commit.',
    tag: 'Both annotated and lightweight tags resolve to their target commit.',
    sha: 'A full commit SHA is pinned directly; the Git host must advertise the commit on some branch or tag.',
};

const AUTH_LABELS = { none: 'Public (no auth)', pat: 'Personal Access Token', 'deploy-key': 'SSH deploy key' };
const AUTH_NOTES = {
    none: 'For public repositories.',
    pat: 'Stored encrypted at rest, never returned after save.',
    'deploy-key': 'Stored encrypted at rest; the server host key is verified on every fetch.',
};

const CA_LABELS = { system: 'System trust (default)', 'per-source': 'Per-source custom CA', 'not-applicable': 'Not applicable' };
const CA_NOTES = {
    system: 'The host running the fetch trusts its system certificate store.',
    'per-source': "Combined with the system trust anchors, so public hosts keep validating normally. Redirects are re-resolved and only followed when they stay on the source's own host.",
    'not-applicable': 'SSH uses host-key verification instead of TLS certificate trust.',
};

const HOST_LABELS = {
    generic: 'Generic (self-hosted or any Git server)',
    github: 'GitHub',
    gitlab: 'GitLab',
    gitea: 'Gitea',
    forgejo: 'Forgejo',
    bitbucket: 'Bitbucket',
};
const HOST_ORDER = ['generic', 'github', 'gitlab', 'gitea', 'forgejo', 'bitbucket'];

const STATUS_LABELS = { supported: 'Supported', unsupported: 'Not supported', unverified: 'Not yet verified' };

function aggregateStatus(claims) {
    if (claims.length === 0) return 'unverified';
    if (claims.some((c) => c.support === 'unsupported')) return 'unsupported';
    if (claims.some((c) => c.support === 'supported')) return 'supported';
    return 'unverified';
}

function evidenceSummary(claims, attestationsById) {
    const kinds = new Set();
    let latestDate = null;
    for (const c of claims) {
        if (c.support !== 'supported' || !c.evidence) continue;
        if (c.evidence.kind === 'automated') kinds.add('automated');
        if (c.evidence.kind === 'live') {
            kinds.add('live');
            const att = attestationsById.get(c.evidence.attestation);
            if (att && (!latestDate || att.date > latestDate)) latestDate = att.date;
        }
    }
    if (kinds.size === 0) return 'Pending';
    if (kinds.has('automated') && kinds.has('live')) return `Automated, every change; live as of ${latestDate}`;
    if (kinds.has('automated')) return 'Automated, every change';
    return `Live, ${latestDate}`;
}

function table(headers, rows) {
    const sep = headers.map(() => '---');
    return [
        `| ${headers.join(' | ')} |`,
        `| ${sep.join(' | ')} |`,
        ...rows.map((r) => `| ${r.join(' | ')} |`),
    ].join('\n');
}

function renderTransports(claims) {
    const rows = Object.keys(TRANSPORT_LABELS).map((t) => {
        const group = claims.filter((c) => c.transport === t);
        return [TRANSPORT_LABELS[t], STATUS_LABELS[aggregateStatus(group)], TRANSPORT_NOTES[t]];
    });
    return ['## Transports', '', table(['Transport', 'Status', 'Notes'], rows)].join('\n');
}

function renderRefs(claims) {
    const rows = Object.keys(REF_LABELS).map((r) => {
        const group = claims.filter((c) => c.ref === r);
        return [REF_LABELS[r], STATUS_LABELS[aggregateStatus(group)], REF_NOTES[r]];
    });
    return ['## Reference types', '', table(['Reference type', 'Status', 'Notes'], rows)].join('\n');
}

function renderAuth(claims) {
    const rows = Object.keys(AUTH_LABELS).map((a) => {
        const group = claims.filter((c) => c.auth === a);
        return [AUTH_LABELS[a], STATUS_LABELS[aggregateStatus(group)], AUTH_NOTES[a]];
    });
    return ['## Authentication', '', table(['Method', 'Status', 'Notes'], rows)].join('\n');
}

const CA_TABLE_MODES = ['system', 'per-source'];

function renderCa(claims) {
    const rows = CA_TABLE_MODES.map((c) => {
        const group = claims.filter((claim) => claim.ca === c);
        return [CA_LABELS[c], STATUS_LABELS[aggregateStatus(group)], CA_NOTES[c]];
    });
    return ['## TLS and certificate authorities', '', table(['Mode', 'Status', 'Notes'], rows)].join('\n');
}

function renderHosts(claims, attestationsById) {
    const rows = HOST_ORDER.map((host) => {
        const group = claims.filter((c) => c.host === host);
        const httpsGroup = group.filter((c) => c.transport === 'https');
        const sshGroup = group.filter((c) => c.transport === 'ssh');
        const branchGroup = group.filter((c) => c.ref === 'branch');
        const tagGroup = group.filter((c) => c.ref === 'tag');
        const shaGroup = group.filter((c) => c.ref === 'sha');
        return [
            HOST_LABELS[host],
            STATUS_LABELS[aggregateStatus(httpsGroup)],
            STATUS_LABELS[aggregateStatus(sshGroup)],
            STATUS_LABELS[aggregateStatus(branchGroup)],
            STATUS_LABELS[aggregateStatus(tagGroup)],
            STATUS_LABELS[aggregateStatus(shaGroup)],
            evidenceSummary(group, attestationsById),
        ];
    });
    return [
        '## Git hosts',
        '',
        table(['Host', 'HTTPS', 'SSH', 'Branch', 'Tag', 'Commit SHA', 'Evidence'], rows),
    ].join('\n');
}

function renderLimitations(limitations) {
    const bullets = limitations.map((l) => `- **${l.title}.** ${l.statement}`);
    return ['## Not supported', '', ...bullets].join('\n');
}

function renderGeneratedBlock(data) {
    const { support, attestations } = data;
    const attestationsById = new Map((attestations.attestations || []).map((a) => [a.id, a]));
    const claims = support.claims;
    return [
        renderTransports(claims),
        '',
        renderRefs(claims),
        '',
        renderAuth(claims),
        '',
        renderHosts(claims, attestationsById),
        '',
        renderCa(claims),
        '',
        renderLimitations(support.limitations),
    ].join('\n');
}

function renderFullMdx() {
    const data = loadClaimSet();
    const generated = renderGeneratedBlock(data);
    const current = fs.readFileSync(MDX_PATH, 'utf8');

    const beginIdx = current.indexOf(MARKER_BEGIN);
    const endIdx = current.indexOf(MARKER_END);
    if (beginIdx === -1 || endIdx === -1 || endIdx < beginIdx) {
        throw new Error(`${MDX_PATH} is missing the GENERATED markers, or they are out of order.`);
    }

    const before = current.slice(0, beginIdx + MARKER_BEGIN.length);
    const after = current.slice(endIdx);
    return `${before}\n\n${generated}\n\n${after}`;
}

if (require.main === module) {
    const rendered = renderFullMdx();
    fs.writeFileSync(MDX_PATH, rendered, 'utf8');
    console.log(`[matrix:render] Wrote ${MDX_PATH}`);
}

module.exports = {
    MARKER_BEGIN,
    MARKER_END,
    renderGeneratedBlock,
    renderFullMdx,
    aggregateStatus,
};
