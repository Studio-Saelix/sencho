#!/usr/bin/env node

/**
 * Emits the newest CHANGELOG.md version section so a published GitHub Release
 * can be re-synced from it.
 *
 * release-please writes the release notes into the release pull request body
 * when it opens that PR, and builds the GitHub Release from that stored body
 * at merge time. The contributor credit pass runs after the PR body is
 * written and only rewrites CHANGELOG.md on the branch, so credits reach the
 * repository changelog but never the published release notes. Anything
 * reading release bodies (the releases page, the website changelog) therefore
 * shows uncredited text.
 *
 * Re-publishing the notes from CHANGELOG.md closes that gap. The two are
 * otherwise byte-identical, so this is idempotent when there is nothing to
 * credit.
 *
 * Usage:
 *   node scripts/release-notes-from-changelog.mjs <notes-output-path>
 *
 * Writes the section body to <notes-output-path> and prints the matching tag
 * (e.g. "v0.97.0") to stdout, so the caller can pair the two:
 *
 *   TAG=$(node scripts/release-notes-from-changelog.mjs notes.md)
 *   gh release edit "$TAG" --notes-file notes.md
 *
 * Exits nonzero without writing if the newest section cannot be located or
 * its heading carries no parsable version.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { parseVersionSection } from './credit-changelog-contributors.mjs'

/** Read the version out of a "## [1.2.3](compare-url) (date)" heading. */
export function versionFromHeading(sectionText) {
  const match = sectionText.match(/^##\s+\[([\d.]+)]/)
  return match ? match[1] : null
}

export function main(argv) {
  const notesPath = argv[2]
  if (!notesPath) {
    console.error('Usage: release-notes-from-changelog.mjs <notes-output-path>')
    process.exit(1)
  }

  const changelogPath = resolve(process.cwd(), 'CHANGELOG.md')
  let text
  try {
    text = readFileSync(changelogPath, 'utf-8')
  } catch (err) {
    console.error(`Cannot read CHANGELOG.md: ${err.message}`)
    process.exit(1)
  }

  const section = parseVersionSection(text)
  if (!section) {
    console.error('No version heading found in CHANGELOG.md')
    process.exit(1)
  }

  const notes = text.slice(section.start, section.end).trim()
  const version = versionFromHeading(notes)
  if (!version) {
    console.error('Newest CHANGELOG.md section has no parsable version heading')
    process.exit(1)
  }

  writeFileSync(resolve(process.cwd(), notesPath), `${notes}\n`, 'utf-8')
  process.stdout.write(`v${version}\n`)
}

const runningDirectly =
  process.argv[1] &&
  (process.argv[1].endsWith('release-notes-from-changelog.mjs') ||
    process.argv[1].endsWith('release-notes-from-changelog'))

if (runningDirectly) {
  main(process.argv)
}
