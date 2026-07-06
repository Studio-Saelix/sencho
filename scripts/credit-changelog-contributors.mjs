#!/usr/bin/env node

/**
 * Post-processes CHANGELOG.md on a release-please PR branch, adding a
 * "### Thanks" section that credits external, non-bot contributors whose
 * issue or PR is referenced in the latest release block.
 *
 * Atomic: builds the complete result in memory before touching the file.
 * If any retryable lookup fails, exits nonzero without writing so the
 * existing changelog (including any prior Thanks section) is preserved.
 *
 * Inputs (env):
 *   GITHUB_TOKEN      (required)  GitHub API token
 *   GITHUB_REPOSITORY (required)  e.g. "Studio-Saelix/sencho"
 *   MAINTAINER_LOGINS (optional)  comma-separated logins to exclude (override)
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TOKEN = process.env.GITHUB_TOKEN
const REPO = process.env.GITHUB_REPOSITORY

const MAINTAINER_LOGINS = (process.env.MAINTAINER_LOGINS || '')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean)

const BOT_LOGIN_PATTERN = /\[bot\]$/i
const INTERNAL_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR'])

const GITHUB_API = 'https://api.github.com'
const REQUEST_TIMEOUT_MS = 10_000
const MAX_RETRIES = 3 // 1 initial + 2 retries
const RETRY_WAITS_MS = [1000, 2000]
const MAX_WAIT_PER_RETRY_MS = 15_000
const TOTAL_RETRY_CAP_MS = 40_000

// ---------------------------------------------------------------------------
// GitHub API
// ---------------------------------------------------------------------------

/**
 * Call GET /repos/{owner}/{repo}/issues/{number}.
 * Returns the JSON body or throws on non-2xx.
 */
async function fetchIssue(repo, number, token) {
  const url = `${GITHUB_API}/repos/${repo}/issues/${number}`
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  if (!res.ok) {
    const err = new Error(`GitHub API ${res.status} for #${number}`)
    err.status = res.status
    err.headers = res.headers
    // Attach body text for diagnostics but do not leak into error messages
    try { err.body = await res.text() } catch { /* ignore */ }
    throw err
  }
  return res.json()
}

/** True when the HTTP status is a retryable server/rate-limit error. */
export function shouldRetry(status, headers) {
  if (status === 429) return true
  if (status === 403 && headers) {
    const remaining = headers.get('x-ratelimit-remaining')
    const retryAfter = headers.get('retry-after')
    if (remaining === '0' || retryAfter !== null) return true
  }
  if (status === 502 || status === 503 || status === 504) return true
  return false
}

/** Extract wait seconds from Retry-After header, capped. */
function retryAfterSeconds(headers) {
  if (!headers) return null
  const v = headers.get('retry-after')
  if (!v) return null
  const n = Number(v)
  if (Number.isFinite(n) && n > 0) return Math.min(n, MAX_WAIT_PER_RETRY_MS / 1000)
  return null
}

/**
 * Fetch with bounded retry. Returns the JSON body.
 * Only retries on network errors + shouldRetry() statuses.
 * Non-retryable errors (401, 403 w/o rate-limit, 422, etc.) throw immediately.
 */
async function fetchWithRetry(repo, number, token) {
  let lastError
  const start = Date.now()

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      return await fetchIssue(repo, number, token)
    } catch (err) {
      lastError = err

      // Network errors (fetch throws without status) are always retryable
      const isNetworkError = err.status === undefined
      const retryable = isNetworkError || shouldRetry(err.status, err.headers)

      if (!retryable) throw err
      if (attempt === MAX_RETRIES - 1) throw err

      // Determine wait
      let waitMs = RETRY_WAITS_MS[attempt] ?? RETRY_WAITS_MS[RETRY_WAITS_MS.length - 1]
      const ra = retryAfterSeconds(err.headers)
      if (ra !== null) waitMs = Math.min(ra * 1000, MAX_WAIT_PER_RETRY_MS)

      const elapsed = Date.now() - start
      if (elapsed + waitMs > TOTAL_RETRY_CAP_MS) {
        // Sleep whatever remains before the total cap, then let the loop
        // make its final attempt. If it fails the loop exits and throws.
        const remaining = TOTAL_RETRY_CAP_MS - elapsed
        if (remaining > 0) await sleep(remaining)
        continue
      }

      await sleep(waitMs)
    }
  }
  throw lastError
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

// ---------------------------------------------------------------------------
// Contributor classification
// ---------------------------------------------------------------------------

/**
 * Classify a GitHub API issue/PR response.
 * @returns {'bot' | 'internal' | 'deleted' | 'external'}
 */
