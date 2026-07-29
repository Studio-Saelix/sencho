#!/usr/bin/env node

/**
 * Post-processes CHANGELOG.md on a release-please PR branch, appending an
 * inline ", thanks @login" suffix to each logical top-level changelog bullet
 * whose same-repo issue or PR references were opened by external, non-bot
 * contributors. A bullet's PR number is also checked via the GitHub GraphQL
 * API for issues it closes (`closingIssuesReferences`): those openers are
 * credited under the same bullet even when the issue number never appears
 * as text anywhere (e.g. issues linked through the PR's "Development"
 * sidebar instead of a typed "closes #N"). The managed suffix is written on
 * the last line of the logical entry (the top-level bullet when
 * single-line, otherwise the last indented non-list continuation).
 *
 * Logical entries: a top-level "* " / "- " bullet plus immediately following
 * indented non-list continuation lines. Indented nested list items are copied
 * unchanged and are not association or suffix targets. A blank line, heading,
 * nested list item, or another top-level bullet terminates the entry.
 *
 * Generated suffix grammar (machine-managed only):
 *   , thanks @login
 *   , thanks @alice, @bob
 * Exact manually authored suffixes of this form are indistinguishable and may
 * be stripped or regenerated. Other prose containing "thanks" is preserved.
 *
 * Credits are regenerated from current API classifications each run. Stale
 * suffixes are removed when no mapped external contributors remain. Legacy
 * "### Thanks" blocks are removed from the latest version section only.
 *
 * Atomic: builds the complete result in memory before touching the file.
 * If any retryable lookup fails, exits nonzero without writing so the
 * existing changelog (including any prior credits) is preserved.
 * (Not a filesystem-level atomic rename.)
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
const CLOSING_ISSUES_PAGE_SIZE = 25

/** Exact trailing generated suffix: ", thanks @a" or ", thanks @a, @b" */
const INLINE_THANKS_RE = /, thanks @[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?(?:, @[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?)*\s*$/

const TOP_LEVEL_BULLET_RE = /^[*-] /
const NESTED_LIST_RE = /^\s+[*-] /
const HEADING_RE = /^#{1,3} /
const THANKS_HEADING_RE = /^###\s+Thanks\s*$/
const VERSION_HEADING_RE = /^##\s+\[[\d.]+]/

// ---------------------------------------------------------------------------
// GitHub API
// ---------------------------------------------------------------------------

/** fetch() a GitHub API URL with the shared auth headers and request timeout. */
function githubFetch(url, token, init = {}) {
  return fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      ...init.headers,
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
}

/**
 * Build the error thrown for a non-2xx GitHub response, capturing the body so
 * the failure is diagnosable from CI logs. `api` and `label` compose the
 * message, e.g. ("GitHub API", "#12") reads "GitHub API 500 for #12".
 */
async function githubResponseError(res, api, label) {
  const err = new Error(`${api} ${res.status} for ${label}`)
  err.status = res.status
  err.headers = res.headers
  err.body = await res.text().catch((readErr) => {
    console.warn(`Could not read error body for ${label}: ${readErr.message}`)
    return undefined
  })
  return err
}

/**
 * Call GET /repos/{owner}/{repo}/issues/{number}.
 * Returns the JSON body or throws on non-2xx.
 */
async function fetchIssue(repo, number, token) {
  const res = await githubFetch(`${GITHUB_API}/repos/${repo}/issues/${number}`, token, {
    headers: { 'X-GitHub-Api-Version': '2022-11-28' },
  })
  if (!res.ok) throw await githubResponseError(res, 'GitHub API', `#${number}`)
  return res.json()
}

/** True when the HTTP status is a retryable server/rate-limit error. */
export function shouldRetry(status, headers) {
  if (status === 429 || status === 502 || status === 503 || status === 504) return true
  if (status === 403 && headers) {
    return headers.get('x-ratelimit-remaining') === '0' || headers.get('retry-after') !== null
  }
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
 * Run `operation` with bounded retry. Returns whatever `operation` resolves to.
 * Only retries on network errors + shouldRetry() statuses.
 * Non-retryable errors (401, 403 w/o rate-limit, 422, etc.) throw immediately.
 */
async function withRetry(operation) {
  let lastError
  const start = Date.now()

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      return await operation()
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

const CLOSING_ISSUES_QUERY = `
  query($owner: String!, $repoName: String!, $number: Int!, $pageSize: Int!) {
    repository(owner: $owner, name: $repoName) {
      pullRequest(number: $number) {
        closingIssuesReferences(first: $pageSize) {
          nodes {
            number
            repository { nameWithOwner }
          }
        }
      }
    }
  }
`

/**
 * Map closing-issue nodes to their numbers, dropping any from another
 * repository. Mirrors extractReferences' same-repo rule, so a cross-repo
 * reference can never be looked up (and credited) against the wrong repo's
 * issue of the same number.
 */
function sameRepoIssueNumbers(nodes, owner, repoName, prNumber) {
  const expectedNameWithOwner = `${owner}/${repoName}`.toLowerCase()
  const numbers = []
  for (const node of nodes) {
    if (node.repository.nameWithOwner.toLowerCase() !== expectedNameWithOwner) {
      console.warn(
        `Skipping cross-repo closing reference #${node.number} (${node.repository.nameWithOwner}) on PR #${prNumber}`,
      )
      continue
    }
    numbers.push(node.number)
  }
  return numbers
}

/**
 * Call the GitHub GraphQL API for the same-repo issue numbers a pull request
 * closes. GitHub tracks this link (e.g. via the PR's "Development" sidebar)
 * even when no "closes #N" text ever appears in the PR body or any commit, so
 * a text-only scan of CHANGELOG.md can never discover it.
 * Returns [] when `number` is not a pull request (a plain issue number) or
 * closes nothing.
 * Throws on transport/GraphQL errors (retryable ones are retried by the
 * caller via withRetry).
 */
export async function fetchClosingIssueNumbers(owner, repoName, number, token) {
  const res = await githubFetch(`${GITHUB_API}/graphql`, token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: CLOSING_ISSUES_QUERY,
      variables: { owner, repoName, number, pageSize: CLOSING_ISSUES_PAGE_SIZE },
    }),
  })
  if (!res.ok) throw await githubResponseError(res, 'GitHub GraphQL API', `PR #${number}`)

  const body = await res.json()
  if (body.errors) {
    // A structural GraphQL error (bad query, missing scope) will not be
    // fixed by retrying it, so mark it non-retryable: withRetry() treats
    // any err.status === undefined as a retryable network error.
    const err = new Error(
      `GraphQL error looking up closing issues for PR #${number}: ${body.errors.map((e) => e.message).join('; ')}`,
    )
    err.status = 'graphql-error'
    throw err
  }

  const pr = body.data?.repository?.pullRequest
  if (!pr) {
    console.warn(
      `GraphQL returned no pull request for #${number} despite REST confirming it is one; skipping closing-issue lookup`,
    )
    return []
  }

  const nodes = pr.closingIssuesReferences?.nodes ?? []
  if (nodes.length === CLOSING_ISSUES_PAGE_SIZE) {
    console.warn(
      `PR #${number} closes ${CLOSING_ISSUES_PAGE_SIZE}+ issues; only the first ${CLOSING_ISSUES_PAGE_SIZE} were checked for credit`,
    )
  }
  return sameRepoIssueNumbers(nodes, owner, repoName, number)
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
// Line splitting (LF / CRLF preserving)
// ---------------------------------------------------------------------------

/**
 * Split text into lines preserving each line's trailing newline (or none on EOF).
 * @returns {{ content: string, newline: string, raw: string }[]}
 *   content = line without trailing newline; newline = '\n' | '\r\n' | '\r' | ''
 */
export function splitLines(text) {
  const result = []
  let i = 0
  while (i < text.length) {
    let j = i
    while (j < text.length && text[j] !== '\n' && text[j] !== '\r') j++
    const content = text.slice(i, j)
    let newline = ''
    if (j < text.length) {
      if (text[j] === '\r' && text[j + 1] === '\n') {
        newline = '\r\n'
        j += 2
      } else if (text[j] === '\r') {
        newline = '\r'
        j += 1
      } else {
        newline = '\n'
        j += 1
      }
    }
    result.push({ content, newline, raw: content + newline })
    i = j
  }
  return result
}

export function joinLines(lines) {
  return lines.map((l) => l.raw).join('')
}

/** Rebuild a split line after changing its content (preserves newline). */
function withContent(line, content) {
  if (content === line.content) return line
  return { content, newline: line.newline, raw: content + line.newline }
}

// ---------------------------------------------------------------------------
// Changelog parsing
// ---------------------------------------------------------------------------

/**
 * Locate the first version heading and return its character-index range.
 * The block runs from the heading line to the next version heading or EOF.
 * @returns {{ start: number, end: number } | null}
 */
export function parseVersionSection(text) {
  const lines = splitLines(text)
  let headingLine = -1
  for (let i = 0; i < lines.length; i++) {
    if (VERSION_HEADING_RE.test(lines[i].content)) {
      headingLine = i
      break
    }
  }
  if (headingLine === -1) return null

  const start = text.indexOf(lines[headingLine].raw)

  let endLine = lines.length
  for (let i = headingLine + 1; i < lines.length; i++) {
    if (VERSION_HEADING_RE.test(lines[i].content)) {
      endLine = i
      break
    }
  }

  const end =
    endLine === lines.length ? text.length : text.indexOf(lines[endLine].raw, start)

  return { start, end }
}

/**
 * Extract unique same-repository issue/PR numbers from markdown text.
 * Only accepts URLs whose owner/repo matches the given repo (case-insensitive)
 * and whose path is /issues/N or /pull/N.
 */
export function extractReferences(text, owner, repo) {
  const numbers = new Set()

  const linkRe = /\[#(\d+)]\(https:\/\/github\.com\/([^/]+)\/([^/]+)\/(issues|pull)\/(\d+)\)/gi

  let match
  while ((match = linkRe.exec(text)) !== null) {
    const [, capturedText, linkOwner, linkRepo, , linkPathNumber] = match
    const linkNumber = Number(linkPathNumber)
    if (Number(capturedText) !== linkNumber) continue
    if (linkOwner.toLowerCase() !== owner.toLowerCase()) continue
    if (linkRepo.toLowerCase() !== repo.toLowerCase()) continue
    numbers.add(linkNumber)
  }

  return [...numbers].sort((a, b) => a - b)
}

// ---------------------------------------------------------------------------
// Inline thanks suffix
// ---------------------------------------------------------------------------

/** Sort logins case-insensitively with deterministic tie-break on original. */
export function sortLogins(logins) {
  return [...logins].sort((a, b) => {
    const al = a.toLowerCase()
    const bl = b.toLowerCase()
    if (al !== bl) return al < bl ? -1 : 1
    if (a !== b) return a < b ? -1 : 1
    return 0
  })
}

/** Deduplicate by case-insensitive key, keeping first-seen casing. */
export function dedupeLogins(logins) {
  const seen = new Set()
  const out = []
  for (const login of logins) {
    const key = login.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(login)
  }
  return out
}

/**
 * Remove only the exact trailing generated suffix from a line's content
 * (no trailing newline). Returns content unchanged if no match.
 */
export function stripInlineThanks(content) {
  return content.replace(INLINE_THANKS_RE, '')
}

/**
 * Append ", thanks @a, @b" after stripping any existing generated suffix.
 * Empty logins yields stripped content with no suffix.
 */
export function applyInlineThanks(content, logins) {
  const base = stripInlineThanks(content)
  const unique = sortLogins(dedupeLogins(logins))
  if (unique.length === 0) return base
  return `${base}, thanks ${unique.map((l) => `@${l}`).join(', ')}`
}

// ---------------------------------------------------------------------------
// Legacy ### Thanks removal (latest section only)
// ---------------------------------------------------------------------------

/**
 * Remove any existing "### Thanks" block from within [start, end).
 * A Thanks block starts with "### Thanks" and ends at the next "### " heading
 * or the section boundary.
 */
export function removeThanksSection(text, start, end) {
  const section = text.slice(start, end)
  const lines = splitLines(section)

  let thanksStart = -1
  for (let i = 0; i < lines.length; i++) {
    if (THANKS_HEADING_RE.test(lines[i].content)) {
      thanksStart = i
      break
    }
  }

  if (thanksStart === -1) return text

  let thanksEnd = lines.length
  for (let i = thanksStart + 1; i < lines.length; i++) {
    if (/^###\s/.test(lines[i].content)) {
      thanksEnd = i
      break
    }
  }

  const before = lines.slice(0, thanksStart)
  const after = lines.slice(thanksEnd)

  while (after.length > 0 && after[0].content === '') after.shift()
  while (before.length > 0 && before[before.length - 1].content === '') {
    before.pop()
  }

  if (before.length > 0 && after.length > 0) {
    const nl = before[before.length - 1].newline || after[0].newline || '\n'
    before.push({ content: '', newline: nl, raw: nl })
  }

  const newSection = joinLines([...before, ...after])
  return text.slice(0, start) + newSection + text.slice(end)
}

// ---------------------------------------------------------------------------
// Logical bullet entries
// ---------------------------------------------------------------------------

/**
 * Credit logical top-level bullets in a version section.
 * Strips any managed suffix from every line of the entry, then writes the
 * regenerated suffix on the last line of the logical entry only.
 * @param {string} sectionText latest version section only
 * @param {Map<number, string[]>} loginsByNumber external logins per issue/PR
 *   number. A PR number's list also includes the openers of any issues it
 *   closes (see `fetchClosingIssueNumbers`), even when those issue numbers
 *   never appear in the changelog text.
 * @param {string} owner
 * @param {string} repo
 */
export function creditChangelogEntries(sectionText, loginsByNumber, owner, repo) {
  const lines = splitLines(sectionText)
  const out = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]

    if (!TOP_LEVEL_BULLET_RE.test(line.content)) {
      out.push(line)
      i++
      continue
    }

    // Collect logical entry: top-level bullet + indented non-list continuations
    const entryLines = [line]
    i++
    while (i < lines.length) {
      const next = lines[i]
      if (
        next.content === '' ||
        HEADING_RE.test(next.content) ||
        TOP_LEVEL_BULLET_RE.test(next.content) ||
        NESTED_LIST_RE.test(next.content)
      ) {
        break
      }
      if (!/^\s+\S/.test(next.content)) break
      entryLines.push(next)
      i++
    }

    // Strip managed suffixes from every line so a prior single-line credit
    // does not linger after a continuation is added on a later run.
    for (let j = 0; j < entryLines.length; j++) {
      entryLines[j] = withContent(entryLines[j], stripInlineThanks(entryLines[j].content))
    }

    const blockText = entryLines.map((l) => l.content).join('\n')
    const numbers = extractReferences(blockText, owner, repo)
    const logins = []
    for (const num of numbers) {
      logins.push(...(loginsByNumber.get(num) ?? []))
    }

    const lastIdx = entryLines.length - 1
    entryLines[lastIdx] = withContent(
      entryLines[lastIdx],
      applyInlineThanks(entryLines[lastIdx].content, logins),
    )

    out.push(...entryLines)
  }

  return joinLines(out)
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

/**
 * Look up one issue/PR, reusing `cache` so a number is fetched once even when
 * reached both directly (in the changelog text) and indirectly (as another
 * PR's closed issue). Returns null for a 404; exits nonzero on any other
 * failure so a partial credit pass never reaches the file.
 */
async function fetchIssueOnce(cache, num) {
  if (cache.has(num)) return cache.get(num)

  let response
  try {
    response = await withRetry(() => fetchIssue(REPO, num, TOKEN))
  } catch (err) {
    if (err.status === 404) {
      console.warn(`Skipping #${num}: not found (404)`)
      cache.set(num, null)
      return null
    }
    if (err.status !== undefined && !shouldRetry(err.status, err.headers)) {
      console.error(`Fatal error looking up #${num}: HTTP ${err.status}`)
      process.exit(1)
    }
    console.error(`Failed to look up #${num} after ${MAX_RETRIES} attempts: ${err.message}`)
    process.exit(1)
  }

  cache.set(num, response)
  return response
}

/** Look up the issues a PR closes, exiting nonzero if the lookup fails. */
async function fetchClosingIssueNumbersOrExit(owner, repoName, prNumber) {
  try {
    return await withRetry(() => fetchClosingIssueNumbers(owner, repoName, prNumber, TOKEN))
  } catch (err) {
    console.error(`Failed to look up closing issues for PR #${prNumber}: ${err.message}`)
    process.exit(1)
  }
}

/** Credit `login` under `visibleNumber`, the changelog's own text anchor. */
function addLogin(loginsByNumber, visibleNumber, login) {
  const existing = loginsByNumber.get(visibleNumber)
  if (existing) existing.push(login)
  else loginsByNumber.set(visibleNumber, [login])
}

/**
 * Resolve every changelog-referenced number to the external logins to credit
 * under it.
 * @returns {Promise<Map<number, string[]>>}
 */
async function collectExternalLogins(numbers, owner, repoName) {
  const issueCache = new Map()
  const loginsByNumber = new Map()

  for (const num of numbers) {
    const response = await fetchIssueOnce(issueCache, num)
    if (!response) continue

    if (classifyAuthor(response) === 'external') {
      addLogin(loginsByNumber, num, response.user.login)
    }
    if (!response.pull_request) continue

    // A pull request may close issues that are never mentioned as text
    // anywhere (see fetchClosingIssueNumbers). Credit their external openers
    // under the PR's own number, since that's the only anchor visible in
    // the rendered changelog.
    for (const closedNum of await fetchClosingIssueNumbersOrExit(owner, repoName, num)) {
      const closedResponse = await fetchIssueOnce(issueCache, closedNum)
      if (closedResponse && classifyAuthor(closedResponse) === 'external') {
        addLogin(loginsByNumber, num, closedResponse.user.login)
      }
    }
  }

  return loginsByNumber
}

export async function main() {
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

  text = removeThanksSection(text, section.start, section.end)
  const sectionAfterThanks = parseVersionSection(text)
  if (!sectionAfterThanks) {
    console.error('No version heading found after Thanks removal')
    process.exit(1)
  }

  const sectionText = text.slice(sectionAfterThanks.start, sectionAfterThanks.end)
  const numbers = extractReferences(sectionText, owner, repoName)

  const loginsByNumber = await collectExternalLogins(numbers, owner, repoName)

  const credited = creditChangelogEntries(sectionText, loginsByNumber, owner, repoName)
  const newText =
    text.slice(0, sectionAfterThanks.start) + credited + text.slice(sectionAfterThanks.end)

  writeFileSync(changelogPath, newText, 'utf-8')
  process.exit(0)
}

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
