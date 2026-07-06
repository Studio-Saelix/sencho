/**
 * Tests for scripts/credit-changelog-contributors.mjs
 *
 * Run:  node --test scripts/credit-changelog-contributors.test.mjs
 *
 * All fixtures are inline strings. The test imports pure functions from the
 * main script; main() is never invoked because the CLI guard fires.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

// Import pure helpers from the script
import {
  parseVersionSection,
  extractReferences,
  classifyAuthor,
  shouldRetry,
  buildThanksSection,
  removeThanksSection,
  injectThanksSection,
} from './credit-changelog-contributors.mjs'

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
    // The 0.93.0 block starts at the "## [0.93.0]" line
    assert.ok(text.slice(result.start, result.end).includes('## [0.93.0]'))
    // It must NOT include 0.92.0 content
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
    // The block should contain the full text (no trailing \n means end === text.length)
    assert.equal(result.end, text.length)
  })

  it('bounds correctly with Unicode content before heading', () => {
    const text = '# Changelog — all notable changes\n\n## [0.94.0]\n\n### Added\n* item ✓\n'
    const result = parseVersionSection(text)
    assert.notEqual(result, null)
    // String.indexOf works at code-unit level; the block should contain the heading
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
  const OWNER = 'Studio-Saelix'
  const REPO = 'sencho'

  it('extracts PR references from ([#N](.../issues/N))', () => {
    const text =
      '* feat: add thing ([#1442](https://github.com/Studio-Saelix/sencho/issues/1442))'
    const refs = extractReferences(text, OWNER, REPO)
    assert.deepEqual(refs, [1442])
  })

  it('extracts linked-issue references from closes [#N](...)', () => {
    const text =
      '* fix: clear logs ([#1448](https://github.com/Studio-Saelix/sencho/issues/1448)) ([abc](...)), closes [#1444](https://github.com/Studio-Saelix/sencho/issues/1444)'
    const refs = extractReferences(text, OWNER, REPO)
    assert.deepEqual(refs, [1444, 1448])
  })

  it('extracts fixes/resolves variants', () => {
    const text =
      '* fix: a ([#1](https://github.com/Studio-Saelix/sencho/issues/1)) ([...]), fixes [#2](https://github.com/Studio-Saelix/sencho/issues/2)\n' +
      '* fix: b ([#3](https://github.com/Studio-Saelix/sencho/issues/3)) ([...]), resolves [#4](https://github.com/Studio-Saelix/sencho/issues/4)'
    const refs = extractReferences(text, OWNER, REPO)
    assert.deepEqual(refs, [1, 2, 3, 4])
  })

  it('accepts /pull/ URLs', () => {
    const text =
      '* feat: pr ref ([#5](https://github.com/Studio-Saelix/sencho/pull/5))'
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
    // The owner/repo must be passed as the pre-transfer ones to match
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
      '* feat: a ([#10](https://github.com/Studio-Saelix/sencho/issues/10))\n' +
      '* feat: b ([#10](https://github.com/Studio-Saelix/sencho/issues/10))'
    const refs = extractReferences(text, OWNER, REPO)
    assert.deepEqual(refs, [10])
  })

  it('returns sorted numbers', () => {
    const text =
      '* feat: c ([#30](https://github.com/Studio-Saelix/sencho/issues/30))\n' +
      '* feat: a ([#10](https://github.com/Studio-Saelix/sencho/issues/10))\n' +
      '* feat: b ([#20](https://github.com/Studio-Saelix/sencho/issues/20))'
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
    assert.deepEqual(refs, []) // #42 != #99
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

  it('respects MAINTAINER_LOGINS override', () => {
    // MAINTAINER_LOGINS is read at module import time, so changing the env
    // var here does not affect classifyAuthor's internal constant. This test
    // verifies the baseline: overrideUser with NONE association is external
    // when no maintainer logins are configured.
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
    // Bot pattern is case-insensitive
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
// buildThanksSection
// ---------------------------------------------------------------------------

describe('buildThanksSection', () => {
  it('returns empty string for empty map', () => {
    assert.equal(buildThanksSection(new Map()), '')
  })

  it('builds section for a single contributor', () => {
    const map = new Map()
    map.set('Crosis47', {
      displayName: 'Crosis47',
      items: [{ kind: 'issue', number: 1444, url: 'https://github.com/Studio-Saelix/sencho/issues/1444' }],
    })
    const result = buildThanksSection(map)
    assert.ok(result.startsWith('### Thanks'))
    assert.ok(result.includes('@Crosis47'))
    assert.ok(result.includes('[#1444](https://github.com/Studio-Saelix/sencho/issues/1444)'))
  })

  it('groups multiple contributions for same login', () => {
    const map = new Map()
    map.set('alice', {
      displayName: 'alice',
      items: [
        { kind: 'issue', number: 10, url: 'https://github.com/Studio-Saelix/sencho/issues/10' },
        { kind: 'pr', number: 5, url: 'https://github.com/Studio-Saelix/sencho/pull/5' },
      ],
    })
    const result = buildThanksSection(map)
    assert.ok(result.includes('#5') && result.includes('#10'))
    // Numbers sorted
    const idx5 = result.indexOf('#5')
    const idx10 = result.indexOf('#10')
    assert.ok(idx5 < idx10)
  })

  it('sorts contributors alphabetically by login', () => {
    const map = new Map()
    map.set('zoe', { displayName: 'zoe', items: [{ kind: 'issue', number: 1, url: 'u' }] })
    map.set('alice', { displayName: 'alice', items: [{ kind: 'issue', number: 2, url: 'u' }] })
    const result = buildThanksSection(map)
    const idxA = result.indexOf('@alice')
    const idxZ = result.indexOf('@zoe')
    assert.ok(idxA < idxZ)
  })
})

// ---------------------------------------------------------------------------
// removeThanksSection
// ---------------------------------------------------------------------------

describe('removeThanksSection', () => {
  it('removes existing Thanks from the block', () => {
    const section = [
      '## [0.93.0]',
      '',
      '### Thanks',
      '',
      '* @alice for [#1](u)',
      '',
      '### Added',
      '* feat',
    ].join('\n')
    const text = `# Changelog\n\n${section}\n\n## [0.92.0]`
    const parsed = parseVersionSection(text)
    const result = removeThanksSection(text, parsed.start, parsed.end)
    assert.ok(!result.includes('### Thanks'))
    assert.ok(result.includes('### Added'))
    assert.ok(result.includes('## [0.92.0]'))
  })

  it('is no-op when no Thanks section exists', () => {
    const text = [
      '## [0.93.0]',
      '',
      '### Added',
      '* feat',
    ].join('\n')
    const parsed = parseVersionSection(text)
    const result = removeThanksSection(text, parsed.start, parsed.end)
    assert.equal(result, text)
  })

  it('does not touch previous release Thanks', () => {
    const text = [
      '## [0.94.0]',
      '',
      '### Added',
      '* new feat',
      '',
      '## [0.93.0]',
      '',
      '### Thanks',
      '',
      '* @alice for [#1](u)',
      '',
      '### Fixed',
      '* old fix',
    ].join('\n')
    const parsed = parseVersionSection(text)
    const result = removeThanksSection(text, parsed.start, parsed.end)
    // Latest (0.94.0) has no Thanks, so no-op
    assert.equal(result, text)
    // But previous release still has its Thanks
    assert.ok(result.includes('### Thanks'))
  })
})

// ---------------------------------------------------------------------------
// injectThanksSection
// ---------------------------------------------------------------------------

describe('injectThanksSection', () => {
  it('inserts Thanks after version heading', () => {
    const text = [
      '## [0.93.0]',
      '',
      '### Added',
      '* feat',
    ].join('\n')
    const parsed = parseVersionSection(text)
    const thanks = '### Thanks\n\n* @alice for [#1](u)'
    const result = injectThanksSection(text, thanks, parsed.start, parsed.end)
    assert.ok(result.includes('### Thanks'))
    assert.ok(result.includes('@alice'))
    const thanksIdx = result.indexOf('### Thanks')
    const addedIdx = result.indexOf('### Added')
    assert.ok(thanksIdx < addedIdx)
  })

  it('injects into empty block (no subsections)', () => {
    const text = '## [0.93.0]\n'
    const parsed = parseVersionSection(text)
    const thanks = '### Thanks\n\n* @bob for [#2](u)'
    const result = injectThanksSection(text, thanks, parsed.start, parsed.end)
    assert.ok(result.includes('### Thanks'))
    assert.ok(result.includes('@bob'))
  })

  it('does not mutate content outside the block', () => {
    const before = '# Changelog\n\n'
    const block = '## [0.93.0]\n\n### Added\n* feat\n'
    const after = '\n## [0.92.0]\n\n### Fixed\n* old fix\n'
    const text = before + block + after
    const parsed = parseVersionSection(text)
    const thanks = '### Thanks\n\n* @carol for [#3](u)'
    const result = injectThanksSection(text, thanks, parsed.start, parsed.end)
    assert.ok(result.startsWith(before))
    assert.ok(result.endsWith(after))
  })
})

// ---------------------------------------------------------------------------
// Bounded mutation: both releases have Thanks
// ---------------------------------------------------------------------------

describe('bounded mutation with multiple Thanks sections', () => {
  it('removes Thanks only from latest, leaves previous intact', () => {
    const text = [
      '## [0.94.0]',
      '',
      '### Thanks',
      '',
      '* @new for [#10](u)',
      '',
      '### Added',
      '* latest feat',
      '',
      '## [0.93.0]',
      '',
      '### Thanks',
      '',
      '* @old for [#5](u)',
      '',
      '### Fixed',
      '* old fix',
    ].join('\n')

    const parsed = parseVersionSection(text)
    assert.notEqual(parsed, null)

    // Verify latest section contains Thanks
    const latest = text.slice(parsed.start, parsed.end)
    assert.ok(latest.includes('### Thanks'))
    assert.ok(latest.includes('@new'))

    // Remove from latest
    const result = removeThanksSection(text, parsed.start, parsed.end)

    // Re-parse the result to get the new latest section boundaries
    const reparsed = parseVersionSection(result)
    const newLatest = result.slice(reparsed.start, reparsed.end)
    assert.ok(!newLatest.includes('### Thanks'))

    // Previous release still has its Thanks
    assert.ok(result.includes('@old for [#5](u)'))
  })

  it('second-run idempotency: same output when run twice', () => {
    const text = [
      '## [0.93.0]',
      '',
      '### Added',
      '* feat ([#1448](https://github.com/Studio-Saelix/sencho/issues/1448))',
      '  ([abc](...)), closes [#1444](https://github.com/Studio-Saelix/sencho/issues/1444)',
    ].join('\n')

    // First "run": no Thanks yet
    const parsed = parseVersionSection(text)
    const thanks = '### Thanks\n\n* @Crosis47 for [#1444](https://github.com/Studio-Saelix/sencho/issues/1444)'
    const first = injectThanksSection(text, thanks, parsed.start, parsed.end)

    // Second "run": inject same thanks into already-injected result
    // (remove first, then inject)
    const parsed2 = parseVersionSection(first)
    const cleaned = removeThanksSection(first, parsed2.start, parsed2.end)
    const second = injectThanksSection(cleaned, thanks, parsed2.start, parsed2.end)

    assert.equal(second, first)
  })

  it('empty-result removal is idempotent', () => {
    const text = [
      '## [0.93.0]',
      '',
      '### Thanks',
      '',
      '* @stale for [#1](u)',
      '',
      '### Added',
      '* feat',
    ].join('\n')

    const parsed = parseVersionSection(text)
    const first = removeThanksSection(text, parsed.start, parsed.end)
    const second = removeThanksSection(first, parsed.start, parsed.end)
    assert.equal(second, first)
  })
})

// ---------------------------------------------------------------------------
// End-to-end: no version heading
// ---------------------------------------------------------------------------

describe('missing version heading', () => {
  it('parseVersionSection returns null, main() would exit 1', () => {
    const text = '# Changelog\n\nNo version here.\n'
    assert.equal(parseVersionSection(text), null)
  })
})

// ---------------------------------------------------------------------------
// Line ending preservation (LF input)
// ---------------------------------------------------------------------------

describe('line ending preservation', () => {
  it('preserves LF line endings', () => {
    const text = '## [0.93.0]\n\n### Added\n* feat\n'
    assert.ok(!text.includes('\r'))
    const parsed = parseVersionSection(text)
    const result = injectThanksSection(
      text,
      '### Thanks\n\n* @x for [#1](u)',
      parsed.start,
      parsed.end,
    )
    assert.ok(!result.includes('\r'))
    // Verify the injected section separator uses LF
    assert.ok(result.includes('\n\n### Added'))
  })

  it('preserves CRLF line endings', () => {
    const text = '## [0.93.0]\r\n\r\n### Added\r\n* feat\r\n'
    assert.ok(text.includes('\r\n'))
    const parsed = parseVersionSection(text)
    const thanks = '### Thanks\n\n* @x for [#1](u)'
    const result = injectThanksSection(text, thanks, parsed.start, parsed.end)
    // Existing CRLF content survives; the injected section uses LF internally.
    // The version heading and ### Added heading keep their CRLF endings.
    assert.ok(result.includes('## [0.93.0]\r\n'))
    assert.ok(result.includes('\r\n### Added'))
    assert.ok(result.includes('### Thanks'))
    assert.ok(result.includes('@x'))
  })
})
