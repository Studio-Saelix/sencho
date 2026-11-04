/**
 * An operator meets a recovery refusal as a JSON answer, in the API reference,
 * and on the operator page. The page's status table and its `reason` sentence,
 * and the reference's `reason` description, must list exactly the classes the
 * router answers (with their statuses) and the reason tokens a `RecoveryError`
 * can carry, so a code an operator reads in an answer can always be looked up
 * and nothing documented is a code no answer carries. The reference's
 * `errorClass` enums are compared in recovery-openapi-parity.test.ts.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { parse } from 'yaml';
import { errorDetailFor } from '../services/recovery/redaction';
import { RECOVERY_REFUSAL_REASONS } from '../services/recovery/types';
import { ERROR_STATUS } from '../routes/recovery';

const repoFile = (...parts: string[]): string => fs.readFileSync(path.resolve(__dirname, '../../..', ...parts), 'utf8');
const operatorPage = repoFile('docs', 'operations', 'volume-recovery-points.mdx');
const spec = parse(repoFile('docs', 'openapi.yaml')) as {
  components: { schemas: { RecoveryError: { properties: { reason: { description: string } } } } };
};

/** Request modes and resolve actions are named in backticks beside the reasons; they are not reasons. */
const NOT_NAMES = new Set(['staged_overwrite', 'new_path', 'new_volume', 'release_fence']);

/** The distinct lowercase names in backticks. */
function namedTokens(text: string): string[] {
  const names = [...text.matchAll(/`([a-z]+(?:_[a-z]+)*)`/g)].map((match) => match[1]).filter((name) => !NOT_NAMES.has(name));
  return [...new Set(names)];
}

describe('recovery error classes', () => {
  it('give every class its own fixed sentence', () => {
    const sentences = Object.keys(ERROR_STATUS).map((errorClass) => errorDetailFor(errorClass as keyof typeof ERROR_STATUS));
    expect(sentences.every((sentence) => sentence.length > 0)).toBe(true);
    expect(new Set(sentences).size).toBe(sentences.length);
  });

  it('are listed in the operator page status table under the status the router answers', () => {
    const rows = operatorPage.split('\n').filter((line) => /^\| `\d{3}` \|/.test(line));
    const documented: Record<string, number> = {};
    for (const row of rows) {
      const status = Number(/^\| `(\d{3})`/.exec(row)![1]);
      for (const errorClass of namedTokens(row.slice(row.indexOf('|', 2)))) documented[errorClass] = status;
    }
    expect(documented).toEqual({ ...ERROR_STATUS });
  });
});

describe('recovery refusal reasons', () => {
  it('are exactly the ones the operator page lists', () => {
    const sentence = operatorPage.split('\n').find((line) => line.includes('A refusal can also carry a `reason`'));
    expect(sentence).toBeDefined();
    const listed = namedTokens(sentence!.slice(sentence!.indexOf('specific cause:')));
    expect([...listed].sort()).toEqual([...RECOVERY_REFUSAL_REASONS].sort());
  });

  it('are exactly the ones the API reference describes', () => {
    const listed = namedTokens(spec.components.schemas.RecoveryError.properties.reason.description);
    expect([...listed].sort()).toEqual([...RECOVERY_REFUSAL_REASONS].sort());
  });
});

describe('the operator page on a restore that a crash interrupted', () => {
  const section = (title: string): string => {
    const start = operatorPage.indexOf(`### ${title}`);
    expect(start, title).toBeGreaterThanOrEqual(0);
    const next = operatorPage.indexOf('\n### ', start + 1);
    return operatorPage.slice(start, next === -1 ? undefined : next);
  };

  it('says a rolled back restore leaves the storage lock stale until it is released', () => {
    const afterCrash = section('After a crash');
    expect(afterCrash).toMatch(/storage lock/);
    expect(afterCrash).toMatch(/stale/);
    expect(afterCrash).toContain('`409 lock_stale`');
    expect(afterCrash).toContain('(#release-a-stale-lock)');
  });

  it('says cancel ends `cancelled` only before the swap, and that a refused request is worded as one', () => {
    expect(operatorPage).toMatch(/`cancelled` only before the swap starts/);
    expect(section('Resolve a restore that did not settle')).toContain('a refused request says it was refused');
  });
});