export function classifyAuthor(response) {
  const user = response.user
  if (user === null) return 'deleted'
  if (user.type === 'Bot') return 'bot'
  if (BOT_LOGIN_PATTERN.test(user.login)) return 'bot'

  const assoc = response.author_association
  if (assoc && INTERNAL_ASSOCIATIONS.has(assoc)) return 'internal'

  if (MAINTAINER_LOGINS.includes(user.login.toLowerCase())) return 'internal'

  return 'external'
}

// ---------------------------------------------------------------------------
// Changelog parsing
// ---------------------------------------------------------------------------

const VERSION_HEADING_RE = /^##\s+\[[\d.]+]/

/**
 * Locate the first version heading and return its character-index range.
 * The block runs from the heading line to the next version heading or EOF.
 * @returns {{ start: number, end: number } | null}
 */
export function parseVersionSection(text) {
  const lines = text.split('\n')
  let headingLine = -1
  for (let i = 0; i < lines.length; i++) {
    if (VERSION_HEADING_RE.test(lines[i])) {
      headingLine = i
      break
    }
  }
  if (headingLine === -1) return null

  // Start: character index of the heading line in the original text
  const start = text.indexOf(lines[headingLine])

  // Find end line: next version heading or EOF
  let endLine = lines.length
  for (let i = headingLine + 1; i < lines.length; i++) {
    if (VERSION_HEADING_RE.test(lines[i])) {
      endLine = i
      break
    }
  }

  // End: if EOF, text.length; otherwise start of the next heading
  let end
  if (endLine === lines.length) {
    end = text.length
  } else {
    end = text.indexOf(lines[endLine], start)
  }

  return { start, end }
}

/**
 * Extract unique same-repository issue/PR numbers from markdown text.
 * Only accepts URLs whose owner/repo matches the given repo (case-insensitive)
 * and whose path is /issues/N or /pull/N.
 */
