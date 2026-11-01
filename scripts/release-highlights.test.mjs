/**
 * Tests for scripts/release-highlights.mjs
 *
 * Run:  node --test scripts/release-highlights.test.mjs
 *
 * The LLM call is replaced by an injected fetch; nothing here touches the network.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  applyToChangelog,
  cleanBullet,
  collectChanges,
  hashChanges,
  generateHighlights,
  insertHighlights,
  readBlockText,
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

  it('rejects empty and non-string output', () => {
    assert.equal(sanitizeHighlights('   '), null)
    assert.equal(sanitizeHighlights(null), null)
  })
})

describe('applyToChangelog', () => {
  it('writes the block into the newest section only', async () => {
    const calls = []
    const out = await applyToChangelog(CHANGELOG, 'key', okFetch('Cordon is here.', calls), 0)
    assert.equal(calls.length, 1)
    assert.match(calls[0].init.body, /Version 0\.99\.0/)
    assert.ok(out.includes('### Highlights\n\n<!-- highlights-hash:'))
    assert.ok(out.includes('Cordon is here.'))
    assert.equal(out.match(/### Highlights/g).length, 1)
    assert.ok(out.endsWith(PREVIOUS))
  })

  it('does not call the model again when the change list is unchanged', async () => {
    const first = await applyToChangelog(CHANGELOG, 'key', okFetch('Cordon is here.'), 0)
    const calls = []
    const second = await applyToChangelog(first, 'key', okFetch('Different.', calls), 0)
    assert.equal(calls.length, 0)
    assert.equal(second, first)
  })

  it('regenerates when the change list moved', async () => {
    const first = await applyToChangelog(CHANGELOG, 'key', okFetch('Old overview.'), 0)
    const grown = first.replace('### Fixed', '### Fixed\n\n* another fix ([#12](https://x/issues/12))')
    const second = await applyToChangelog(grown, 'key', okFetch('New overview.'), 0)
    assert.ok(second.includes('New overview.'))
    assert.ok(!second.includes('Old overview.'))
  })

  it('drops a stale block and warns when no key is available', async () => {
    const withBlock = insertHighlights(CHANGELOG, 'ffffffffffffffff', 'Stale.')
    const out = await applyToChangelog(withBlock, undefined)
    assert.ok(!out.includes('### Highlights'))
    assert.equal(out, CHANGELOG)
  })

  it('fails soft on an API error and on an unusable answer, removing a stale block', async () => {
    const stale = insertHighlights(CHANGELOG, 'ffffffffffffffff', 'Stale.')
    const failing = async () => ({ ok: false, status: 503, json: async () => ({}) })
    assert.equal(await applyToChangelog(CHANGELOG, 'key', failing, 0), CHANGELOG)
    assert.equal(await applyToChangelog(stale, 'key', failing, 0), CHANGELOG)
    assert.equal(await applyToChangelog(CHANGELOG, 'key', okFetch(''), 0), CHANGELOG)
    assert.equal(await applyToChangelog(stale, 'key', okFetch(''), 0), CHANGELOG)
  })

  it('rejects a cut-off answer (finish_reason length) instead of publishing it', async () => {
    const cutOff = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ finish_reason: 'length', message: { content: 'Half a sent' } }] }),
    })
    assert.equal(await applyToChangelog(CHANGELOG, 'key', cutOff, 0), CHANGELOG)
  })

  it('regenerates when the stored block is empty even though its hash matches', async () => {
    const first = await applyToChangelog(CHANGELOG, 'key', okFetch('Cordon is here.'), 0)
    const hollow = first.replace('Cordon is here.', '')
    assert.equal(readBlockText(hollow), '')
    const calls = []
    const again = await applyToChangelog(hollow, 'key', okFetch('Filled in.', calls), 0)
    assert.equal(calls.length, 1)
    assert.ok(again.includes('Filled in.'))
  })

  it('warns instead of silently skipping a section with no bullets', async () => {
    const empty = PREAMBLE + '## [0.99.0](https://x/compare/a...b) (2026-11-02)\n\n\n'
    const lines = []
    const original = console.log
    console.log = (line) => lines.push(String(line))
    try {
      await applyToChangelog(empty, 'key', okFetch('x'), 0)
    } finally {
      console.log = original
    }
    assert.ok(lines.some((l) => l.startsWith('::warning')))
  })

  it('retries once before giving up', async () => {
    let n = 0
    const flaky = async () => {
      n++
      if (n === 1) throw new Error('network')
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'Second try.' } }] }) }
    }
    const out = await applyToChangelog(CHANGELOG, 'key', flaky, 0)
    assert.equal(n, 2)
    assert.ok(out.includes('Second try.'))
  })

  it('leaves a section with no bullets alone', async () => {
    const empty = PREAMBLE + '## [0.99.0](https://x/compare/a...b) (2026-11-02)\n\n\n'
    const calls = []
    assert.equal(await applyToChangelog(empty, 'key', okFetch('x', calls), 0), empty)
    assert.equal(calls.length, 0)
  })
})

describe('hashChanges', () => {
  it('is stable and sensitive to content', () => {
    assert.equal(hashChanges({ Added: ['a'] }), hashChanges({ Added: ['a'] }))
    assert.notEqual(hashChanges({ Added: ['a'] }), hashChanges({ Added: ['b'] }))
  })
})

describe('request contract', () => {
  it('sends the key, disables reasoning, includes the changes, and tries exactly twice', async () => {
    const calls = []
    const failing = async (url, init) => {
      calls.push({ url, init })
      return { ok: false, status: 429, json: async () => ({}) }
    }
    await assert.rejects(() => generateHighlights('0.99.0', { Added: ['fleet: add node cordon'] }, 'secret', failing, 0), /429; then .*429/)
    assert.equal(calls.length, 2)
    const body = JSON.parse(calls[0].init.body)
    assert.equal(calls[0].init.headers.Authorization, 'Bearer secret')
    assert.deepEqual(body.thinking, { type: 'disabled' })
    assert.ok(body.messages[1].content.includes('fleet: add node cordon'))
    assert.ok(body.messages[1].content.includes('Version 0.99.0'))
  })
})

describe('retries', () => {
  it('retries a 5xx and uses the second answer', async () => {
    let calls = 0
    const flaky = async () => {
      calls++
      if (calls === 1) return { ok: false, status: 500, json: async () => ({}) }
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'Second try.' } }] }) }
    }
    assert.equal(await generateHighlights('0.99.0', { Added: ['x'] }, 'k', flaky, 0), 'Second try.')
    assert.equal(calls, 2)
  })

  it('does not retry a rejected request (4xx other than 429)', async () => {
    let calls = 0
    const rejected = async () => {
      calls++
      return { ok: false, status: 401, json: async () => ({}) }
    }
    await assert.rejects(() => generateHighlights('0.99.0', { Added: ['x'] }, 'bad', rejected, 0), /401/)
    assert.equal(calls, 1)
  })

  it('names an oversized answer as too long, not as empty', async () => {
    const tooLong = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ finish_reason: 'stop', message: { content: 'word '.repeat(2000) } }] }),
    })
    await assert.rejects(() => generateHighlights('0.99.0', { Added: ['x'] }, 'k', tooLong, 0), /too long/)
  })
})

describe('block boundaries', () => {
  it('ends the block at an indented category heading', () => {
    const text = SECTION.replace('### Added', '### Highlights\n\n<!-- highlights-hash: 0123456789abcdef -->\n\nOverview.\n\n  ### Added')
    assert.equal(readBlockText(text), 'Overview.')
  })

  it('finds a Highlights heading with extra spacing or trailing blanks', () => {
    const text = SECTION.replace('### Added', '###  Highlights  \n\n<!-- highlights-hash: 0123456789abcdef -->\n\nOverview.\n\n### Added')
    assert.equal(readStoredHash(text), '0123456789abcdef')
    assert.equal(removeHighlights(text), SECTION)
  })
})

describe('block layout contract', () => {
  it('writes exactly the layout the app and the website extractors read', () => {
    const out = insertHighlights(SECTION, '0123456789abcdef', 'One.\n\nTwo.')
    assert.ok(
      out.includes('### Highlights\n\n<!-- highlights-hash: 0123456789abcdef -->\n\nOne.\n\nTwo.\n\n### Added'),
    )
  })

  it('ignores credit suffixes and the Thanks section when building the change list', () => {
    const withThanks = SECTION + '\n### Thanks\n\n* @alice\n'
    assert.deepEqual(collectChanges(withThanks), collectChanges(SECTION))
  })
})

describe('sanitizeHighlights against hostile output', () => {
  it('cannot leave a heading, fence, rule, link, image, mention or comment behind', () => {
    const cases = [
      ['- ### Fixes\nmore', '###'],
      ['1. ## [9.9.9](u) (2026)', '##'],
      ['# # Big', '# '],
      ['> > quoted', '> '],
      ['```\nsome code\n\nmore', '```'],
      ['~~~\nx', '~~~'],
      ['---', '---'],
      ['Ping @octocat see https://evil.example/x and www.evil.example', 'evil.example'],
      ['[x](//evil.example "t") done', 'evil.example'],
      ['![px](//evil.example/p.png "t") done', 'evil.example'],
      ['[click]( //evil.example ) done', 'evil.example'],
      ['[x][1]\n\n[1]: //evil.example', 'evil.example'],
      ['[x]: javascript:alert(1)\n\n[x]', ']:'],
      ['Footnote[^1]\n\n[^1]: note', '[^'],
      ['x <!-- a > b --> y', '<!--'],
      ['Text <!-- unclosed hash: aaaaaaaaaaaaaaaa', '<!--'],
      ['<!-- highlights-hash: aaaaaaaaaaaaaaaa -->\n\nText', 'highlights-hash'],
    ]
    for (const [raw, forbidden] of cases) {
      const out = sanitizeHighlights(raw)
      assert.ok(out === null || !out.includes(forbidden), `${JSON.stringify(raw)} -> ${JSON.stringify(out)}`)
      if (out) assert.ok(!/^\s*#/m.test(out) && !/[\[\]]/.test(out), `structure survived in ${JSON.stringify(out)}`)
    }
  })

  it('keeps the readable text of removed links and mentions', () => {
    assert.equal(sanitizeHighlights('[the docs](https://evil.example) are updated'), 'the docs are updated')
    assert.equal(sanitizeHighlights('[x](javascript:alert(1)) done'), 'x done')
    assert.equal(sanitizeHighlights('![alt text](//evil.example/p.png "t") done'), 'alt text done')
    assert.equal(sanitizeHighlights('Ping @octocat'), 'Ping octocat')
    assert.equal(sanitizeHighlights('See #12 and `code`'), 'See #12 and `code`')
  })

  it('does not let a stray angle bracket swallow text across paragraphs', () => {
    assert.equal(sanitizeHighlights('Fixed a < b.\n\nLater c > d'), 'Fixed a b.\n\nLater c d')
  })

  it('removes a closed comment but keeps the text around it', () => {
    assert.equal(sanitizeHighlights('x <!-- a > b --> y'), 'x y')
  })

  it('cannot reassemble a link, mention, tag or forged marker from its own output', () => {
    const cases = [
      'ww@w.evil.example rocks',
      'http@s://evil.example/x done',
      '&#119;ww.evil.example and https&#58;//evil.example/x',
      'x&#64;evil.example and x &#64;octocat y',
      '<a\nhref=//evil.example>click</a>',
      '<<b>script>alert(1)</script>',
      'a <<b>img src=x> b',
      'hi <<b>!-- highlights-hash: 0123456789abcdef -->x',
    ]
    for (const raw of cases) {
      const out = sanitizeHighlights(raw)
      if (out === null) continue
      assert.ok(!/[<>[\]@]/.test(out), `markup survived in ${JSON.stringify(out)}`)
      assert.ok(!/https?:|www\.|&#?\w+;/i.test(out), `link or entity survived in ${JSON.stringify(out)}`)
    }
    const forged = sanitizeHighlights('hi <<b>!-- highlights-hash: 0123456789abcdef -->x')
    assert.equal(readStoredHash(insertHighlights(SECTION, 'aaaaaaaaaaaaaaaa', forged ?? 'ok')), 'aaaaaaaaaaaaaaaa')
  })

  it('needs a second pass to finish a link that stripping "@" reassembles', () => {
    assert.equal(sanitizeHighlights('ww@w.evil.example rocks'), 'rocks')
    assert.equal(sanitizeHighlights('Visit http@s://evil.example/x today'), 'Visit today')
  })

  it('removes HTML character references, so an encoded mention or address cannot come back', () => {
    assert.equal(sanitizeHighlights('x &#64;octocat y'), 'x octocat y')
    assert.equal(sanitizeHighlights('Mail x&#64;evil.example now'), 'Mail xevil.example now')
  })

  it('rejects an answer that still looks like a URL after sanitizing', () => {
    assert.equal(sanitizeHighlights('&#104;ttps://evil.example'), null)
    assert.equal(sanitizeHighlights('See ftp://evil.example/x'), null)
  })

  it('rejects an absurdly long answer before doing any work on it', () => {
    assert.equal(sanitizeHighlights('[' .repeat(200000)), null)
  })

  it('drops paragraphs that are only list or heading markers', () => {
    assert.equal(sanitizeHighlights('-\n\n1.\n\n#\n\nReal text.'), 'Real text.')
  })

  it('accepts a long multi-paragraph overview but not a runaway one', () => {
    const para = 'Sentence about the release that is a reasonable length. '.repeat(10).trim()
    assert.ok(sanitizeHighlights([para, para, para, para, para].join('\n\n')))
    assert.equal(sanitizeHighlights('x'.repeat(6001)), null)
  })

  it('accepts the website\'s longest real overview size (about 2900 characters)', () => {
    const para = 'A realistic sentence about what changed for operators. '.repeat(9).trim()
    const text = [para, para, para, para, para].join('\n\n')
    assert.ok(text.length > 2400 && sanitizeHighlights(text))
  })
})

describe('command line', () => {
  const script = fileURLToPath(new URL('./release-highlights.mjs', import.meta.url))

  function run(changelog, env = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'release-highlights-'))
    try {
      writeFileSync(join(dir, 'CHANGELOG.md'), changelog)
      const summaryPath = join(dir, 'summary.md')
      const result = spawnSync(process.execPath, [script], {
        cwd: dir,
        env: { PATH: process.env.PATH, GITHUB_STEP_SUMMARY: summaryPath, ...env },
        encoding: 'utf-8',
      })
      let summary = ''
      try {
        summary = readFileSync(summaryPath, 'utf-8')
      } catch {
        // No summary file means nothing was written to it.
      }
      return { result, written: readFileSync(join(dir, 'CHANGELOG.md'), 'utf-8'), summary }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  it('without a key exits 0, warns, records it in the job summary, and strips a stale block', () => {
    const stale = insertHighlights(CHANGELOG, 'ffffffffffffffff', 'Stale.')
    const { result, written, summary } = run(stale)
    assert.equal(result.status, 0)
    assert.match(result.stdout, /::warning title=Release highlights::DEEPSEEK_API_KEY is not set/)
    assert.match(summary, /DEEPSEEK_API_KEY is not set/)
    assert.equal(written, CHANGELOG)
  })

  it('still exits 0 and strips the stale block when the job summary cannot be written', () => {
    const stale = insertHighlights(CHANGELOG, 'ffffffffffffffff', 'Stale.')
    const { result, written } = run(stale, { GITHUB_STEP_SUMMARY: tmpdir() })
    assert.equal(result.status, 0)
    assert.match(result.stderr, /Could not write the job summary/)
    assert.equal(written, CHANGELOG)
  })

  it('exits nonzero when CHANGELOG.md cannot be read', () => {
    const dir = mkdtempSync(join(tmpdir(), 'release-highlights-'))
    try {
      const result = spawnSync(process.execPath, [script], { cwd: dir, encoding: 'utf-8' })
      assert.equal(result.status, 1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
