import { describe, expect, it } from 'vitest';

import {
  canonicalizeAuthoredInvocation,
  canonicalizeObservedInvocation,
  compareInvocations,
  type InvocationComparison,
} from '../services/gitops/invocationIdentity';
import {
  decodeObservedInvocation,
  encodeObservedInvocation,
  GitOpsJsonError,
  type ObservedInvocationIdentity,
} from '../services/gitops/json';
import type { AuthoredInvocationIdentity } from '../services/gitops/types';

const STACK_DIR = '/app/compose';
const STACK = 'web';
const FULL_STACK_DIR = `${STACK_DIR}/${STACK}`;

/**
 * The single-file case, which is the one the whole design turns on.
 *
 * `buildCandidateComposeInvocation` emits no flags at all for a single-file
 * selection, so the authored argv is `[]` while the observed label always
 * carries one absolute path. If the authored side stopped at the argv, every
 * single-file stack in existence would report invocation drift forever.
 */
const SINGLE_FILE = JSON.stringify([]);

const argv = (parts: string[]): string => JSON.stringify(parts);

function authored(
  expectedInvocationJson: string,
  composePathsJson: string | null = JSON.stringify(['compose.yaml']),
): AuthoredInvocationIdentity {
  const result = canonicalizeAuthoredInvocation({
    expectedInvocationJson,
    composePathsJson,
    stackName: STACK,
    stackDir: FULL_STACK_DIR,
  });
  if (result.kind !== 'ok') {
    throw new Error(`expected a comparable invocation, got ${result.reason}`);
  }
  return result.invocation;
}

function notComparable(
  expectedInvocationJson: string,
  composePathsJson: string | null = JSON.stringify(['compose.yaml']),
): string {
  const result = canonicalizeAuthoredInvocation({
    expectedInvocationJson,
    composePathsJson,
    stackName: STACK,
    stackDir: FULL_STACK_DIR,
  });
  if (result.kind !== 'not_comparable') throw new Error('expected not comparable');
  return result.reason;
}

function observed(
  overrides: Partial<ObservedInvocationIdentity> = {},
): ObservedInvocationIdentity {
  return {
    composeFileOrder: ['compose.yaml'],
    projectName: 'web',
    projectDirectory: '.',
    envFileOrder: [],
    observedAt: 1_700_000_000_000,
    ...overrides,
  };
}

function compare(expected: AuthoredInvocationIdentity, actual: ObservedInvocationIdentity): InvocationComparison {
  return compareInvocations(expected, actual);
}

function labels(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    'com.docker.compose.project': 'web',
    'com.docker.compose.project.config_files': `${FULL_STACK_DIR}/compose.yaml`,
    'com.docker.compose.project.working_dir': FULL_STACK_DIR,
    ...overrides,
  };
}

function observedFromLabels(labelSet: Record<string, string>): ObservedInvocationIdentity {
  const result = canonicalizeObservedInvocation(labelSet, FULL_STACK_DIR, 1_700_000_000_000);
  if (result.kind !== 'ok') throw new Error('expected a readable observation');
  return result.observation;
}

