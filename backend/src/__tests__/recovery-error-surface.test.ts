/**
 * An operator meets a recovery refusal as a JSON answer, in the API reference,
 * and on the operator page. Nothing else names an error class or a `reason`
 * token, so each must appear in all three places or the operator is left with a
 * code they cannot look up.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { parse } from 'yaml';
import { errorDetailFor } from '../services/recovery/redaction';
import { OVERWRITE_REFUSAL_REASONS } from '../services/recovery/types';
import { ERROR_STATUS } from '../routes/recovery';

const repoFile = (...parts: string[]): string => fs.readFileSync(path.resolve(__dirname, '../../..', ...parts), 'utf8');
const operatorPage = repoFile('docs', 'operations', 'volume-recovery-points.mdx');
const spec = parse(repoFile('docs', 'openapi.yaml')) as {
  components: { schemas: { RecoveryError: { properties: { reason: { description: string } } } } };
};
const reasonDescription = spec.components.schemas.RecoveryError.properties.reason.description;

const classes = Object.keys(ERROR_STATUS) as Array<keyof typeof ERROR_STATUS>;

describe('recovery error classes', () => {
  it('give every class its own fixed sentence', () => {
    const sentences = classes.map((errorClass) => errorDetailFor(errorClass));
    expect(sentences.every((sentence) => sentence.length > 0)).toBe(true);
    expect(new Set(sentences).size).toBe(classes.length);
  });

  it.each(classes)('names %s in the operator page error table', (errorClass) => {
    expect(operatorPage).toContain(`\`${errorClass}\``);
  });
});

describe('overwrite refusal reasons', () => {
  it.each([...OVERWRITE_REFUSAL_REASONS])('names %s in the operator page and the API reference', (reason) => {
    expect(operatorPage).toContain(`\`${reason}\``);
    expect(reasonDescription).toContain(`\`${reason}\``);
  });
});
