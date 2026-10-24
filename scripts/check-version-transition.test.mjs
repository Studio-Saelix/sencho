/**
 * Tests for scripts/check-version-transition.mjs
 *
 * Run:  node --test scripts/check-version-transition.test.mjs
 *
 * The decision tests assert against the literal outcome a maintainer sees: a
 * failure string (which must name the approval label) or null.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  checkVersionTransition,
  findMarkers,
  isReleasePr,
  manifestVersion,
  versionTransition,
} from './check-version-transition.mjs'

const BOT = 'sencho-quartermaster[bot]'
const RELEASE_BRANCH = 'release-please--branches--main--components--sencho'

function pr(overrides = {}) {
  return {
    title: 'feat: add a settings row',
    body: '## Summary\n\nAdds a setting.',
    commits: ['feat: add a settings row'],
    approved: false,
    author: 'contributor',
    headRef: 'feat/add-a-settings-row',
    commitsRead: true,
    ...overrides,
  }
}

function releasePr(overrides = {}) {
  return pr({
    title: 'chore(main): release 0.98.1',
    body: '## Release notes',
    commits: ['chore(main): release 0.98.1'],
    author: BOT,
    headRef: RELEASE_BRANCH,
    baseManifest: { '.': '0.98.0' },
    headManifest: { '.': '0.98.1' },
    ...overrides,
  })
}

function lines(found) {
  return found.map((marker) => `${marker.where}: ${marker.line}`)
}

// ---------------------------------------------------------------------------
// findMarkers
// ---------------------------------------------------------------------------

describe('findMarkers', () => {
  it('finds a breaking subject with no scope', () => {
    assert.deepEqual(lines(findMarkers({ title: 'feat!: replace the proxy' })), [
      'title: feat!: replace the proxy',
    ])
  })

  it('finds a breaking subject with a scope', () => {
    assert.deepEqual(lines(findMarkers({ title: 'fix(api)!: drop the old field' })), [
      'title: fix(api)!: drop the old field',
    ])
  })

  it('finds feature!, which release-please treats as feat', () => {
    assert.deepEqual(lines(findMarkers({ title: 'feature!: replace the proxy' })), [
      'title: feature!: replace the proxy',
    ])
  })

  it('finds a breaking subject in any type text the parser accepts', () => {
    for (const subject of [
      'feat_thing!: replace the proxy',
      'docs/api!: replace the proxy',
      '123!: replace the proxy',
    ]) {
      assert.deepEqual(lines(findMarkers({ title: subject })), [`title: ${subject}`])
    }
  })

  it('does not treat the same type text as breaking without the bang', () => {
    assert.deepEqual(findMarkers({ title: 'feat_thing: add a row' }), [])
  })

  it('finds both breaking footer spellings', () => {
    const spaced = findMarkers({ body: 'BREAKING CHANGE: the field is gone' })
    const hyphenated = findMarkers({ body: 'BREAKING-CHANGE: the field is gone' })

    assert.deepEqual(lines(spaced), ['body: BREAKING CHANGE: the field is gone'])
    assert.deepEqual(lines(hyphenated), ['body: BREAKING-CHANGE: the field is gone'])
  })

  it('finds a breaking footer regardless of case', () => {
    assert.deepEqual(lines(findMarkers({ body: 'breaking change: the field is gone' })), [
      'body: breaking change: the field is gone',
    ])
  })

  it('finds a breaking footer with the " #" separator', () => {
    const spaced = findMarkers({ body: 'BREAKING CHANGE #123' })
    const hyphenated = findMarkers({ body: 'BREAKING-CHANGE #123' })

    assert.deepEqual(lines(spaced), ['body: BREAKING CHANGE #123'])
    assert.deepEqual(lines(hyphenated), ['body: BREAKING-CHANGE #123'])
  })

  it('does not treat the words alone as a footer', () => {
    assert.deepEqual(findMarkers({ body: 'BREAKING CHANGE policy applies.' }), [])
    assert.deepEqual(findMarkers({ body: 'BREAKING CHANGES are listed below.' }), [])
  })

  it('finds a footer behind a bullet or a numbered list marker', () => {
    assert.deepEqual(lines(findMarkers({ body: '- BREAKING CHANGE: the field is gone' })), [
      'body: BREAKING CHANGE: the field is gone',
    ])
    assert.deepEqual(lines(findMarkers({ body: '* BREAKING CHANGE: the field is gone' })), [
      'body: BREAKING CHANGE: the field is gone',
    ])
    assert.deepEqual(lines(findMarkers({ body: '1. BREAKING CHANGE: the field is gone' })), [
      'body: BREAKING CHANGE: the field is gone',
    ])
  })

  it('finds Release-As in the body', () => {
    assert.deepEqual(lines(findMarkers({ body: 'Release-As: 1.0.0' })), [
      'body: Release-As: 1.0.0',
    ])
    assert.deepEqual(lines(findMarkers({ body: 'Release As: 1.0.0' })), [
      'body: Release As: 1.0.0',
    ])
  })

  it('finds Release-As with the " #" separator', () => {
    assert.deepEqual(lines(findMarkers({ body: 'Release-As #1.0.0' })), [
      'body: Release-As #1.0.0',
    ])
    assert.deepEqual(lines(findMarkers({ body: 'Release As #1.0.0' })), [
      'body: Release As #1.0.0',
    ])
  })

  it('finds Release-As inside a commit override block', () => {
    const body = [
      'Please merge this one manually.',
      '',
      'BEGIN_COMMIT_OVERRIDE',
      'Release-As: 0.99.0',
      'END_COMMIT_OVERRIDE',
    ].join('\n')

    assert.deepEqual(lines(findMarkers({ body })), ['body: Release-As: 0.99.0'])
  })

  it('finds a breaking footer inside a fenced block', () => {
    const body = ['```text', 'BREAKING CHANGE: the field is gone', '```'].join('\n')

    assert.deepEqual(lines(findMarkers({ body })), [
      'body: BREAKING CHANGE: the field is gone',
    ])
  })

  it('scans every line of a full commit message', () => {
    const commit = [
      'feat: add a settings row',
      '',
      'The row is opt-in.',
      '',
      'BREAKING CHANGE: the old key is gone',
    ].join('\n')

    assert.deepEqual(lines(findMarkers({ commits: [commit] })), [
      'commit: BREAKING CHANGE: the old key is gone',
    ])
  })

  it('finds a breaking subject in a commit', () => {
    assert.deepEqual(lines(findMarkers({ commits: ['feat!: replace the proxy'] })), [
      'commit: feat!: replace the proxy',
    ])
  })

  it('passes a plain feat', () => {
    assert.deepEqual(findMarkers(pr()), [])
  })

  it('passes prose that mentions the policy without a marker line', () => {
    const body = [
      'This change is compatible: it adds a column with a default and removes',
      'nothing. The release policy bans an unapproved bang before the colon or a',
      'breaking footer in any commit that lands on main.',
    ].join('\n')

    assert.deepEqual(findMarkers({ body }), [])
  })

  it('does not treat a marker in the middle of a line as a footer', () => {
    assert.deepEqual(findMarkers({ body: 'This note explains BREAKING CHANGE: why.' }), [])
  })

  it('does not treat a version name in running text as a marker', () => {
    assert.deepEqual(findMarkers({ body: 'Ships in 0.99.0 if approved.' }), [])
  })

  it('passes the pull request template', () => {
    const template = readFileSync(
      new URL('../.github/PULL_REQUEST_TEMPLATE.md', import.meta.url),
      'utf8',
    )

    assert.deepEqual(findMarkers({ body: template }), [])
  })
})

// ---------------------------------------------------------------------------
// isReleasePr
// ---------------------------------------------------------------------------

describe('isReleasePr', () => {
  it('accepts the release app on a release branch', () => {
    assert.equal(isReleasePr({ author: BOT, headRef: RELEASE_BRANCH }), true)
  })

  it('rejects the release app on any other branch', () => {
    assert.equal(isReleasePr({ author: BOT, headRef: 'chore/release' }), false)
  })

  it('rejects a human on a release branch', () => {
    assert.equal(isReleasePr({ author: 'contributor', headRef: RELEASE_BRANCH }), false)
  })

  it('does not consider the title', () => {
    // The signature has no title, so an impersonating title cannot change the
    // answer. This case exists to pin that down.
    assert.equal(isReleasePr({ author: BOT, headRef: 'release-please--other' }), true)
  })
})

// ---------------------------------------------------------------------------
// manifestVersion and versionTransition
// ---------------------------------------------------------------------------

describe('manifestVersion', () => {
  it('reads the root package version', () => {
    assert.equal(manifestVersion({ '.': '0.98.0' }), '0.98.0')
  })

  it('returns null for a missing or unreadable manifest', () => {
    assert.equal(manifestVersion({}), null)
    assert.equal(manifestVersion({ '.': 98 }), null)
    assert.equal(manifestVersion(null), null)
  })
})

describe('versionTransition', () => {
  it('names the digit that moved', () => {
    assert.equal(versionTransition('0.98.0', '0.98.1'), 'patch')
    assert.equal(versionTransition('0.98.0', '0.99.0'), 'minor')
    assert.equal(versionTransition('0.98.0', '1.0.0'), 'major')
    assert.equal(versionTransition('0.98.0', '0.98.0'), 'none')
  })

  it('returns null when either version is unparsable', () => {
    assert.equal(versionTransition('0.98.0', 'next'), null)
    assert.equal(versionTransition(null, '0.98.1'), null)
  })
})

// ---------------------------------------------------------------------------
// checkVersionTransition: marker scanning
// ---------------------------------------------------------------------------

describe('checkVersionTransition markers', () => {
  it('passes a plain feat', () => {
    assert.equal(checkVersionTransition(pr()), null)
  })

  it('fails a breaking title with no approval', () => {
    const failure = checkVersionTransition(pr({ title: 'feat!: replace the proxy' }))

    assert.match(failure, /version-transition-approved/)
    assert.match(failure, /title: feat!: replace the proxy/)
  })

  it('passes a breaking title with the approval label', () => {
    assert.equal(
      checkVersionTransition(pr({ title: 'feat!: replace the proxy', approved: true })),
      null,
    )
  })

  it('fails a breaking footer in the body with no approval', () => {
    const failure = checkVersionTransition(
      pr({ body: 'The field is gone.\n\nBREAKING CHANGE: remove the old key' }),
    )

    assert.match(failure, /version-transition-approved/)
  })

  it('fails Release-As in a commit with no approval', () => {
    const failure = checkVersionTransition(
      pr({ commits: ['feat: add a row', '', 'Release-As: 1.0.0'] }),
    )

    assert.match(failure, /commit: Release-As: 1\.0\.0/)
  })

  it('fails a " #" breaking footer with no approval', () => {
    for (const footer of ['BREAKING CHANGE #123', 'BREAKING-CHANGE #123']) {
      const failure = checkVersionTransition(
        pr({ body: `The old key is gone.\n\n${footer}` }),
      )

      assert.match(failure, /version-transition-approved/)
      assert.match(failure, new RegExp(`body: ${footer}`))
    }
  })

  it('fails " #" footer forms in a commit with no approval', () => {
    for (const footer of ['BREAKING CHANGE #123', 'Release-As #1.0.0']) {
      const failure = checkVersionTransition(
        pr({ commits: [`feat: add a row\n\n${footer}`] }),
      )

      assert.match(failure, new RegExp(`commit: ${footer}`))
    }
  })

  it('passes the " #" footer forms with the approval label', () => {
    assert.equal(
      checkVersionTransition(
        pr({
          body: 'BREAKING CHANGE #123',
          commits: ['feat: add a row\n\nRelease-As #1.0.0'],
          approved: true,
        }),
      ),
      null,
    )
  })

  it('fails closed when the commits could not be read', () => {
    const failure = checkVersionTransition(pr({ commitsRead: false }))

    assert.match(failure, /could not be read/)
  })

  it('stays closed when the commits could not be read even with approval', () => {
    const failure = checkVersionTransition(pr({ commitsRead: false, approved: true }))

    assert.match(failure, /could not be read/)
  })
})

// ---------------------------------------------------------------------------
// checkVersionTransition: release PR backstop
// ---------------------------------------------------------------------------

describe('checkVersionTransition release PRs', () => {
  it('passes a patch step', () => {
    assert.equal(checkVersionTransition(releasePr()), null)
  })

  it('ignores markers in the release PR body, which describes already-merged work', () => {
    const body = 'BEGIN_COMMIT_OVERRIDE\nfeat!: replace the proxy\nEND_COMMIT_OVERRIDE'

    assert.equal(checkVersionTransition(releasePr({ body })), null)
  })

  it('fails a minor step with no approval', () => {
    const failure = checkVersionTransition(
      releasePr({
        title: 'chore(main): release 0.99.0',
        headManifest: { '.': '0.99.0' },
      }),
    )

    assert.match(failure, /0\.99\.0 from 0\.98\.0/)
    assert.match(failure, /minor version transition/)
    assert.match(failure, /version-transition-approved/)
  })

  it('passes a minor step with the approval label', () => {
    assert.equal(
      checkVersionTransition(
        releasePr({
          title: 'chore(main): release 0.99.0',
          headManifest: { '.': '0.99.0' },
          approved: true,
        }),
      ),
      null,
    )
  })

  it('fails a major step with no approval', () => {
    const failure = checkVersionTransition(
      releasePr({
        title: 'chore(main): release 1.0.0',
        headManifest: { '.': '1.0.0' },
      }),
    )

    assert.match(failure, /1\.0\.0 from 0\.98\.0/)
    assert.match(failure, /major version transition/)
  })

  it('fails the step into 1.0 from the last minor with no approval', () => {
    const failure = checkVersionTransition(
      releasePr({
        title: 'chore(main): release 1.0.0',
        baseManifest: { '.': '0.99.0' },
        headManifest: { '.': '1.0.0' },
      }),
    )

    assert.match(failure, /1\.0\.0 from 0\.99\.0/)
    assert.match(failure, /version-transition-approved/)
  })

  it('passes an ordinary feature release after 1.0', () => {
    assert.equal(
      checkVersionTransition(
        releasePr({
          title: 'chore(main): release 1.1.0',
          baseManifest: { '.': '1.0.0' },
          headManifest: { '.': '1.1.0' },
        }),
      ),
      null,
    )
  })

  it('fails an ordinary breaking release after 1.0', () => {
    const failure = checkVersionTransition(
      releasePr({
        title: 'chore(main): release 2.0.0',
        baseManifest: { '.': '1.4.2' },
        headManifest: { '.': '2.0.0' },
      }),
    )

    assert.match(failure, /2\.0\.0 from 1\.4\.2/)
    assert.match(failure, /major version transition/)
    assert.match(failure, /version-transition-approved/)
  })

  it('passes a breaking release after 1.0 with the approval label', () => {
    assert.equal(
      checkVersionTransition(
        releasePr({
          title: 'chore(main): release 2.0.0',
          baseManifest: { '.': '1.4.2' },
          headManifest: { '.': '2.0.0' },
          approved: true,
        }),
      ),
      null,
    )
  })

  it('still fails a pre-1.0 minor step after the patch line has moved', () => {
    const failure = checkVersionTransition(
      releasePr({
        title: 'chore(main): release 0.100.0',
        baseManifest: { '.': '0.99.3' },
        headManifest: { '.': '0.100.0' },
      }),
    )

    assert.match(failure, /0\.100\.0 from 0\.99\.3/)
    assert.match(failure, /version-transition-approved/)
  })

  it('treats a pre-release base on the 0.x line as pre-1.0', () => {
    const failure = checkVersionTransition(
      releasePr({
        title: 'chore(main): release 1.0.0',
        baseManifest: { '.': '0.99.0-rc.1' },
        headManifest: { '.': '1.0.0' },
      }),
    )

    assert.match(failure, /1\.0\.0 from 0\.99\.0-rc\.1/)
    assert.match(failure, /version-transition-approved/)
  })

  it('treats a pre-release base on the 1.x line as post-1.0', () => {
    assert.equal(
      checkVersionTransition(
        releasePr({
          title: 'chore(main): release 1.1.0',
          baseManifest: { '.': '1.0.0-rc.1' },
          headManifest: { '.': '1.1.0' },
        }),
      ),
      null,
    )
  })

  it('fails closed when a manifest version cannot be parsed', () => {
    const failure = checkVersionTransition(
      releasePr({ baseManifest: { '.': 'not-a-version' } }),
    )

    assert.match(failure, /could not be compared: not-a-version to 0\.98\.1/)
    assert.match(failure, /fails closed/)
  })

  it('fails closed when the head manifest is missing', () => {
    const failure = checkVersionTransition(releasePr({ headManifest: null }))

    assert.match(failure, /could not be read from \.release-please-manifest\.json/)
  })

  it('fails closed when the base manifest is missing', () => {
    const failure = checkVersionTransition(releasePr({ baseManifest: null }))

    assert.match(failure, /could not be read from \.release-please-manifest\.json/)
  })

  it('fails a human on a release branch who carries a breaking marker', () => {
    const failure = checkVersionTransition(
      pr({
        title: 'feat!: replace the proxy',
        author: 'contributor',
        headRef: RELEASE_BRANCH,
        baseManifest: { '.': '0.98.0' },
        headManifest: { '.': '0.99.0' },
      }),
    )

    assert.match(failure, /version-transition-approved/)
    assert.match(failure, /title: feat!: replace the proxy/)
  })

  it('fails the release app on another branch that carries a breaking marker', () => {
    const failure = checkVersionTransition(
      pr({
        title: 'feat!: replace the proxy',
        author: BOT,
        headRef: 'chore/release',
      }),
    )

    assert.match(failure, /version-transition-approved/)
    assert.match(failure, /title: feat!: replace the proxy/)
  })
})