describe('authored invocation canonicalization', () => {
  it('reads the file order, project and directory out of the argv', () => {
    expect(authored(argv([
      '-f', 'compose.yaml',
      '-f', 'docker-compose.override.yml',
      '-p', 'Web',
      '--project-directory', 'ctx',
      '--env-file', `${FULL_STACK_DIR}/.env`,
    ]))).toEqual({
      composeFileOrder: ['compose.yaml', 'docker-compose.override.yml'],
      projectName: 'web',
      projectDirectory: 'ctx',
      envFileOrder: ['.env'],
    });
  });

  it('falls back to the configured selection when the argv names no file', () => {
    // The argv is empty for a single-file selection, so the authored file order
    // is what the source is configured to use.
    expect(authored(SINGLE_FILE, JSON.stringify(['docker-compose.yml']))).toEqual({
      composeFileOrder: ['compose.yaml'],
      projectName: 'web',
      projectDirectory: '.',
      envFileOrder: [],
    });
  });

  it('rewrites the primary to the fixed root name the way the apply does', () => {
    // A single-file source configured for docker-compose.yml is written to
    // compose.yaml at the stack root, which is the file Compose is given.
    expect(authored(SINGLE_FILE, JSON.stringify(['docker-compose.yml'])).composeFileOrder)
      .toEqual(['compose.yaml']);
  });

  it('keeps the order of a multi-file selection rather than sorting it', () => {
    expect(authored(SINGLE_FILE, JSON.stringify(['docker-compose.yml', 'extra.yml', 'a.yml'])))
      .toEqual({
        composeFileOrder: ['compose.yaml', 'extra.yml', 'a.yml'],
        projectName: 'web',
        projectDirectory: '.',
        envFileOrder: [],
      });
  });

  it('defaults the project to the stack name when the argv omits -p', () => {
    expect(authored(SINGLE_FILE).projectName).toBe('web');
  });

  it('lowercases an explicit -p, because Compose records the normalized name', () => {
    expect(authored(argv(['-f', 'compose.yaml', '-p', 'MyStack'])).projectName).toBe('mystack');
  });

  it('reads the identity shape a migration writes', () => {
    // The migration seed writes exactly this shape, so reading it rather than
    // rejecting the object keeps a real authored identity comparable.
    const written = canonicalizeAuthoredInvocation({
      expectedInvocationJson: JSON.stringify({
        composeFileOrder: ['compose.yaml'],
        projectName: 'web',
        projectDirectory: '.',
        envFileOrder: ['.env'],
      }),
      composePathsJson: null,
      stackName: STACK,
      stackDir: FULL_STACK_DIR,
    });
    if (written.kind !== 'ok') throw new Error('expected comparable');
    expect(written.invocation).toEqual({
      composeFileOrder: ['compose.yaml'],
      projectName: 'web',
      projectDirectory: '.',
      envFileOrder: ['.env'],
    });
  });

  it('declines the migration seed, which names no compose file', () => {
    expect(notComparable(
      '{"composeFileOrder":[],"projectName":null,"projectDirectory":null,"envFileOrder":[]}',
    )).toBe('authored_invocation_unreadable');
  });

  it('declines an inline Blueprint generation, which authored no invocation', () => {
    expect(notComparable('{}', null)).toBe('authored_invocation_unreadable');
  });

  it('declines a null invocation rather than reading it as an empty one', () => {
    expect(notComparable('null', null)).toBe('authored_invocation_unreadable');
  });

  it('declines unparseable json', () => {
    expect(notComparable('{not json', null)).toBe('authored_invocation_unreadable');
  });

  it('declines a flag with no operand instead of reading the next flag as its value', () => {
    expect(notComparable(argv(['-f', 'compose.yaml', '-p']))).toBe('authored_invocation_unreadable');
  });

  it('declines an authored path outside the target\'s own stack directory', () => {
    // This is the shape a Direct target has when its argv was built against a
    // different node's compose directory: the mount path is not drift.
    expect(notComparable(argv(['-f', '/somewhere/else/compose.yaml', '-p', 'web']), null))
      .toBe('authored_path_outside_stack');
  });

  it('declines an authored project directory outside the target\'s stack directory', () => {
    expect(notComparable(argv(['-f', 'compose.yaml', '--project-directory', '../other'])))
      .toBe('authored_path_outside_stack');
  });

  it('declines a flag it does not know rather than reading past it', () => {
    // Whether an unknown flag takes an operand is not knowable from its name.
    // Reading the next entry as its operand would shift every later flag by one
    // and silently drop a real -f, so the file order would be wrong rather than
    // absent, and a wrong order reports agreement or drift. Neither is a fact.
    expect(notComparable(argv(['--ansi', 'never', '-f', 'compose.yaml', '-p', 'web'])))
      .toBe('authored_invocation_unreadable');
  });

  it('declines a trailing flag rather than treating it as the whole record', () => {
    // An argv that stops on an unknown flag must not fall through to the
    // configured-selection fallback and report a comparison built from a
    // partially read record.
    expect(notComparable(argv(['-f', 'compose.yaml', '--newflag'])))
      .toBe('authored_invocation_unreadable');
  });

  it('declines an unusable configured selection rather than assuming a file', () => {
    expect(notComparable(SINGLE_FILE, '{"not":"a list"}')).toBe('authored_invocation_unreadable');
  });
});

