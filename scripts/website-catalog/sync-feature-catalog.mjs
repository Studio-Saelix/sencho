#!/usr/bin/env node
/**
 * Sencho tier-reconciliation: sync feature catalog to website
 * Reads docs/feature-catalog.yaml (canonical, public-safe), builds a sanitized
 * public projection, and writes it to <website-dir>/src/data/.
 *
 * Usage: node scripts/website-catalog/sync-feature-catalog.mjs --website-dir <path>
 *
 * The canonical file contains only public-safe identifiers (no SEN-NNN Linear IDs).
 * The public projection contains only shipped/planned community|admiral entries
 * with public presentation fields. Internal entries are excluded.
 */
import yaml from 'js-yaml';
import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';

const CANONICAL_FILE = 'docs/feature-catalog.yaml';
const SCHEMA_VERSION = '1';
const OUTPUT_SNAPSHOT = 'catalog-snapshot.yaml';
const OUTPUT_META = 'catalog-snapshot.meta.json';

// Fields allowed in the public projection.
const PUBLIC_FIELDS = new Set([
  'id', 'publicName', 'summary', 'description', 'category',
  'tier', 'availability', 'featured', 'homepageOrder', 'publicRoadmapKey',
]);

function normalizeYaml(obj) {
  return yaml.dump(obj, { sortKeys: true, lineWidth: -1, commentString: '' });
}

function computeChecksum(content) {
  return createHash('sha256').update(content).digest('hex');
}

function main() {
  const args = process.argv.slice(2);
  let websiteDir = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--website-dir' && args[i + 1]) {
      websiteDir = args[i + 1];
      i++;
    } else if (args[i] === '--help') {
      console.log('Usage: node sync-feature-catalog.mjs --website-dir <path>');
      process.exit(0);
    }
  }

  if (!websiteDir) {
    console.error('ERROR: --website-dir is required');
    process.exit(1);
  }

  // Read and parse canonical catalog.
  const catText = fs.readFileSync(CANONICAL_FILE, 'utf8');
  const doc = yaml.load(catText, { schema: yaml.CORE_SCHEMA });
  if (!doc || !Array.isArray(doc.entries)) {
    console.error('ERROR: canonical catalog is missing entries array');
    process.exit(1);
  }

  // Build sanitized public projection.
  const projection = doc.entries
    .filter((e) => e.tier !== 'internal' && e.availability !== 'internal')
    .map((e) => {
      const pub = {};
      for (const key of PUBLIC_FIELDS) {
        if (key in e) pub[key] = e[key];
      }
      return pub;
    });

  const projectionText = normalizeYaml({ entries: projection });
  const checksum = computeChecksum(projectionText);

  // Write snapshot.
  const outDir = path.join(websiteDir, 'src', 'data');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  fs.writeFileSync(path.join(outDir, OUTPUT_SNAPSHOT), projectionText, 'utf8');

  // Write metadata (checksum-based provenance, no commit SHA).
  const meta = {
    schemaVersion: SCHEMA_VERSION,
    checksum,
  };
  fs.writeFileSync(
    path.join(outDir, OUTPUT_META),
    JSON.stringify(meta, null, 2) + '\n',
    'utf8'
  );

  console.log(`Synced ${projection.length} public entries to ${outDir}/`);
  console.log(`Checksum: ${checksum}`);
  process.exit(0);
}

main();
