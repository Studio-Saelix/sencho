#!/usr/bin/env node
import fs from 'fs';
import yaml from 'js-yaml';

const CATALOG_FILE = 'docs/feature-catalog.yaml';
const PROHIBITED_KEYS = ['linear', 'evidence', 'internalNote', 'route', 'service'];

const text = fs.readFileSync(CATALOG_FILE, 'utf8');
const doc = yaml.load(text, { schema: yaml.CORE_SCHEMA });

let failed = false;
function fail(msg) { console.error('NO-LEAK FAIL: ' + msg); failed = true; }

if (!doc || !Array.isArray(doc.entries)) fail('catalog has no entries array');
else {
  for (const entry of doc.entries) {
    const id = entry?.id || '(unknown)';
    if (entry.linear) fail(`entry[${id}] contains prohibited linear: ${entry.linear}`);
    if (entry.evidence) fail(`entry[${id}] contains prohibited evidence`);
    if (entry.internalNote) fail(`entry[${id}] contains prohibited internalNote`);
    for (const [k, v] of Object.entries(entry)) {
      if (typeof v === 'string' && /SEN-[0-9]+/.test(v))
        fail(`entry[${id}] key "${k}" has SEN-NNN: "${v}"`);
    }
    if (entry.tier === 'internal' && entry.availability !== 'internal')
      fail(`entry[${id}] tier internal requires availability internal`);
  }
}

if (failed) process.exit(1);
console.log('NO-LEAK PASS');
process.exit(0);
