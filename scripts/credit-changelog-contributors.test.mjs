/**
 * Tests for scripts/credit-changelog-contributors.mjs
 *
 * Run:  node --test scripts/credit-changelog-contributors.test.mjs
 *
 * All fixtures are inline strings. The test imports pure functions from the
 * main script; main() is never invoked because the CLI guard fires.
 */

import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'

import {
  parseVersionSection,
  extractReferences,
  classifyAuthor,
  shouldRetry,
  stripInlineThanks,
  applyInlineThanks,
  sortLogins,
  dedupeLogins,
  removeThanksSection,
  creditChangelogEntries,
  splitLines,
  joinLines,
  fetchClosingIssueNumbers,
} from './credit-changelog-contributors.mjs'

const OWNER = 'Studio-Saelix'
const REPO = 'sencho'

function sameRepo(n, kind = 'issues') {
  return `[#${n}](https://github.com/${OWNER}/${REPO}/${kind}/${n})`
}

// ---------------------------------------------------------------------------
// parseVersionSection
// ---------------------------------------------------------------------------

describe('parseVersionSection', () => {
  it('finds the first version heading', () => {
    const text = [
      '# Changelog',
      '',
      '## [0.93.0](...) (2026-06-25)',
      '',
      '### Added',
      '* some change',
      '',
      '## [0.92.0](...) (2026-06-19)',
      '',
      '### Fixed',
      '* old fix',
    ].join('\n')

    const result = parseVersionSection(text)
    assert.notEqual(result, null)
    assert.ok(text.slice(result.start, result.end).includes('## [0.93.0]'))
    assert.ok(!text.slice(result.start, result.end).includes('## [0.92.0]'))
  })

  it('returns null when no version heading exists', () => {
    const text = '# Changelog\n\nSome text without a version.\n'
    assert.equal(parseVersionSection(text), null)
  })

  it('handles heading at offset 0', () => {
    const text = '## [1.0.0]\n\n### Added\n* feat\n'
    const result = parseVersionSection(text)
    assert.notEqual(result, null)
    assert.equal(result.start, 0)
  })

  it('handles heading at EOF (no next version)', () => {
    const text = '## [1.0.0]\n\n### Added\n* feat\n'
    const result = parseVersionSection(text)
    assert.notEqual(result, null)
    assert.equal(result.end, text.length)
  })

  it('bounds correctly with Unicode content before heading', () => {
    const text = '# Changelog — all notable changes\n\n## [0.94.0]\n\n### Added\n* item ✓\n'
    const result = parseVersionSection(text)
    assert.notEqual(result, null)
    assert.ok(text.slice(result.start, result.end).startsWith('## [0.94.0]'))
  })

  it('preserves Unicode inside the section', () => {
    const text = [
      '## [0.94.0]',
      '',
      '### Added',
      '* fix: é and 中文 chars',
      '',
      '## [0.93.0]',
    ].join('\n')
    const result = parseVersionSection(text)
    const block = text.slice(result.start, result.end)
    assert.ok(block.includes('é'))
    assert.ok(block.includes('中文'))
    assert.ok(!block.includes('## [0.93.0]'))
  })
})

// ---------------------------------------------------------------------------
// extractReferences
// ---------------------------------------------------------------------------

