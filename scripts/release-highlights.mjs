#!/usr/bin/env node

/**
 * Writes a plain-language "### Highlights" block at the top of the newest
 * CHANGELOG.md version section on a release-please PR branch.
 *
 * release-please only produces commit subjects. Operators reading the GitHub
 * release, the Changelog tab, or What's New in the app need an overview, not a
 * list of pull request titles. This script asks an LLM once per distinct set
 * of changes for a few short paragraphs and stores them in the changelog
 * section, which the publish workflow re-publishes as the GitHub Release body.
 * The Release PR diff is where a maintainer reviews the text before merging.
 *
 * Block layout, inserted before the first "### " category heading:
 *
 *   ### Highlights
 *
 *   <!-- highlights-hash: 0123456789abcdef -->
 *
 *   First paragraph.
 *
 *   Second paragraph.
 *
 * The hash covers the cleaned change list. When the stored block's hash matches
 * and the block has text, the LLM is not called again, so a rerun against an
 * untouched release branch (a retried workflow, a manual dispatch) is a no-op.
 * When main moves, release-please rewrites the whole section, which drops the
 * block, and the next run generates a new one for the new change list. Edits to
 * the block are lost whenever main moves, so review the text last, just before
 * merging the Release PR.
 *
 * The block is written here and read by two other parsers that must stay in
 * sync with it: frontend/src/lib/releaseHighlights.ts and the website Worker's
 * extractHighlights (heading text, heading depth, comment form).
 *
 * Fail soft: a missing key, an API error, or an unusable answer never fails the
 * workflow. It prints a warning (also written to the job summary, so a green run
 * that shipped no block is visible), removes a stale block (accuracy over
 * presence), and leaves the rest of the changelog untouched.
 *
 * Inputs (env):
 *   DEEPSEEK_API_KEY (optional)  without it the step warns and does nothing
 */

import { createHash } from 'node:crypto'
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { parseVersionSection, splitLines } from './credit-changelog-contributors.mjs'

export const HIGHLIGHTS_HEADING = '### Highlights'

const CATEGORY_HEADING_RE = /^###\s+(.+?)\s*$/
const ANY_HEADING_RE = /^ {0,3}#{1,3}\s/
const HIGHLIGHTS_HEADING_RE = /^###\s+Highlights\s*$/
const HASH_RE = /^<!--\s*highlights-hash:\s*([0-9a-f]{16})\s*-->$/
const MAX_HIGHLIGHTS_CHARS = 6000
const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions'
const REQUEST_TIMEOUT_MS = 60_000
const ATTEMPTS = 2
const RETRY_DELAY_MS = 3000

const SYSTEM_PROMPT = [
  'You are writing the release overview section for Sencho changelogs. Sencho is a self-hosted, multi-node Docker Compose management dashboard used by operators.',
  '',
  'Given a version number and a set of changes grouped by category, write that overview.',
  '',
  'Rules:',
  '',
  '- Write like a human maintainer explaining the release to other operators.',
  '- Organize related changes into short paragraphs, one theme per paragraph.',
  '- Prefer 2 to 5 paragraphs depending on release size; a small maintenance release can be a single short paragraph.',
  '- Highlight the most important user-facing improvements first.',
  '- Explain the practical impact of changes when appropriate.',
  '- Do not list commits individually.',
  '- Do not use bullet lists.',
  '- Do not use marketing language or hype.',
  '- Do not mention the version number.',
  '- Do not use em dashes.',
  '- Avoid mechanical phrases such as "This release includes", "This update", "Various improvements", or "Several fixes".',
  '- The output should feel like a changelog overview written by an engineer for other operators.',
  '',
  'Formatting:',
  '',
  '- Plain text only: no markdown headings, links, lists, or HTML.',
  '- Separate paragraphs with a blank line.',
  '- Keep paragraphs short, 1 to 3 sentences each.',
  '- Aim for readability over compression.',
  '',
  'Return only the overview text, with no heading, preamble, or closing remark.',
].join('\n')