export function extractReferences(text, owner, repo) {
  const numbers = new Set()

  // Match markdown links: [text](url)
  // Patterns we capture:
  //   ([#N](https://github.com/OWNER/REPO/issues/N))
  //   ([#N](https://github.com/OWNER/REPO/pull/N))
  //   closes [#N](https://github.com/OWNER/REPO/issues/N)
  //   fixes [#N](...), resolves [#N](...)
  const linkRe = /\[#(\d+)]\(https:\/\/github\.com\/([^/]+)\/([^/]+)\/(issues|pull)\/(\d+)\)/gi

  let match
  while ((match = linkRe.exec(text)) !== null) {
    const linkOwner = match[2]
    const linkRepo = match[3]
    const pathType = match[4]
    const linkNumber = Number(match[5])
    const capturedNumber = Number(match[1])

    // The captured #N must match the URL number
    if (capturedNumber !== linkNumber) continue

    // Must be same repo (case-insensitive)
    if (linkOwner.toLowerCase() !== owner.toLowerCase()) continue
    if (linkRepo.toLowerCase() !== repo.toLowerCase()) continue

    // Must be /issues/ or /pull/
    if (pathType !== 'issues' && pathType !== 'pull') continue

    numbers.add(linkNumber)
  }

  return [...numbers].sort((a, b) => a - b)
}

// ---------------------------------------------------------------------------
// Thanks section
// ---------------------------------------------------------------------------

/**
 * Build the "### Thanks" section from a contributor map.
 * @param {Map<string, { displayName: string, items: { kind: string, number: number, url: string }[] }>} contributors
 */
export function buildThanksSection(contributors) {
  if (contributors.size === 0) return ''

  const sorted = [...contributors.entries()].sort(([a], [b]) =>
    a.toLowerCase().localeCompare(b.toLowerCase()),
  )

  const lines = ['### Thanks', '']
  for (const [login, entry] of sorted) {
    const refs = entry.items
      .sort((a, b) => a.number - b.number)
      .map((item) => `[#${item.number}](${item.url})`)
      .join(', ')
    lines.push(`* @${entry.displayName} for ${refs}`)
  }

  return lines.join('\n')
}

const THANKS_HEADING_RE = /^###\s+Thanks\s*$/

/**
 * Remove any existing "### Thanks" block from within [start, end).
 * A Thanks block starts with "### Thanks" and ends at the next "### " heading,
 * blank line before a "## " heading, or the section boundary.
 */
export function removeThanksSection(text, start, end) {
  const section = text.slice(start, end)
  const lines = section.split('\n')

  let thanksStart = -1
  for (let i = 0; i < lines.length; i++) {
    if (THANKS_HEADING_RE.test(lines[i])) {
      thanksStart = i
      break
    }
  }

  if (thanksStart === -1) return text

  // Find the end: next "### " heading or section boundary
  let thanksEnd = lines.length
  for (let i = thanksStart + 1; i < lines.length; i++) {
    if (/^###\s/.test(lines[i])) {
      thanksEnd = i
      break
    }
  }

  // Rebuild: drop lines [thanksStart, thanksEnd), preserve trailing blank
  const before = lines.slice(0, thanksStart)
  const after = lines.slice(thanksEnd)

  // Trim trailing blank lines between thanks and next subsection
  while (after.length > 0 && after[0] === '') after.shift()

  const newSection = [...before, ...after].join('\n')
  return text.slice(0, start) + newSection + text.slice(end)
}

/**
 * Inject a Thanks section into the version block after the version heading
 * line and its trailing blank lines, before the first subsection.
 */
export function injectThanksSection(text, thanksSection, start, end) {
  const section = text.slice(start, end)
  const lines = section.split('\n')

  // Find where the heading + trailing blanks end
  let insertAfter = 0 // line index of the version heading
  for (let i = 0; i < lines.length; i++) {
    if (VERSION_HEADING_RE.test(lines[i])) {
      insertAfter = i
      break
    }
  }
  // Skip trailing blank lines after the heading
  while (insertAfter + 1 < lines.length && lines[insertAfter + 1] === '') {
    insertAfter++
  }

  const before = lines.slice(0, insertAfter + 1)
  const after = lines.slice(insertAfter + 1)

  // Ensure blank separation
  const parts = [...before]
  if (parts[parts.length - 1] !== '') parts.push('')
  parts.push(thanksSection)
  if (after.length > 0 && after[0] !== '') parts.push('')

  const newSection = [...parts, ...after].join('\n')
  return text.slice(0, start) + newSection + text.slice(end)
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export async function main() {
  // Validate inputs
  if (!TOKEN) {
    console.error('GITHUB_TOKEN is required')
    process.exit(1)
  }
  if (!REPO) {
    console.error('GITHUB_REPOSITORY is required')
    process.exit(1)
  }

  const [owner, repoName] = REPO.split('/')
  if (!owner || !repoName) {
    console.error(`Invalid GITHUB_REPOSITORY: ${REPO}`)
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

  const sectionText = text.slice(section.start, section.end)
  const numbers = extractReferences(sectionText, owner, repoName)

  if (numbers.length === 0) {
    // No references at all -- remove any stale Thanks, exit if no change
    const cleaned = removeThanksSection(text, section.start, section.end)
    writeFileSync(changelogPath, cleaned, 'utf-8')
    process.exit(0)
  }

  // Look up every unique number
  const contributors = new Map()
  for (const num of numbers) {
    let response
    try {
      response = await fetchWithRetry(REPO, num, TOKEN)
    } catch (err) {
      const status = err.status ?? 'network'
      if (status === 404) {
        console.warn(`Skipping #${num}: not found (404)`)
        continue
      }
      if (err.status !== undefined && !shouldRetry(err.status, err.headers)) {
        // Non-retryable error -- fail immediately
        console.error(`Fatal error looking up #${num}: HTTP ${err.status}`)
        process.exit(1)
      }
      // Retryable failure after all retries
      console.error(`Failed to look up #${num} after ${MAX_RETRIES} attempts: ${err.message}`)
      process.exit(1)
    }

    const classification = classifyAuthor(response)
    if (classification === 'external') {
      const login = response.user.login
      if (!contributors.has(login)) {
        contributors.set(login, {
          displayName: login,
          items: [],
        })
      }
      const entry = contributors.get(login)
      const url = response.html_url
      const kind = response.pull_request ? 'pr' : 'issue'
      // Avoid duplicate entries for the same number
      if (!entry.items.some((item) => item.number === num)) {
        entry.items.push({ kind, number: num, url })
      }
    }
  }

  // Build or remove Thanks section
  let newText
  if (contributors.size > 0) {
    const thanks = buildThanksSection(contributors)
    // Remove any existing Thanks first, then inject
    const cleaned = removeThanksSection(text, section.start, section.end)
    newText = injectThanksSection(cleaned, thanks, section.start, section.end)
  } else {
    newText = removeThanksSection(text, section.start, section.end)
  }

  writeFileSync(changelogPath, newText, 'utf-8')
  process.exit(0)
}

// Only run main() when invoked as a script, not when imported for tests.
const runningDirectly =
  process.argv[1] &&
  (process.argv[1].endsWith('credit-changelog-contributors.mjs') ||
    process.argv[1].endsWith('credit-changelog-contributors'))

if (runningDirectly) {
  main().catch((err) => {
    console.error(err.message)
    process.exit(1)
  })
}