describe('extractReferences', () => {
  it('extracts PR references from ([#N](.../issues/N))', () => {
    const text = `* feat: add thing (${sameRepo(1442)})`
    const refs = extractReferences(text, OWNER, REPO)
    assert.deepEqual(refs, [1442])
  })

  it('extracts linked-issue references from closes [#N](...)', () => {
    const text =
      `* fix: clear logs (${sameRepo(1448)}) ([abc](...)), closes ${sameRepo(1444)}`
    const refs = extractReferences(text, OWNER, REPO)
    assert.deepEqual(refs, [1444, 1448])
  })

  it('extracts fixes/resolves variants', () => {
    const text =
      `* fix: a (${sameRepo(1)}) ([...]), fixes ${sameRepo(2)}\n` +
      `* fix: b (${sameRepo(3)}) ([...]), resolves ${sameRepo(4)}`
    const refs = extractReferences(text, OWNER, REPO)
    assert.deepEqual(refs, [1, 2, 3, 4])
  })

  it('accepts /pull/ URLs', () => {
    const text = `* feat: pr ref (${sameRepo(5, 'pull')})`
    const refs = extractReferences(text, OWNER, REPO)
    assert.deepEqual(refs, [5])
  })

  it('rejects cross-repo URLs', () => {
    const text =
      '* feat: external ([#99](https://github.com/OtherOrg/other/issues/99))'
    const refs = extractReferences(text, OWNER, REPO)
    assert.deepEqual(refs, [])
  })

  it('accepts pre-transfer org (AnsoCode/Sencho)', () => {
    const text =
      '* old: thing ([#583](https://github.com/AnsoCode/Sencho/issues/583))'
    const refs = extractReferences(text, 'AnsoCode', 'Sencho')
    assert.deepEqual(refs, [583])
  })

  it('rejects commit SHA links', () => {
    const text =
      '* feat: thing ([abc1234](https://github.com/Studio-Saelix/sencho/commit/abc1234))'
    const refs = extractReferences(text, OWNER, REPO)
    assert.deepEqual(refs, [])
  })

  it('deduplicates repeated numbers', () => {
    const text =
      `* feat: a (${sameRepo(10)})\n` +
      `* feat: b (${sameRepo(10)})`
    const refs = extractReferences(text, OWNER, REPO)
    assert.deepEqual(refs, [10])
  })

  it('returns sorted numbers', () => {
    const text =
      `* feat: c (${sameRepo(30)})\n` +
      `* feat: a (${sameRepo(10)})\n` +
      `* feat: b (${sameRepo(20)})`
    const refs = extractReferences(text, OWNER, REPO)
    assert.deepEqual(refs, [10, 20, 30])
  })

  it('rejects non-github.com hosts', () => {
    const text =
      '* feat: other ([#1](https://gitlab.com/Studio-Saelix/sencho/issues/1))'
    const refs = extractReferences(text, OWNER, REPO)
    assert.deepEqual(refs, [])
  })

  it('rejects URLs with mismatched number in text vs URL', () => {
    const text =
      '* feat: wrong ([#42](https://github.com/Studio-Saelix/sencho/issues/99))'
    const refs = extractReferences(text, OWNER, REPO)
    assert.deepEqual(refs, [])
  })
})

// ---------------------------------------------------------------------------
// classifyAuthor
// ---------------------------------------------------------------------------

describe('classifyAuthor', () => {
  it('classifies Bot type as bot', () => {
    assert.equal(
      classifyAuthor({ user: { type: 'Bot', login: 'dependabot[bot]' } }),
      'bot',
    )
  })

  it('classifies [bot] login suffix as bot', () => {
    assert.equal(
      classifyAuthor({
        user: { type: 'User', login: 'sencho-quartermaster[bot]' },
        author_association: 'CONTRIBUTOR',
      }),
      'bot',
    )
  })

  it('classifies OWNER as internal', () => {
    assert.equal(
      classifyAuthor({
        user: { type: 'User', login: 'owner123' },
        author_association: 'OWNER',
      }),
      'internal',
    )
  })

  it('classifies MEMBER as internal', () => {
    assert.equal(
      classifyAuthor({
        user: { type: 'User', login: 'AnsoCode' },
        author_association: 'MEMBER',
      }),
      'internal',
    )
  })

  it('classifies COLLABORATOR as internal', () => {
    assert.equal(
      classifyAuthor({
        user: { type: 'User', login: 'collab1' },
        author_association: 'COLLABORATOR',
      }),
      'internal',
    )
  })

  it('classifies deleted user (null)', () => {
    assert.equal(classifyAuthor({ user: null }), 'deleted')
  })

  it('classifies NONE as external', () => {
    assert.equal(
      classifyAuthor({
        user: { type: 'User', login: 'Crosis47' },
        author_association: 'NONE',
      }),
      'external',
    )
  })

  it('classifies CONTRIBUTOR non-bot as external', () => {
    assert.equal(
      classifyAuthor({
        user: { type: 'User', login: 'helper' },
        author_association: 'CONTRIBUTOR',
      }),
      'external',
    )
  })

  it('respects MAINTAINER_LOGINS override baseline (module-load constant)', () => {
    const prev = process.env.MAINTAINER_LOGINS
    process.env.MAINTAINER_LOGINS = 'overrideUser'
    assert.equal(
      classifyAuthor({
        user: { type: 'User', login: 'overrideUser' },
        author_association: 'NONE',
      }),
      'external',
    )
    process.env.MAINTAINER_LOGINS = prev
  })

  it('case-insensitive login matching', () => {
    assert.equal(
      classifyAuthor({
        user: { type: 'User', login: 'SomeBot[BOT]' },
        author_association: 'NONE',
      }),
      'bot',
    )
  })
})