// ---------------------------------------------------------------------------
// Section parsing
// ---------------------------------------------------------------------------

/** Strip release-please link groups, closes clauses, and credits from a bullet. */
export function cleanBullet(raw) {
  let text = raw
    .replace(/^[*-]\s+/, '')
    .replace(/\s*\(\[[^\]]*\]\([^)]*\)\)/g, '')
    .replace(/,?\s*closes\s+\[[^\]]*\]\([^)]*\)(?:\s*,\s*\[[^\]]*\]\([^)]*\))*/gi, '')
    .replace(/,\s*thanks\s+@[\w-]+(?:,\s*@[\w-]+)*\s*$/i, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
  const scoped = text.match(/^\*\*(.+?):\*\*\s*(.*)$/)
  if (scoped) text = `${scoped[1]}: ${scoped[2]}`
  return text.replace(/\*\*/g, '').trim()
}

/**
 * Group the section's top-level bullets by their "### " category, in document
 * order. Highlights and Thanks are not changes and are skipped.
 * @returns {Record<string, string[]>}
 */
export function collectChanges(sectionText) {
  const grouped = {}
  let current = null
  for (const { content } of splitLines(sectionText)) {
    const heading = content.match(CATEGORY_HEADING_RE)
    if (heading) {
      const name = heading[1]
      current = name === 'Highlights' || name === 'Thanks' ? null : name
      continue
    }
    if (!current || !/^[*-]\s/.test(content)) continue
    const text = cleanBullet(content)
    if (text) (grouped[current] ??= []).push(text)
  }
  return grouped
}

export function hashChanges(grouped) {
  return createHash('sha256').update(JSON.stringify(grouped)).digest('hex').slice(0, 16)
}

/** Character range of an existing Highlights block, or null. */
function findBlock(sectionText) {
  const lines = splitLines(sectionText)
  let offset = 0
  let start = -1
  for (const line of lines) {
    if (start === -1) {
      if (HIGHLIGHTS_HEADING_RE.test(line.content.trim())) start = offset
    } else if (ANY_HEADING_RE.test(line.content)) {
      return { start, end: offset }
    }
    offset += line.raw.length
  }
  return start === -1 ? null : { start, end: sectionText.length }
}

export function readStoredHash(sectionText) {
  const block = findBlock(sectionText)
  if (!block) return null
  for (const { content } of splitLines(sectionText.slice(block.start, block.end))) {
    const match = content.trim().match(HASH_RE)
    if (match) return match[1]
  }
  return null
}

/** The paragraphs of an existing block (hash comment excluded); '' when it has none. */
export function readBlockText(sectionText) {
  const block = findBlock(sectionText)
  if (!block) return ''
  return splitLines(sectionText.slice(block.start, block.end))
    .map((line) => line.content)
    .filter((line) => !HIGHLIGHTS_HEADING_RE.test(line.trim()) && !HASH_RE.test(line.trim()))
    .join('\n')
    .trim()
}

export function removeHighlights(sectionText) {
  const block = findBlock(sectionText)
  if (!block) return sectionText
  return sectionText.slice(0, block.start) + sectionText.slice(block.end)
}

/** Insert the block before the first category heading (or at the end). */
export function insertHighlights(sectionText, hash, paragraphs) {
  const base = removeHighlights(sectionText)
  const block = `${HIGHLIGHTS_HEADING}\n\n<!-- highlights-hash: ${hash} -->\n\n${paragraphs}\n\n`
  const lines = splitLines(base)
  let offset = 0
  for (const line of lines) {
    if (CATEGORY_HEADING_RE.test(line.content)) {
      return base.slice(0, offset) + block + base.slice(offset)
    }
    offset += line.raw.length
  }
  return `${base.replace(/\s*$/, '')}\n\n${block.trimEnd()}\n`
}

// ---------------------------------------------------------------------------
// LLM output
// ---------------------------------------------------------------------------

