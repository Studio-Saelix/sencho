/**
 * Tests for scripts/release-notes-from-changelog.mjs
 *
 * Run:  node --test scripts/release-notes-from-changelog.test.mjs
 *
 * Fixtures are inline strings, except the end-to-end cases which write a
 * CHANGELOG.md into a temp directory and run main() with cwd pointed at it.
 * main() is never invoked on import because the CLI guard fires.
 */

import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { versionFromHeading, main } from './release-notes-from-changelog.mjs'

const PREAMBLE = [
  '# Changelog',
  '',
  'All notable changes are documented here.',
  '',
].join('\n')

function section(version, date, bullets) {
  return [
    `## [${version}](https://github.com/Studio-Saelix/sencho/compare/v0.0.0...v${version}) (${date})`,
    '',
    '',
    '### Added',
    '',
    ...bullets,
    '',
    '',
  ].join('\n')
}

// ---------------------------------------------------------------------------
// versionFromHeading
// ---------------------------------------------------------------------------

describe('versionFromHeading', () => {
  it('reads the version out of a release-please heading', () => {
    const heading =
      '## [0.97.0](https://github.com/Studio-Saelix/sencho/compare/v0.96.0...v0.97.0) (2026-08-06)'
    assert.equal(versionFromHeading(heading), '0.97.0')
  })

  it('reads a patch version', () => {
    const heading =
      '## [0.94.1](https://github.com/Studio-Saelix/sencho/compare/v0.94.0...v0.94.1) (2026-07-06)'
    assert.equal(versionFromHeading(heading), '0.94.1')
  })

  it('returns null when the heading is not a version heading', () => {
    assert.equal(versionFromHeading('### Added\n\n* something'), null)
  })

  it('returns null when the version heading is not at the start', () => {
    assert.equal(versionFromHeading('intro\n## [0.97.0](url) (2026-08-06)'), null)
  })
})

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

describe('main', () => {
  let dir
  let cwd
  let stdout
  let written

  function run(changelog, notesName = 'notes.md') {
    dir = mkdtempSync(join(tmpdir(), 'release-notes-'))
    writeFileSync(join(dir, 'CHANGELOG.md'), changelog, 'utf-8')
    cwd = process.cwd()
    process.chdir(dir)

    written = ''
    stdout = process.stdout.write
    process.stdout.write = (chunk) => {
      written += chunk
      return true
    }

    try {
      main(['node', 'release-notes-from-changelog.mjs', notesName])
    } finally {
      process.stdout.write = stdout
    }

    return {
      tag: written.trim(),
      notes: readFileSync(join(dir, notesName), 'utf-8'),
    }
  }

  afterEach(() => {
    if (cwd) process.chdir(cwd)
    if (dir) rmSync(dir, { recursive: true, force: true })
    dir = undefined
    cwd = undefined
  })

  it('emits the newest section and its tag', () => {
    const changelog =
      PREAMBLE +
      section('0.97.0', '2026-08-06', ['* newest change']) +
      section('0.96.0', '2026-07-26', ['* older change'])

    const { tag, notes } = run(changelog)

    assert.equal(tag, 'v0.97.0')
    assert.match(notes, /^## \[0\.97\.0]/)
    assert.match(notes, /newest change/)
    assert.doesNotMatch(notes, /older change/)
  })

  it('preserves inline contributor credits verbatim', () => {
    const changelog =
      PREAMBLE +
      section('0.97.0', '2026-08-06', [
        '* account for VM memory ballooning ([#1750](https://github.com/Studio-Saelix/sencho/issues/1750)), thanks @Crosis47',
        '* auto-update stacks by Stack Label ([#1717](https://github.com/Studio-Saelix/sencho/issues/1717)), thanks @Sn00zEZA',
      ])

    const { notes } = run(changelog)

    assert.match(notes, /, thanks @Crosis47$/m)
    assert.match(notes, /, thanks @Sn00zEZA$/m)
  })

  it('excludes the Keep a Changelog preamble', () => {
    const changelog = PREAMBLE + section('0.97.0', '2026-08-06', ['* a change'])

    const { notes } = run(changelog)

    assert.doesNotMatch(notes, /All notable changes/)
    assert.doesNotMatch(notes, /^# Changelog/m)
  })

  it('handles a changelog with a single version section', () => {
    const changelog = PREAMBLE + section('0.1.0', '2026-01-01', ['* first release'])

    const { tag, notes } = run(changelog)

    assert.equal(tag, 'v0.1.0')
    assert.match(notes, /first release/)
  })
})