// ---------------------------------------------------------------------------
// shouldRetry
// ---------------------------------------------------------------------------

describe('shouldRetry', () => {
  function headers(init) {
    return new Headers(init)
  }

  it('retries 429', () => {
    assert.equal(shouldRetry(429, headers()), true)
  })

  it('retries rate-limited 403', () => {
    assert.equal(
      shouldRetry(403, headers({ 'x-ratelimit-remaining': '0' })),
      true,
    )
    assert.equal(
      shouldRetry(403, headers({ 'retry-after': '60' })),
      true,
    )
  })

  it('does not retry normal 403', () => {
    assert.equal(shouldRetry(403, headers()), false)
  })

  it('retries 502/503/504', () => {
    assert.equal(shouldRetry(502, headers()), true)
    assert.equal(shouldRetry(503, headers()), true)
    assert.equal(shouldRetry(504, headers()), true)
  })

  it('does not retry 401', () => {
    assert.equal(shouldRetry(401, headers()), false)
  })

  it('does not retry 422', () => {
    assert.equal(shouldRetry(422, headers()), false)
  })
})

// ---------------------------------------------------------------------------
// fetchClosingIssueNumbers
// ---------------------------------------------------------------------------

describe('fetchClosingIssueNumbers', () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  function mockFetch(jsonBody) {
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => jsonBody,
      text: async () => JSON.stringify(jsonBody),
    })
  }

  it('returns [] when GraphQL resolves pullRequest to null (plain issue number)', async () => {
    mockFetch({ data: { repository: { pullRequest: null } } })
    const result = await fetchClosingIssueNumbers(OWNER, REPO, 42, 'tok')
    assert.deepEqual(result, [])
  })

  it('maps same-repo closing issue nodes to numbers', async () => {
    mockFetch({
      data: {
        repository: {
          pullRequest: {
            closingIssuesReferences: {
              nodes: [{ number: 1652, repository: { nameWithOwner: `${OWNER}/${REPO}` } }],
            },
          },
        },
      },
    })
    const result = await fetchClosingIssueNumbers(OWNER, REPO, 1651, 'tok')
    assert.deepEqual(result, [1652])
  })

  it('drops a closing reference from another repository', async () => {
    mockFetch({
      data: {
        repository: {
          pullRequest: {
            closingIssuesReferences: {
              nodes: [{ number: 99, repository: { nameWithOwner: 'OtherOrg/other' } }],
            },
          },
        },
      },
    })
    const result = await fetchClosingIssueNumbers(OWNER, REPO, 1651, 'tok')
    assert.deepEqual(result, [])
  })

  it('throws a non-retryable error on GraphQL body errors', async () => {
    mockFetch({ errors: [{ message: 'Field does not exist' }] })
    await assert.rejects(
      () => fetchClosingIssueNumbers(OWNER, REPO, 1651, 'tok'),
      (err) => {
        assert.match(err.message, /Field does not exist/)
        assert.equal(err.status, 'graphql-error')
        return true
      },
    )
  })
})

// ---------------------------------------------------------------------------
// Inline thanks helpers
// ---------------------------------------------------------------------------

describe('inline thanks helpers', () => {
  it('strips exact trailing suffix', () => {
    assert.equal(
      stripInlineThanks('closes #1, thanks @auspex'),
      'closes #1',
    )
  })

  it('preserves near-match prose that is not the managed suffix', () => {
    const prose = 'special thanks to everyone who filed bugs'
    assert.equal(stripInlineThanks(prose), prose)
    assert.equal(applyInlineThanks(prose, []), prose)
  })

  it('dedupes case-insensitively keeping first casing', () => {
    assert.deepEqual(dedupeLogins(['Auspex', 'auspex', 'Bob']), ['Auspex', 'Bob'])
  })

  it('sorts case-insensitively with deterministic tie-break', () => {
    assert.deepEqual(sortLogins(['bob', 'Alice', 'alice']), ['Alice', 'alice', 'bob'])
  })

  it('applies sorted unique suffix', () => {
    // First-seen casing wins ('alice'); Alice is dropped as a case-insensitive dup.
    assert.equal(
      applyInlineThanks('line', ['bob', 'alice', 'Alice']),
      'line, thanks @alice, @bob',
    )
  })

  it('removes stale suffix when logins empty', () => {
    assert.equal(
      applyInlineThanks('line, thanks @stale', []),
      'line',
    )
  })
})

