#!/usr/bin/env node
/**
 * Sencho tier-reconciliation: website drift detector
 * Compares the current canonical catalog to the website's committed
 * catalog-snapshot. Drift identity is the normalized content checksum.
 * Commit SHA is NOT part of drift identity.
 *
 * Usage:
 *   node scripts/website-catalog/check-website-drift.mjs --website-dir <path>
 *   node scripts/website-catalog/check-website-drift.mjs --website-ref <git-ref>
 */
import yaml from 'js-yaml';
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import os from 'os';
import { createHash } from 'crypto';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CANONICAL_FILE = path.resolve(__dirname, '../../docs/feature-catalog.yaml');
const PUBLIC_FIELDS = new Set([
  'id', 'publicName', 'summary', 'description', 'category',
  'tier', 'availability', 'featured', 'homepageOrder', 'publicRoadmapKey',
]);

function normalizeYaml(obj) {
  return yaml.dump(obj, { sortKeys: true, lineWidth: -1 });
}

function computeChecksum(content) {
  return createHash('sha256').update(content).digest('hex');
}

function loadSnapshot(websiteDir) {
  const snapshotPath = path.join(websiteDir, 'src/data/catalog-snapshot.yaml');
  if (!fs.existsSync(snapshotPath)) {
    return null;
  }
  const text = fs.readFileSync(snapshotPath, 'utf8');
  const doc = yaml.load(text, { schema: yaml.CORE_SCHEMA });
  if (!doc || !Array.isArray(doc.entries)) return null;
  return { doc, text, snapshotPath };
}

function buildProjection(canonical) {
  return canonical.entries
    .filter((e) => e.tier !== 'internal' && e.availability !== 'internal')
    .map((e) => {
      const pub = {};
      for (const key of PUBLIC_FIELDS) {
        if (key in e) pub[key] = e[key];
      }
      return pub;
    });
}

function main() {
  const args = process.argv.slice(2);
  let websiteDir = null;
  let websiteRef = null;
  let cleanup = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--website-dir' && args[i + 1]) {
      websiteDir = args[i + 1]; i++;
    } else if (args[i] === '--website-ref' && args[i + 1]) {
      websiteRef = args[i + 1]; i++;
    }
  }

  if (websiteRef && !websiteDir) {
    // Clone to temp dir
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sencho-website-'));
    execFileSync('git', ['clone', '--depth', '1', '--branch', websiteRef,
      'https://github.com/Studio-Saelix/sencho-website.git', tmp],
      { stdio: 'pipe' });
    websiteDir = tmp;
    cleanup = tmp;
  }

  if (!websiteDir) {
    console.error('ERROR: --website-dir or --website-ref is required');
    process.exit(1);
  }

  // Read canonical catalog.
  const canonicalText = fs.readFileSync(CANONICAL_FILE, 'utf8');
  const canonical = yaml.load(canonicalText, { schema: yaml.CORE_SCHEMA });
  const projection = buildProjection(canonical);
  const projectionText = normalizeYaml({ entries: projection });
  const currentChecksum = computeChecksum(projectionText);

  // Read committed snapshot.
  const snap = loadSnapshot(websiteDir);
  if (!snap) {
    console.error(`FAIL: no catalog-snapshot.yaml at ${path.join(websiteDir, 'src/data/')}`);
    if (cleanup) fs.rmSync(cleanup, { recursive: true, force: true });
    process.exit(1);
  }

  const metaPath = path.join(websiteDir, 'src/data/catalog-snapshot.meta.json');
  let committedChecksum = null;
  if (fs.existsSync(metaPath)) {
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      committedChecksum = meta.checksum;
    } catch { /* ignore */ }
  }

  // Compute checksum of committed snapshot text (the actual file content).
  const snapChecksum = computeChecksum(snap.text);

  if (cleanup) fs.rmSync(cleanup, { recursive: true, force: true });

  // The snapshot file must match the canonical projection, and the metadata
  // must describe that same file. Trusting the metadata alone would let a
  // hand-edited or stale snapshot pass beside a freshly written meta.json.
  if (currentChecksum === committedChecksum && snapChecksum === committedChecksum) {
    console.log(`OK: no drift. checksum=${currentChecksum.slice(0, 12)}...`);
    process.exit(0);
  } else {
    console.error('DRIFT DETECTED:');
    console.error(`  current canonical checksum: ${currentChecksum}`);
    console.error(`  committed snapshot checksum: ${committedChecksum ?? '(none)'}`);
    console.error(`  committed file checksum:    ${snapChecksum}`);
    console.error('');
    console.error('Regenerate the website snapshot and commit src/data/ in the website repo:');
    console.error('  npm run catalog:sync -- --website-dir <path-to-sencho-website>');
    process.exit(1);
  }
}

main();
