/**
 * Tests for scripts/check-pr-title.mjs
 *
 * Run:  node --test scripts/check-pr-title.test.mjs
 *
 * The tests assert against the literal types listed in commitlint.config.js
 * rather than a copy of them, so widening or narrowing the allow-list is
 * visible here as a test change instead of a silent divergence.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { allowedTypes, parseTitle, checkTitle } from './check-pr-title.mjs'

const TYPES = [
  'feat',
  'fix',
  'perf',
  'revert',
  'docs',
  'style',
  'refactor',
  'test',
  'build',
  'ci',
  'chore',
  'security',
]

// ---------------------------------------------------------------------------
// allowedTypes
// ---------------------------------------------------------------------------

describe('allowedTypes', () => {
  it('reads the real commitlint allow-list', () => {
    const types = allowedTypes('commitlint.config.js')

    assert.deepEqual(types, TYPES)
  })

  it('survives the config being reformatted, not just the types changing', () => {
    // The allow-list is loaded, not pattern-matched out of the source, so a
    // re-quoting pass in commitlint.config.js cannot silently break this check.
    const reformatted = { rules: { 'type-enum': [2, 'always', ['feat', 'fix']] } }

    assert.deepEqual(allowedTypes(reformatted), ['feat', 'fix'])
  })

  it('reads the allow-list out of the [level, applicability, value] rule form', () => {
    assert.deepEqual(
      allowedTypes({ rules: { 'type-enum': [2, 'always', ['feat', 'fix']] } }),
      ['feat', 'fix'],
    )
    assert.deepEqual(allowedTypes({ rules: { 'type-enum': [2, ['feat']] } }), ['feat'])
  })

  it('fails closed when there is no type-enum rule', () => {
    assert.throws(() => allowedTypes({ rules: {} }), /type-enum/)
    assert.throws(() => allowedTypes({}), /type-enum/)
  })

  it('fails closed when the allow-list is empty', () => {
    assert.throws(() => allowedTypes({ rules: { 'type-enum': [] } }), /type-enum/)
    assert.throws(
      () => allowedTypes({ rules: { 'type-enum': [2, 'always', []] } }),
      /type-enum/,
    )
  })
})

// ---------------------------------------------------------------------------
// parseTitle
// ---------------------------------------------------------------------------

describe('parseTitle', () => {
  it('parses a plain type and subject', () => {
    assert.deepEqual(parseTitle('fix(dashboard): keep the column readable', TYPES), {
      type: 'fix',
      scope: 'dashboard',
      breaking: false,
      subject: 'keep the column readable',
    })
  })

  it('parses a title with no scope', () => {
    assert.deepEqual(parseTitle('ci: shard the e2e suite', TYPES), {
      type: 'ci',
      scope: null,
      breaking: false,
      subject: 'shard the e2e suite',
    })
  })

  it('parses a breaking-change marker', () => {
    const parsed = parseTitle('feat(app-store)!: replace the legacy picker', TYPES)

    assert.equal(parsed.breaking, true)
    assert.equal(parsed.type, 'feat')
  })

  it('returns null for a title with no conventional prefix', () => {
    assert.equal(parseTitle('Surface runtime build identity across About, shell, and Admiral Account', TYPES), null)
  })

  it('rejects an uppercase type, which release-please would not map to a section', () => {
    assert.equal(parseTitle('FEAT: uppercase type', TYPES), null)
  })

  it('tolerates spaces and punctuation inside a scope, as the parser does', () => {
    // @conventional-commits/parser 0.4 accepts all of these, so rejecting them
    // here would block titles that release-please reads perfectly well.
    assert.equal(parseTitle('feat(scope with spaces): x', TYPES).scope, 'scope with spaces')
    assert.equal(parseTitle('feat(a$b.c-d*e): x', TYPES).scope, 'a$b.c-d*e')
    assert.equal(parseTitle('fix(dash\tboard): x', TYPES).scope, 'dash\tboard')
  })

  it('rejects a nested paren in the scope', () => {
    // release-please's parser (@conventional-commits/parser 0.4.x) throws on
    // this shape and then drops the commit, so accepting it here would pass a
    // title that never reaches the changelog.
    assert.equal(parseTitle('fix(foo(bar)): nested parens', TYPES), null)
  })

  it('rejects text between the scope and the colon', () => {
    assert.equal(parseTitle('feat(sco pe)extra: x', TYPES), null)
  })

  it('rejects a space before the colon', () => {
    assert.equal(parseTitle('feat : x', TYPES), null)
  })

  it('returns null for a type outside the allow-list', () => {
    assert.equal(parseTitle('wip: try the new picker', TYPES), null)
  })

  it('returns null when there is no subject', () => {
    assert.equal(parseTitle('fix(dashboard): ', TYPES), null)
  })

  it('returns null for a title that is only a type', () => {
    assert.equal(parseTitle('fix:', TYPES), null)
  })
})

// ---------------------------------------------------------------------------
// checkTitle
// ---------------------------------------------------------------------------

describe('checkTitle', () => {
  it('passes every type the repo actually uses', () => {
    const real = [
      'feat: surface the running build identity in About, the shell chip, and Admiral Account',
      'fix(dashboard): keep the Stack Health name column readable at 1280',
      'security(deps): bump @grpc/grpc-js to 1.14.5',
      'chore(deps): bump ip-address to 10.7.2 in the backend',
      'docs: correct the cosign verification identity in release artifact guides',
      'refactor(fleet): flatten the Readiness tab chrome and start its check when Fleet opens',
      'test(e2e): stop a failed two-factor spec from cascading the whole suite',
      'perf(gitops): bound the Blueprint detail reachability probe with a verdict window',
      'ci: shard e2e, skip docs-only PRs, and drop the inert visual-regression gate',
      'revert: undo the marquee change',
      'build: add a reproducible timestamp',
      'style: normalise the table spacing',
    ]

    for (const title of real) {
      assert.equal(checkTitle(title, TYPES), null, title)
    }
  })

  it('rejects the untyped title that dropped a feature from the release notes', () => {
    const failure = checkTitle(
      'Surface runtime build identity across About, shell, and Admiral Account',
      TYPES,
    )

    assert.ok(failure)
    assert.match(failure, /not a Conventional Commit/)
    assert.match(failure, /squash/i)
  })

  it('names the allowed types and an example when it fails', () => {
    const failure = checkTitle('nope: missing the colon', TYPES)

    assert.match(failure, /security/)
    assert.match(failure, /fix\(dashboard\): /)
  })

  it('rejects an empty title', () => {
    assert.match(checkTitle('   ', TYPES), /empty/)
  })

  it('accepts a title longer than the local commit hook allows', () => {
    // Dependabot produces group titles over the 120-character commit header
    // limit. Retyping the commit is the maintainer's job at merge time, and
    // failing here would only block the merge behind a cosmetic rule.
    const long =
      'chore(deps): bump the all-npm-backend group across 1 directory with 14 updates and a rather long trailing description to exceed the limit'

    assert.equal(checkTitle(long, TYPES), null)
  })

  it('treats surrounding whitespace as absent', () => {
    assert.match(checkTitle('\n\t ', TYPES), /empty/)
  })
})