// ---------------------------------------------------------------------------
// creditChangelogEntries
// ---------------------------------------------------------------------------

describe('creditChangelogEntries', () => {
  it('0.95.0-style bullet: PR plus closes #1581 becomes thanks @auspex', () => {
    const section = [
      '## [0.95.0](...) (2026-07-12)',
      '',
      '### Fixed',
      `* **drift:** resolve explicit network names that equal compose keys (${sameRepo(1588)}) ([4123793](...)), closes ${sameRepo(1581)}`,
    ].join('\n')

    const map = new Map([[1581, ['auspex']]])
    const result = creditChangelogEntries(section, map, OWNER, REPO)
    assert.ok(result.includes(`, closes ${sameRepo(1581)}, thanks @auspex`))
    assert.ok(!result.includes('thanks @auspex, thanks'))
  })

  it('credits reference on indented non-list continuation line', () => {
    const section = [
      '## [0.93.0]',
      '',
      '### Added',
      `* feat (${sameRepo(1448)})`,
      `  ([abc](...)), closes ${sameRepo(1444)}`,
    ].join('\n')

    const map = new Map([[1444, ['Crosis47']]])
    const result = creditChangelogEntries(section, map, OWNER, REPO)
    assert.ok(result.includes(`closes ${sameRepo(1444)}, thanks @Crosis47`))
    assert.ok(!result.split('\n')[3].includes('thanks'))
  })

  it('dash top-level bullet is credited', () => {
    const section = [
      '## [1.0.0]',
      '',
      `### Fixed`,
      `- fix: thing (${sameRepo(10)})`,
    ].join('\n')
    const map = new Map([[10, ['dashUser']]])
    const result = creditChangelogEntries(section, map, OWNER, REPO)
    assert.ok(result.includes(`- fix: thing (${sameRepo(10)}), thanks @dashUser`))
  })

  it('same-repo #123 credited; cross-repo #123 on other bullet is not', () => {
    const section = [
      '## [1.0.0]',
      '',
      '### Fixed',
      `* same (${sameRepo(123)})`,
      '* cross ([#123](https://github.com/OtherOrg/other/issues/123))',
    ].join('\n')
    const map = new Map([[123, ['sameRepoUser']]])
    const result = creditChangelogEntries(section, map, OWNER, REPO)
    const lines = result.split('\n')
    assert.ok(lines[3].includes(', thanks @sameRepoUser'))
    assert.equal(lines[4], '* cross ([#123](https://github.com/OtherOrg/other/issues/123))')
  })

  it('two externals on one logical bullet: sorted and deduplicated', () => {
    const section = [
      '## [1.0.0]',
      '',
      `* fix (${sameRepo(1)}) closes ${sameRepo(2)}`,
    ].join('\n')
    const map = new Map([
      [1, ['zoe']],
      [2, ['alice']],
    ])
    const result = creditChangelogEntries(section, map, OWNER, REPO)
    assert.ok(result.includes(', thanks @alice, @zoe'))
  })

  it('credits a login attributed to the PR number even when its own number never appears in text (silently-linked issue)', () => {
    // The PR number (1651) is the only thing visible in the changelog text.
    // The issue it silently closes (1652, via GitHub's Development sidebar,
    // with no "closes #" text anywhere) is discovered out-of-band and its
    // opener's login is credited under the PR's own visible number.
    const section = [
      '## [1.0.0]',
      '',
      `* stack glob patterns (${sameRepo(1651)})`,
    ].join('\n')
    const map = new Map([[1651, ['prAuthorExternal', 'issueOpenerExternal']]])
    const result = creditChangelogEntries(section, map, OWNER, REPO)
    assert.ok(result.includes(', thanks @issueOpenerExternal, @prAuthorExternal'))
  })

  it('one contributor on multiple bullets credits each applicable bullet', () => {
    const section = [
      '## [1.0.0]',
      '',
      `* a (${sameRepo(1)})`,
      `* b (${sameRepo(1)})`,
      `* c (${sameRepo(2)})`,
    ].join('\n')
    const map = new Map([
      [1, ['helper']],
      [2, ['other']],
    ])
    const result = creditChangelogEntries(section, map, OWNER, REPO)
    const lines = result.split('\n')
    assert.ok(lines[2].endsWith(', thanks @helper'))
    assert.ok(lines[3].endsWith(', thanks @helper'))
    assert.ok(lines[4].endsWith(', thanks @other'))
  })

  it('second run produces byte-identical output', () => {
    const section = [
      '## [0.93.0]',
      '',
      '### Added',
      `* feat (${sameRepo(1448)})`,
      `  ([abc](...)), closes ${sameRepo(1444)}`,
    ].join('\n')
    const map = new Map([[1444, ['Crosis47']]])
    const first = creditChangelogEntries(section, map, OWNER, REPO)
    const second = creditChangelogEntries(first, map, OWNER, REPO)
    assert.equal(second, first)
  })

  it('strips stale suffix from first line when a continuation is added later', () => {
    const section = [
      '## [1.0.0]',
      '',
      `* feat (${sameRepo(1)}), thanks @old`,
      `  continuation closes ${sameRepo(2)}`,
    ].join('\n')
    const map = new Map([[2, ['newUser']]])
    const result = creditChangelogEntries(section, map, OWNER, REPO)
    const lines = result.split('\n')
    assert.equal(lines[2], `* feat (${sameRepo(1)})`)
    assert.ok(lines[3].endsWith(', thanks @newUser'))
    assert.ok(!lines[2].includes('thanks'))
  })

  it('removes stale inline credit when login map has no matching externals', () => {
    const section = [
      '## [1.0.0]',
      '',
      `* fix (${sameRepo(1)}), thanks @stale`,
    ].join('\n')
    const result = creditChangelogEntries(section, new Map(), OWNER, REPO)
    assert.equal(result.split('\n')[2], `* fix (${sameRepo(1)})`)
  })

  it('bullet with no external refs and no suffix remains byte-identical', () => {
    const section = [
      '## [1.0.0]',
      '',
      '### Added',
      '* feat: plain entry',
      '',
    ].join('\n')
    const result = creditChangelogEntries(section, new Map(), OWNER, REPO)
    assert.equal(result, section)
  })

  it('preserves near-match thanks prose that is not the managed suffix', () => {
    const section = [
      '## [1.0.0]',
      '',
      '* feat: special thanks to reviewers',
    ].join('\n')
    const result = creditChangelogEntries(section, new Map(), OWNER, REPO)
    assert.equal(result, section)
  })

  it('nested list child remains unchanged; suffix on parent', () => {
    const section = [
      '## [1.0.0]',
      '',
      `* parent with ref (${sameRepo(7)})`,
      '  * nested child stays put',
      '* sibling',
    ].join('\n')
    const map = new Map([[7, ['parentUser']]])
    const result = creditChangelogEntries(section, map, OWNER, REPO)
    const lines = result.split('\n')
    assert.equal(lines[2], `* parent with ref (${sameRepo(7)}), thanks @parentUser`)
    assert.equal(lines[3], '  * nested child stays put')
    assert.equal(lines[4], '* sibling')
  })

  it('nested list refs are excluded from parent association', () => {
    const section = [
      '## [1.0.0]',
      '',
      '* parent with no refs',
      `  * nested closes ${sameRepo(7)}`,
    ].join('\n')
    const map = new Map([[7, ['nestedUser']]])
    const result = creditChangelogEntries(section, map, OWNER, REPO)
    assert.equal(result, section)
    assert.ok(!result.includes('thanks'))
  })

  it('blank line terminates logical entry (later prose not absorbed)', () => {
    const section = [
      '## [1.0.0]',
      '',
      `* parent (${sameRepo(1)})`,
      '',
      '  later prose that looks indented',
    ].join('\n')
    const map = new Map([[1, ['user']]])
    const result = creditChangelogEntries(section, map, OWNER, REPO)
    const lines = result.split('\n')
    assert.equal(lines[2], `* parent (${sameRepo(1)}), thanks @user`)
    assert.equal(lines[3], '')
    assert.equal(lines[4], '  later prose that looks indented')
  })

  it('preserves LF after an actual inline rewrite', () => {
    const section = `## [1.0.0]\n\n* feat (${sameRepo(1)})\n`
    assert.ok(!section.includes('\r'))
    const result = creditChangelogEntries(section, new Map([[1, ['u']]]), OWNER, REPO)
    assert.ok(!result.includes('\r'))
    assert.ok(result.includes(`* feat (${sameRepo(1)}), thanks @u\n`))
  })

  it('preserves CRLF after an actual inline rewrite', () => {
    const section = `## [1.0.0]\r\n\r\n* feat (${sameRepo(1)})\r\n`
    const result = creditChangelogEntries(section, new Map([[1, ['u']]]), OWNER, REPO)
    assert.ok(result.includes('## [1.0.0]\r\n'))
    assert.ok(result.includes(`* feat (${sameRepo(1)}), thanks @u\r\n`))
    assert.equal(result.includes('\n') && !result.includes('\r\n'), false)
  })
})