describe('observed invocation canonicalization', () => {
  it('reduces the labels to the same shape as the authored side', () => {
    expect(observedFromLabels(labels())).toEqual({
      composeFileOrder: ['compose.yaml'],
      projectName: 'web',
      projectDirectory: '.',
      envFileOrder: [],
      observedAt: 1_700_000_000_000,
    });
  });

  it('reads a multi-file order and keeps it in order', () => {
    expect(observedFromLabels(labels({
      'com.docker.compose.project.config_files': `${FULL_STACK_DIR}/compose.yaml,${FULL_STACK_DIR}/override.yml`,
    })).composeFileOrder).toEqual(['compose.yaml', 'override.yml']);
  });

  it('reads the env files Compose recorded, in order', () => {
    expect(observedFromLabels(labels({
      'com.docker.compose.project.environment_file': `${FULL_STACK_DIR}/.env,${FULL_STACK_DIR}/.env.local`,
    })).envFileOrder).toEqual(['.env', '.env.local']);
  });

  it('treats an absent env-file label as no env file rather than as unknown', () => {
    // Compose only sets the label when --env-file was passed, so absent means
    // none, not unreadable.
    expect(observedFromLabels(labels()).envFileOrder).toEqual([]);
  });

  it('reads a project directory that is a subdirectory of the stack', () => {
    expect(observedFromLabels(labels({
      'com.docker.compose.project.working_dir': `${FULL_STACK_DIR}/ctx`,
    })).projectDirectory).toBe('ctx');
  });

  it('refuses a compose file outside the stack directory', () => {
    const result = canonicalizeObservedInvocation(
      labels({ 'com.docker.compose.project.config_files': '/elsewhere/compose.yaml' }),
      FULL_STACK_DIR,
      1,
    );
    expect(result.kind).toBe('unreadable');
  });

  it('refuses labels that carry no project, because they are not a compose project', () => {
    const result = canonicalizeObservedInvocation(
      { 'com.docker.compose.project.config_files': `${FULL_STACK_DIR}/compose.yaml` },
      FULL_STACK_DIR,
      1,
    );
    expect(result.kind).toBe('unreadable');
  });

  it('refuses a missing label set', () => {
    expect(canonicalizeObservedInvocation(undefined, FULL_STACK_DIR, 1).kind).toBe('unreadable');
    expect(canonicalizeObservedInvocation(null, FULL_STACK_DIR, 1).kind).toBe('unreadable');
  });

  it('refuses an empty compose file list rather than reporting it as a difference', () => {
    // The authored side refuses an empty file order, so accepting one here
    // would turn a label that recorded nothing into a reported difference
    // against a file list that was never written. Compose always writes at
    // least one file, so an empty one is not a readable invocation.
    expect(canonicalizeObservedInvocation(
      labels({ 'com.docker.compose.project.config_files': '' }),
      FULL_STACK_DIR,
      1,
    ).kind).toBe('unreadable');
    expect(canonicalizeObservedInvocation(
      labels({ 'com.docker.compose.project.config_files': '  ,  ' }),
      FULL_STACK_DIR,
      1,
    ).kind).toBe('unreadable');
  });
});

