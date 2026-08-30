#!/usr/bin/env node
/**
 * Sencho tier-reconciliation: canonical catalog validator
 * Verifies docs/feature-catalog.yaml against the canonical schema and
 * the required cross-field invariant (tier: internal iff availability: internal).
 * Exits 0 on valid, exits 1 with diagnostic lines on invalid.
 */
import yaml from 'js-yaml';
import fs from 'fs';
import path from 'path';

import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CATALOG_FILE = path.resolve(__dirname, '../../docs/feature-catalog.yaml');

const VALID_TIERS = new Set(['community', 'admiral', 'internal']);
const VALID_AVAILABILITY = new Set(['shipped', 'planned', 'internal']);
const VALID_CATEGORIES = new Set([
  'compose-deploy', 'fleet-orchestration', 'security-foundation',
  'automation-operations', 'recovery', 'identity-access',
  'governance', 'assurance', 'internal',
]);

const errors = [];

function error(msg) { errors.push('ERROR: ' + msg); }

function readCatalog() {
  const text = fs.readFileSync(CATALOG_FILE, 'utf8');
  const doc = yaml.load(text, { schema: yaml.CORE_SCHEMA });
  if (!doc || typeof doc !== 'object') {
    throw new Error('catalog is not a YAML mapping');
  }
  return doc;
}

function main() {
  const doc = readCatalog();
  const entries = Array.isArray(doc.entries) ? doc.entries : [];
  const ids = new Set();

  for (const [i, entry] of entries.entries()) {
    const prefix = `entry[${i}].id=${entry?.id ?? '(missing)'}`;

    if (!entry || typeof entry !== 'object') {
      error(`${prefix}: entry is not an object`);
      continue;
    }

    if (!entry.id) error(`${prefix}: missing id`);
    else if (ids.has(entry.id)) error(`${prefix}: duplicate id "${entry.id}"`);
    else ids.add(entry.id);

    if (!entry.name) error(`${prefix}: missing name`);
    if (!VALID_TIERS.has(entry.tier))
      error(`${prefix}: invalid tier "${entry.tier}"; must be one of community/admiral/internal`);
    if (!VALID_AVAILABILITY.has(entry.availability))
      error(`${prefix}: invalid availability "${entry.availability}"; must be one of shipped/planned/internal`);

    // Cross-field invariant: tier: internal iff availability: internal
    if (entry.tier === 'internal' && entry.availability !== 'internal')
      error(`${prefix}: tier: internal requires availability: internal`);
    if (entry.tier !== 'internal' && entry.availability === 'internal')
      error(`${prefix}: non-internal tier requires non-internal availability`);

    if (entry.availability === 'planned') {
      if (!entry.publicRoadmapKey) error(`${prefix}: planned entry must have publicRoadmapKey`);
    }

    if (!VALID_CATEGORIES.has(entry.category))
      error(`${prefix}: unknown category "${entry.category}"`);

    // Internal-only fields must not leak into committed catalog.
    // The canonical file IS public, so we enforce: no linear, no evidence with internal identifiers,
    // no internalNote. Public-name fields only.
    if (entry.linear) {
      // Reject any internal Linear identifier in committed file.
      if (/SEN-[0-9]/.test(String(entry.linear)))
        error(`${prefix}: committed catalog contains internal Linear identifier in linear field ("${entry.linear}"); use publicRoadmapKey instead`);
    }
    // No evidence field allowed in canonical committed file (evidence stays internal).
    if (entry.evidence)
      error(`${prefix}: evidence field must not appear in committed canonical catalog (use Linear/non-public record for evidence); got: ${entry.evidence}`);
    if (entry.internalNote)
      error(`${prefix}: internalNote field must not appear in committed canonical catalog`);
  }

  if (errors.length === 0) {
    console.log(`VALID: catalog has ${entries.length} entries; all invariants pass.`);
    process.exit(0);
  } else {
    for (const msg of errors) console.error(msg);
    console.error(`FAIL: ${errors.length} error(s) found.`);
    process.exit(1);
  }
}

try {
  main();
} catch (e) {
  console.error('FAIL: ' + (e.message || e));
  process.exit(1);
}