/** Anything left after sanitizing that could still render as markup, a link, or a mention. */
const RESIDUE_RE = /[<>[\]@]|&(?:#\w+|[A-Za-z]\w*);|:\/\/|www\.|(?:^|\s)\/\//i
const MAX_SANITIZE_PASSES = 5

function sanitizeOnce(raw) {
  const PREFIX_RE = /^\s*(?:#{1,6}(?:\s+|$)|[*+-](?:\s+|$)|\d+[.)](?:\s+|$)|>\s*)/
  const paragraphs = raw
    .replace(/\r\n?/g, '\n')
    .replace(/&(?:#\w+|[A-Za-z]\w*);/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<!--[\s\S]*$/, '')
    .replace(/<\/?[A-Za-z][^<>\n]*>/g, '')
    .replace(/!?\[([^\]]*)\]\((?:[^()]|\([^()]*\))*\)/g, '$1')
    .replace(/[<>[\]]/g, '')
    .replace(/(?:https?:\/\/|www\.)[^\s)]+/gi, '')
    .replace(/(^|[\s(])\/\/\S+/g, '$1')
    .replace(/@/g, '')
    .split(/\n{2,}/)
    .map((p) =>
      p
        .split('\n')
        .map((line) => {
          let out = line
          while (PREFIX_RE.test(out)) out = out.replace(PREFIX_RE, '')
          return out.trim()
        })
        .filter((line) => line && !/^(?:`{3,}|~{3,})/.test(line) && !/^(?:[-*_=]\s*){3,}$/.test(line))
        .join(' '),
    )
    .map((p) => p.replace(/\s*\u2014\s*/g, ', ').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
  return paragraphs.join('\n\n')
}

/**
 * Reduce model output to plain paragraphs. Commit titles are untrusted input
 * that end up in a published release body, so anything that GitHub or the
 * in-app renderer could turn into markup, a link, an image, a mention, a fence
 * or a heading is removed: HTML tags and comments (an unclosed comment drops
 * everything after it), HTML character references, every markdown link or
 * image (the text is kept, the target is dropped), all angle and square
 * brackets, bare and protocol-relative URLs, every "@", code fence lines,
 * thematic breaks, and heading, list and quote prefixes (stripped repeatedly,
 * so "- ### x" cannot leave a heading behind). Em dashes become commas. Inline
 * code and #123 references are left alone.
 *
 * One pass can assemble what an earlier step removed (a stripped "@" joining
 * "ww" and "w.host", a tag split across lines that the paragraph join puts back
 * together), so the passes repeat until the text stops changing, and the result
 * is rejected if anything markup-like is still there after a few passes.
 * @returns {string | null} null when nothing usable remains, the answer is
 *   longer than MAX_HIGHLIGHTS_CHARS, or it cannot be made plain
 */
export function sanitizeHighlights(raw) {
  if (typeof raw !== 'string' || raw.length > MAX_HIGHLIGHTS_CHARS * 4) return null
  let text = raw
  for (let pass = 0; pass < MAX_SANITIZE_PASSES; pass++) {
    const next = sanitizeOnce(text)
    if (next === text) break
    text = next
  }
  if (text === '' || text.length > MAX_HIGHLIGHTS_CHARS || RESIDUE_RE.test(text)) return null
  return text
}

export async function generateHighlights(version, grouped, apiKey, fetchImpl = fetch, retryDelayMs = RETRY_DELAY_MS) {
  const failures = []
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    if (attempt > 1 && retryDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, retryDelayMs))
    try {
      const res = await fetchImpl(DEEPSEEK_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        body: JSON.stringify({
          model: 'deepseek-v4-flash',
          // Observed on this model in the website Worker: with reasoning on, its
          // tokens are billed against max_tokens first and the answer comes back
          // empty with finish_reason "length".
          thinking: { type: 'disabled' },
          temperature: 0.3,
          max_tokens: 1400,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            {
              role: 'user',
              content: `Version ${version}\n\nChanges (grouped by category):\n${JSON.stringify(grouped, null, 2)}`,
            },
          ],
        }),
      })
      if (!res.ok) {
        const failure = new Error(`DeepSeek returned ${res.status}`)
        // A rejected key or request will be rejected again; only 429 and 5xx are worth a retry.
        failure.retryable = res.status === 429 || res.status >= 500
        throw failure
      }
      const data = await res.json()
      const choice = data?.choices?.[0]
      // A cut-off answer ends mid-sentence, which is worse than no overview.
      if (choice?.finish_reason === 'length') throw new Error('DeepSeek answer was cut off')
      const content = choice?.message?.content
      const text = sanitizeHighlights(content)
      if (!text) {
        throw new Error(
          typeof content === 'string' && content.length > MAX_HIGHLIGHTS_CHARS
            ? 'DeepSeek overview was too long'
            : 'DeepSeek returned no usable overview',
        )
      }
      return text
    } catch (err) {
      failures.push(err.message)
      if (err.retryable === false) break
    }
  }
  throw new Error(failures.join('; then '))
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function warn(message) {
  console.log(`::warning title=Release highlights::${message}`)
  const summary = process.env.GITHUB_STEP_SUMMARY
  if (!summary) return
  try {
    appendFileSync(summary, `Release highlights: ${message}\n\n`)
  } catch (err) {
    // The annotation above already carries the message; a broken summary file must not fail the step.
    console.error(`Could not write the job summary: ${err.message}`)
  }
}

/**
 * Compute the new CHANGELOG text. Returns the input unchanged when nothing
 * needs doing. Never throws for generation problems.
 */
export async function applyToChangelog(text, apiKey, fetchImpl = fetch, retryDelayMs = RETRY_DELAY_MS) {
  const section = parseVersionSection(text)
  if (!section) {
    warn('No version heading found in CHANGELOG.md; skipping.')
    return text
  }
  const sectionText = text.slice(section.start, section.end)
  const version = sectionText.match(/^##\s+\[([\d.]+)]/)?.[1]
  const grouped = collectChanges(sectionText)
  if (!version || Object.keys(grouped).length === 0) {
    warn('The newest changelog section has no change bullets to summarize; skipping.')
    return text
  }

  const hash = hashChanges(grouped)
  if (readStoredHash(sectionText) === hash && readBlockText(sectionText)) {
    console.log(`Highlights for ${version} are up to date (${hash}).`)
    return text
  }

  const withoutStale = text.slice(0, section.start) + removeHighlights(sectionText) + text.slice(section.end)
  if (!apiKey) {
    warn('DEEPSEEK_API_KEY is not set; the release will ship without a Highlights block.')
    return withoutStale
  }
  try {
    const paragraphs = await generateHighlights(version, grouped, apiKey, fetchImpl, retryDelayMs)
    const next = insertHighlights(sectionText, hash, paragraphs)
    console.log(`Wrote highlights for ${version} (${hash}).`)
    return text.slice(0, section.start) + next + text.slice(section.end)
  } catch (err) {
    warn(`Could not generate highlights (${err.message}); the release will ship without a Highlights block.`)
    return withoutStale
  }
}

export async function main() {
  const changelogPath = resolve(process.cwd(), 'CHANGELOG.md')
  let text
  try {
    text = readFileSync(changelogPath, 'utf-8')
  } catch (err) {
    console.error(`Cannot read CHANGELOG.md: ${err.message}`)
    process.exit(1)
  }
  const next = await applyToChangelog(text, process.env.DEEPSEEK_API_KEY)
  if (next !== text) writeFileSync(changelogPath, next, 'utf-8')
}

const runningDirectly =
  process.argv[1] &&
  (process.argv[1].endsWith('release-highlights.mjs') || process.argv[1].endsWith('release-highlights'))

if (runningDirectly) {
  await main()
}
