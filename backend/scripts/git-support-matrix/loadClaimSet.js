// Shared YAML loader for the Git transport support matrix.
//
// Used by both render.js (the CLI/build-time generator) and
// git-support-matrix.test.ts (the validator), so the two never parse the
// source files differently.
const fs = require('fs');
const path = require('path');
const { parse } = require('yaml');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const SUPPORT_YAML_PATH = path.join(REPO_ROOT, 'docs', 'git-transport-support.yaml');
const ATTESTATIONS_YAML_PATH = path.join(REPO_ROOT, 'docs', 'git-transport-attestations.yaml');
const MDX_PATH = path.join(REPO_ROOT, 'docs', 'features', 'git-transport-support.mdx');

function loadClaimSet() {
    const supportRaw = fs.readFileSync(SUPPORT_YAML_PATH, 'utf8');
    const attestationsRaw = fs.readFileSync(ATTESTATIONS_YAML_PATH, 'utf8');
    return {
        support: parse(supportRaw),
        attestations: parse(attestationsRaw),
    };
}

module.exports = {
    REPO_ROOT,
    SUPPORT_YAML_PATH,
    ATTESTATIONS_YAML_PATH,
    MDX_PATH,
    loadClaimSet,
};