describe('invocation comparison', () => {
  it('reports equality for the single-file case that would otherwise always drift', () => {
    // The whole reason the authored side falls back to the configured
    // selection. Without it this is a permanent false positive on every
    // single-file stack.
    expect(compare(authored(SINGLE_FILE), observedFromLabels(labels())).kind).toBe('equal');
  });

  it('reports equality when the argv named the same file explicitly', () => {
    expect(compare(
      authored(argv(['-f', 'compose.yaml', '-p', 'web'])),
      observedFromLabels(labels()),
    ).kind).toBe('equal');
  });

  it('reports a difference when the node was invoked with another file', () => {
    const result = compare(
      authored(SINGLE_FILE),
      observedFromLabels(labels({
        'com.docker.compose.project.config_files': `${FULL_STACK_DIR}/override.yml`,
      })),
    );
    if (result.kind !== 'different') throw new Error('expected a difference');
    expect(result.expected.composeFileOrder).toEqual(['compose.yaml']);
    expect(result.observed.composeFileOrder).toEqual(['override.yml']);
  });

  it('reports a difference when the file order differs', () => {
    // Two compose files swapped is a different merge, so order is part of the
    // identity rather than a set.
    const result = compare(
      authored(argv(['-f', 'a.yml', '-f', 'b.yml', '-p', 'web'])),
      observed({ composeFileOrder: ['b.yml', 'a.yml'] }),
    );
    if (result.kind !== 'different') throw new Error('expected a difference');
    expect(result.observed.composeFileOrder).toEqual(['b.yml', 'a.yml']);
  });

  it('reports a difference when the project directory differs', () => {
    expect(compare(authored(SINGLE_FILE), observed({ projectDirectory: 'ctx' })).kind)
      .toBe('different');
  });

  it('reports a difference when the project name differs', () => {
    expect(compare(authored(argv(['-f', 'compose.yaml', '-p', 'web'])), observed({ projectName: 'other' })).kind)
      .toBe('different');
  });

  it('reports a difference when the env file order differs', () => {
    expect(compare(
      authored(argv(['-f', 'compose.yaml', '-p', 'web', '--env-file', '.env'])),
      observed({ envFileOrder: ['.env', '.env.local'] }),
    ).kind).toBe('different');
  });

  it('reports a difference when a node was invoked with an extra file', () => {
    expect(compare(
      authored(SINGLE_FILE),
      observed({ composeFileOrder: ['compose.yaml', 'override.yml'] }),
    ).kind).toBe('different');
  });

  it('does not report a difference for the same invocation recorded twice', () => {
    const first = observedFromLabels(labels());
    const second = observedFromLabels(labels());
    expect(compareInvocations(authored(SINGLE_FILE), first).kind).toBe('equal');
    expect(compareInvocations(authored(SINGLE_FILE), second).kind).toBe('equal');
  });
});

describe('observation codec', () => {
  const stored = (overrides: Record<string, unknown> = {}): string => JSON.stringify({
    composeFileOrder: ['compose.yaml'],
    projectName: 'web',
    projectDirectory: '.',
    envFileOrder: [],
    observedAt: 1_700_000_000_000,
    ...overrides,
  });

  it('round-trips through the stored form', () => {
    const value = observed({ envFileOrder: ['.env', '.env.local'], projectDirectory: 'ctx' });
    expect(JSON.parse(encodeObservedInvocation(value))).toEqual(value);
  });

  it('reads a null column as no observation at all', () => {
    // Null is the whole signal for "Sencho has not looked", and for a node
    // that could not be reached. It must not decode to a value.
    expect(decodeObservedInvocation(null)).toBeNull();
  });

  it('refuses a column carrying a key this build does not know', () => {
    // A value written by a newer build is not a value this build can claim to
    // understand, and comparing half of it would be worse than refusing it.
    expect(() => decodeObservedInvocation(stored({ surprise: 'value' }))).toThrow(GitOpsJsonError);
  });

  it('refuses a column that is not an object', () => {
    expect(() => decodeObservedInvocation('[]')).toThrow(GitOpsJsonError);
  });

  it('refuses a missing field rather than defaulting it', () => {
    expect(() => decodeObservedInvocation(JSON.stringify({ projectName: 'web' }))).toThrow(GitOpsJsonError);
  });

  it('refuses a non-finite timestamp', () => {
    expect(() => decodeObservedInvocation(stored({ observedAt: 'soon' }))).toThrow(GitOpsJsonError);
  });

  it('refuses a file list holding something that is not a path', () => {
    expect(() => decodeObservedInvocation(stored({ composeFileOrder: [7] }))).toThrow(GitOpsJsonError);
    expect(() => decodeObservedInvocation(stored({ envFileOrder: 'one' }))).toThrow(GitOpsJsonError);
  });
});
