/**
 * Tests for scripts/release-highlights.mjs
 *
 * Run:  node --test scripts/release-highlights.test.mjs
 *
 * The LLM call is replaced by an injected fetch; nothing here touches the network.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  applyToChangelog,
  cleanBullet,
  collectChanges,
  hashChanges,
  insertHighlights,
  readStoredHash,
  removeHighlights,
  sanitizeHighlights,
} from './release-highlights.mjs'

const PREAMBLE = '# Changelog\n\nAll notable changes are documented here.\n\n'

const SECTION = [
  '## [0.99.0](https://github.com/Studio-Saelix/sencho/compare/v0.98.1...v0.99.0) (2026-11-02)',
  '',
  '',
  '### Added',
  '',
  '* **fleet:** add node cordon ([#10](https://github.com/Studio-Saelix/sencho/issues/10)) ([abc1234](https://github.com/Studio-Saelix/sencho/commit/abc1234)), closes [#9](https://github.com/Studio-Saelix/sencho/issues/9), thanks @alice',
  '',
  '### Fixed',
  '',
  '* retry the health gate ([#11](https://github.com/Studio-Saelix/sencho/issues/11)) ([def5678](https://github.com/Studio-Saelix/sencho/commit/def5678))',
  '',
  '',
].join('\n')

const PREVIOUS = [
  '## [0.98.1](https://github.com/Studio-Saelix/sencho/compare/v0.98.0...v0.98.1) (2026-10-25)',
  '',
  '',
  '### Fixed',
  '',
  '* old fix ([#1](https://github.com/Studio-Saelix/sencho/issues/1))',
  '',
].join('\n')

const CHANGELOG = PREAMBLE + SECTION + PREVIOUS

function okFetch(content, calls = []) {
  return async (url, init) => {
    calls.push({ url, init })
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }] }) }
  }
}

describe('cleanBullet', () => {
  it('drops link groups, closes clauses, credits and bold markup', () => {
    const raw = SECTION.split('\n').find((l) => l.includes('cordon'))
    assert.equal(cleanBullet(raw), 'fleet: add node cordon')
  })

  it('keeps the label of a link that belongs to the sentence', () => {
    assert.equal(cleanBullet('* address review of [#5](https://x/y)'), 'address review of #5')
  })
})

describe('collectChanges', () => {
  it('groups bullets by category and ignores Highlights and Thanks', () => {
    const withBlock = insertHighlights(SECTION, 'aaaaaaaaaaaaaaaa', 'Prose.\n\n* not a change')
    assert.deepEqual(collectChanges(withBlock), {
      Added: ['fleet: add node cordon'],
      Fixed: ['retry the health gate'],
    })
  })
})

describe('insertHighlights / removeHighlights / readStoredHash', () => {
  it('inserts before the first category heading and round-trips', () => {
    const out = insertHighlights(SECTION, '0123456789abcdef', 'One.\n\nTwo.')
    assert.ok(out.indexOf('### Highlights') < out.indexOf('### Added'))
    assert.equal(readStoredHash(out), '0123456789abcdef')
    assert.equal(removeHighlights(out), SECTION)
  })

  it('replaces an existing block instead of stacking', () => {
    const once = insertHighlights(SECTION, '1111111111111111', 'First.')
    const twice = insertHighlights(once, '2222222222222222', 'Second.')
    assert.equal(twice.match(/### Highlights/g).length, 1)
    assert.equal(readStoredHash(twice), '2222222222222222')
    assert.ok(!twice.includes('First.'))
  })
})

describe('sanitizeHighlights', () => {
  it('flattens structure, links, html and em dashes to plain paragraphs', () => {
    const raw = '# Title\n\nSee [the docs](https://evil.example) <b>now</b> \u2014 really.\n\n- item one\n- item two\n\n> quote'
    assert.equal(
      sanitizeHighlights(raw),
      'Title\n\nSee the docs now, really.\n\nitem one item two\n\nquote',
    )
  })

  it('rejects empty and oversized output', () => {
    assert.equal(sanitizeHighlights('   '), null)
    assert.equal(sanitizeHighlights(null), null)
    assert.equal(sanitizeHighlights('x'.repeat(3000)), null)
  })
})

describe('applyToChangelog', () => {
  it('writes the block into the newest section only', async () => {
    const calls = []
    const out = await applyToChangelog(CHANGELOG, 'key', okFetch('Cordon is here.', calls))
    assert.equal(calls.length, 1)
    assert.match(calls[0].init.body, /Version 0\.99\.0/)
    assert.ok(out.includes('### Highlights\n\n<!-- highlights-hash:'))
    assert.ok(out.includes('Cordon is here.'))
    assert.equal(out.match(/### Highlights/g).length, 1)
    assert.ok(out.endsWith(PREVIOUS))
  })

  it('does not call the model again when the change list is unchanged', async () => {
    const first = await applyToChangelog(CHANGELOG, 'key', okFetch('Cordon is here.'))
    const calls = []
    const second = await applyToChangelog(first, 'key', okFetch('Different.', calls))
    assert.equal(calls.length, 0)
    assert.equal(second, first)
  })

  it('regenerates when the change list moved', async () => {
    const first = await applyToChangelog(CHANGELOG, 'key', okFetch('Old overview.'))
    const grown = first.replace('### Fixed', '### Fixed\n\n* another fix ([#12](https://x/issues/12))')
    const second = await applyToChangelog(grown, 'key', okFetch('New overview.'))
    assert.ok(second.includes('New overview.'))
    assert.ok(!second.includes('Old overview.'))
  })

  it('drops a stale block and warns when no key is available', async () => {
    const withBlock = insertHighlights(CHANGELOG, 'ffffffffffffffff', 'Stale.')
    const out = await applyToChangelog(withBlock, undefined)
    assert.ok(!out.includes('### Highlights'))
    assert.equal(out, CHANGELOG)
  })

  it('fails soft on an API error and on an unusable answer', async () => {
    const failing = async () => ({ ok: false, status: 503, json: async () => ({}) })
    assert.equal(await applyToChangelog(CHANGELOG, 'key', failing), CHANGELOG)
    assert.equal(await applyToChangelog(CHANGELOG, 'key', okFetch('')), CHANGELOG)
  })

  it('retries once before giving up', async () => {
    let n = 0
    const flaky = async () => {
      n++
      if (n === 1) throw new Error('network')
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'Second try.' } }] }) }
    }
    const out = await applyToChangelog(CHANGELOG, 'key', flaky)
    assert.equal(n, 2)
    assert.ok(out.includes('Second try.'))
  })

  it('leaves a section with no bullets alone', async () => {
    const empty = PREAMBLE + '## [0.99.0](https://x/compare/a...b) (2026-11-02)\n\n\n'
    const calls = []
    assert.equal(await applyToChangelog(empty, 'key', okFetch('x', calls)), empty)
    assert.equal(calls.length, 0)
  })
})

describe('hashChanges', () => {
  it('is stable and sensitive to content', () => {
    assert.equal(hashChanges({ Added: ['a'] }), hashChanges({ Added: ['a'] }))
    assert.notEqual(hashChanges({ Added: ['a'] }), hashChanges({ Added: ['b'] }))
  })
})
