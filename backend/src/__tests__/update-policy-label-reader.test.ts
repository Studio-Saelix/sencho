/**
 * AC1: the two behavioral label keys are read through the registry only.
 *
 * A second reader of `io.sencho.update` or `io.sencho.notify.route` that parses
 * the string itself would drift from the registry's normalization and its
 * fail-closed rules. This guard names the files allowed to carry the literal and
 * fails on any other, so a new reader has to go through `resolveSenchoLabels`.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const BACKEND_SRC = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(BACKEND_SRC, '../..');

const LABEL_KEYS = ['io.sencho.update', 'io.sencho.notify.route'];

/**
 * Every file that may name the keys, with why.
 *  - the registry itself;
 *  - user-facing copy that must name the label (docs, UI strings);
 *  - tests and fixtures;
 *  - API documentation.
 */
const ALLOWED = [
  path.join(BACKEND_SRC, 'helpers', 'senchoLabels.ts'),
  path.join(REPO_ROOT, 'backend', 'src', '__tests__'),
  path.join(REPO_ROOT, 'docs'),
  path.join(REPO_ROOT, 'frontend', 'src'),
  path.join(REPO_ROOT, 'e2e'),
];

function isAllowed(file: string): boolean {
  return ALLOWED.some(allowed => file === allowed || file.startsWith(allowed + path.sep));
}

/**
 * Comments may name a label to explain behavior; only a string literal in code
 * makes a second reader. Strip both comment forms before scanning.
 */
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

describe('the label keys have one reader', () => {
  it('appears nowhere in backend source outside the registry, tests and docs', () => {
    const offenders: string[] = [];
    for (const file of walk(BACKEND_SRC)) {
      if (!/\.(ts|js)$/.test(file)) continue;
      if (isAllowed(file)) continue;
      const text = stripComments(fs.readFileSync(file, 'utf8'));
      for (const key of LABEL_KEYS) {
        if (text.includes(key)) offenders.push(`${path.relative(BACKEND_SRC, file)} names ${key}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('is exported from the registry so a caller never retypes it', async () => {
    const { SENCHO_UPDATE_LABEL, SENCHO_NOTIFY_ROUTE_LABEL } = await import('../helpers/senchoLabels');
    expect(SENCHO_UPDATE_LABEL).toBe('io.sencho.update');
    expect(SENCHO_NOTIFY_ROUTE_LABEL).toBe('io.sencho.notify.route');
  });
});