// ---------------------------------------------------------------------------
// removeThanksSection + bounded mutation
// ---------------------------------------------------------------------------

describe('removeThanksSection and bounded mutation', () => {
  it('removes legacy Thanks from latest while preserving historical Thanks', () => {
    const text = [
      '# Changelog',
      '',
      '## [0.95.0]',
      '',
      '### Thanks',
      '',
      '* @auspex for [#1581](u)',
      '',
      '### Added',
      '* feat',
      '',
      '## [0.94.0]',
      '',
      '### Thanks',
      '',
      '* @old for [#5](u)',
      '',
      '### Fixed',
      '* old',
    ].join('\n')

    const parsed = parseVersionSection(text)
    const result = removeThanksSection(text, parsed.start, parsed.end)
    const reparsed = parseVersionSection(result)
    const latest = result.slice(reparsed.start, reparsed.end)
    assert.ok(!latest.includes('### Thanks'))
    assert.ok(!latest.includes('@auspex'))
    assert.ok(result.includes('@old for [#5](u)'))
  })

  it('content before and after latest version remains byte-identical after credit', () => {
    const prefix = '# Changelog\n\nIntro prose.\n\n'
    const latest = [
      '## [1.0.0]',
      '',
      '### Added',
      `* feat (${sameRepo(1)})`,
      '',
    ].join('\n')
    const suffix = '## [0.9.0]\n\n### Fixed\n* old\n'
    const full = prefix + latest + suffix

    const parsed = parseVersionSection(full)
    const section = full.slice(parsed.start, parsed.end)
    const credited = creditChangelogEntries(section, new Map([[1, ['x']]]), OWNER, REPO)
    const out = full.slice(0, parsed.start) + credited + full.slice(parsed.end)

    assert.equal(out.slice(0, parsed.start), prefix)
    assert.equal(out.slice(out.length - suffix.length), suffix)
    assert.ok(out.includes(', thanks @x'))
  })
})

// ---------------------------------------------------------------------------
// splitLines / joinLines round-trip
// ---------------------------------------------------------------------------

describe('splitLines', () => {
  it('round-trips LF and CRLF', () => {
    const lf = 'a\nb\n'
    assert.equal(joinLines(splitLines(lf)), lf)
    const crlf = 'a\r\nb\r\n'
    assert.equal(joinLines(splitLines(crlf)), crlf)
  })
})

// ---------------------------------------------------------------------------
// Workflow expression documentation (empty vs populated pr)
// ---------------------------------------------------------------------------

describe('workflow RELEASE_BRANCH expression (documented behavior)', () => {
  it('empty pr || {} yields no headBranchName (publish-run safe)', () => {
    // Mirrors: fromJSON(steps.release.outputs.pr || '{}').headBranchName || ''
    const pr = ''
    const parsed = JSON.parse(pr || '{}')
    const branch = parsed.headBranchName || ''
    assert.equal(branch, '')
  })

  it('populated pr JSON yields headBranchName', () => {
    const pr = JSON.stringify({
      headBranchName: 'release-please--branches--main--components--sencho',
    })
    const parsed = JSON.parse(pr || '{}')
    const branch = parsed.headBranchName || ''
    assert.equal(branch, 'release-please--branches--main--components--sencho')
  })
})
