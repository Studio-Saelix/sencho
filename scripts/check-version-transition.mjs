#!/usr/bin/env node

/**
 * Fails a pull request that moves the release off the patch line without an
 * approval.
 *
 * release-please computes the next version from conventional commits on main.
 * This repository ships pre-1.0 with `bump-patch-for-minor-pre-major`, so a
 * `feat:` stays on the patch line (0.98.0 to 0.98.1). Only a breaking change or
 * an explicit `Release-As` moves the minor or major digit, and that is a
 * maintainer decision rather than something a commit can do on its own.
 *
 * This check detects exactly the markers release-please treats as a version
 * transition and requires the `version-transition-approved` label before one
 * can pass. It deliberately does not calculate the next version: release-please
 * stays the only version engine.
 *
 * The release PR itself is the exception. release-please derives its version
 * from the commits already on main, not from markers in its own body, so for
 * that PR the check compares the base manifest with the proposed manifest and
 * fails a minor or major step unless the label is present. This also closes the
 * gap where a `BEGIN_COMMIT_OVERRIDE` added to an already-merged PR can add a
 * breaking note with no new commit to review.
 *
 * Usage:
 *   PR_TITLE=... PR_BODY=... PR_AUTHOR=... PR_HEAD_REF=... PR_APPROVED=...
 *   PR_COMMITS_FILE=... node scripts/check-version-transition.mjs
 *
 * Exits 0 when the pull request stays on the patch line or carries an approval,
 * and 1 with an explanation when it does not, when a marker is unapproved, or
 * when an input it needs cannot be read.
 */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const MANIFEST_FILE = '.release-please-manifest.json'
const MANIFEST_REF = 'origin/main'
const RELEASE_PR_AUTHOR = 'sencho-quartermaster[bot]'
const RELEASE_BRANCH_PREFIX = 'release-please--'
const APPROVAL_LABEL = 'version-transition-approved'

// A conventional subject with a `!` immediately before the colon. Any type and
// any scope counts, including `feature!`, which release-please aliases to
// `feat`.
const BREAKING_SUBJECT = /^[A-Za-z][A-Za-z0-9-]*(?:\([^()]*\))?!:/

// The two footer spellings the Conventional Commits specification allows.
const BREAKING_FOOTER = /^BREAKING[ -]CHANGE:/i

// release-please's exact-version override note.
const RELEASE_AS = /^Release[- ]As:/i

// One leading list marker, so a bullet cannot hide a footer from the scan.
const LIST_MARKER = /^(?:[-*]\s*|\d+\.\s*)/

function collectMarkers(text, where, found) {
  for (const rawLine of String(text ?? '').split(/\r?\n/)) {
    const line = rawLine.trim().replace(LIST_MARKER, '')
    if (
      BREAKING_SUBJECT.test(line) ||
      BREAKING_FOOTER.test(line) ||
      RELEASE_AS.test(line)
    ) {
      found.push({ where, line })
    }
  }
}

/**
 * Scan the title, the body, and every full commit message for the markers
 * release-please reads as a minor bump, a major bump, or an exact version.
 *
 * The body is scanned in full, including `BEGIN_COMMIT_OVERRIDE` blocks and
 * fenced text: release-please reads the override block as the commit, so a
 * marker inside one counts. Each line is trimmed and one leading `-`, `*`, or
 * numbered list marker is stripped, so formatting cannot hide a marker.
 */
export function findMarkers({ title = '', body = '', commits = [] } = {}) {
  const found = []

  collectMarkers(title, 'title', found)
  collectMarkers(body, 'body', found)

  for (const commit of commits ?? []) {
    collectMarkers(commit, 'commit', found)
  }

  return found
}

/**
 * A release PR is one opened by the release app on a release branch. Both
 * halves are required: a conventional release title alone is not enough, and
 * neither is a matching branch or a matching author on its own.
 */
export function isReleasePr({ author = '', headRef = '' } = {}) {
  return (
    author === RELEASE_PR_AUTHOR &&
    typeof headRef === 'string' &&
    headRef.startsWith(RELEASE_BRANCH_PREFIX)
  )
}

/**
 * The root package version from a parsed release-please manifest, or null when
 * it cannot be read. Every caller treats null as a hard failure.
 */
export function manifestVersion(manifest) {
  const version = manifest?.['.']
  return typeof version === 'string' ? version : null
}

function parseVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?$/.exec(
    String(version ?? '').trim(),
  )

  if (!match) {
    return null
  }

  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) }
}

/**
 * Which digit moved between two versions: `major`, `minor`, `patch`, or `none`.
 * Returns null when either version cannot be parsed, so an unreadable manifest
 * can never be mistaken for a compatible step.
 */
export function versionTransition(baseVersion, headVersion) {
  const base = parseVersion(baseVersion)
  const head = parseVersion(headVersion)

  if (!base || !head) {
    return null
  }

  if (head.major !== base.major) {
    return 'major'
  }

  if (head.minor !== base.minor) {
    return 'minor'
  }

  if (head.patch !== base.patch) {
    return 'patch'
  }

  return 'none'
}

function isApproved(approved) {
  return approved === true || approved === 'true'
}

function markerFailure(markers) {
  const lines = markers.map((marker) => `  ${marker.where}: ${marker.line}`)

  return [
    'This pull request moves the release off the patch line, and no maintainer',
    'has approved a version transition.',
    '',
    'Found:',
    ...lines,
    '',
    'release-please reads these markers as a minor bump, a major bump, or an',
    'exact version:',
    '  a conventional subject with "!" before the colon, such as feat!: or fix(x)!:',
    '  a BREAKING CHANGE: or BREAKING-CHANGE: footer',
    '  a Release-As: or Release As: override',
    '',
    'For a compatible change, reword the title, the body, and the commits so none',
    'of them carries a marker. If this change really is a version transition, a',
    `maintainer applies the ${APPROVAL_LABEL} label to this pull request.`,
  ].join('\n')
}

function releaseTransitionFailure(baseVersion, headVersion, transition) {
  return [
    `This release pull request proposes ${headVersion} from ${baseVersion}, a`,
    `${transition} version transition, and no maintainer has approved it.`,
    '',
    'Compatible changes stay on the patch line. If the transition is intended, a',
    `maintainer applies the ${APPROVAL_LABEL} label to this pull request.`,
  ].join('\n')
}

const MANIFEST_FAILURE = [
  `The release version could not be read from ${MANIFEST_FILE}.`,
  `The base is read from ${MANIFEST_REF} and the head from the pull request.`,
  'This check fails closed, so it cannot pass until both are readable.',
].join('\n')

/**
 * The release PR decision: a patch step passes, and a minor or major step needs
 * the approval label. An unreadable manifest fails closed.
 */
function checkReleaseTransition({ approved, baseManifest, headManifest }) {
  const baseVersion = manifestVersion(baseManifest)
  const headVersion = manifestVersion(headManifest)

  if (!baseVersion || !headVersion) {
    return MANIFEST_FAILURE
  }

  const transition = versionTransition(baseVersion, headVersion)

  if (!transition) {
    return [
      `The manifest versions could not be compared: ${baseVersion} to ${headVersion}.`,
      'This check fails closed.',
    ].join('\n')
  }

  if (transition !== 'major' && transition !== 'minor') {
    return null
  }

  if (isApproved(approved)) {
    return null
  }

  return releaseTransitionFailure(baseVersion, headVersion, transition)
}

/**
 * The whole decision, as one pure function.
 *
 * A release PR is judged against its manifests. Any other PR is judged against
 * its markers: none passes, and any marker needs the approval label. An input
 * that could not be read fails closed, even when the label is present.
 */
export function checkVersionTransition({
  title = '',
  body = '',
  commits = [],
  approved = false,
  author = '',
  headRef = '',
  baseManifest = null,
  headManifest = null,
  commitsRead = true,
} = {}) {
  if (!commitsRead) {
    return [
      'The commit messages for this pull request could not be read.',
      'This check fails closed, so it cannot pass until they are.',
    ].join('\n')
  }

  if (isReleasePr({ author, headRef })) {
    return checkReleaseTransition({ approved, baseManifest, headManifest })
  }

  const markers = findMarkers({ title, body, commits })

  if (markers.length === 0 || isApproved(approved)) {
    return null
  }

  return markerFailure(markers)
}

/**
 * Read the release manifest at a git ref. Any failure returns null, which the
 * decision reports as a closed gate rather than an approval.
 */
function readManifestFromGit(ref) {
  try {
    return JSON.parse(
      execFileSync('git', ['show', `${ref}:${MANIFEST_FILE}`], {
        cwd: repoRoot,
        encoding: 'utf8',
      }),
    )
  } catch {
    return null
  }
}

/**
 * Read the release manifest from the working tree. Any failure returns null,
 * which the decision reports as a closed gate rather than an approval.
 */
function readManifestFromWorkspace() {
  try {
    return JSON.parse(readFileSync(resolve(repoRoot, MANIFEST_FILE), 'utf8'))
  } catch {
    return null
  }
}

function readCommits(commitsFile) {
  if (!commitsFile) {
    return { commits: [], commitsRead: false }
  }

  try {
    const commits = readFileSync(commitsFile, 'utf8')
      .split('\u0000')
      .map((commit) => commit.trim())
      .filter((commit) => commit !== '')

    return { commits, commitsRead: true }
  } catch {
    return { commits: [], commitsRead: false }
  }
}

export function main(env = process.env) {
  const input = {
    title: env.PR_TITLE ?? '',
    body: env.PR_BODY ?? '',
    approved: env.PR_APPROVED ?? '',
    author: env.PR_AUTHOR ?? '',
    headRef: env.PR_HEAD_REF ?? '',
    ...readCommits(env.PR_COMMITS_FILE ?? ''),
  }

  if (isReleasePr(input)) {
    input.baseManifest = readManifestFromGit(MANIFEST_REF)
    input.headManifest = readManifestFromWorkspace()
  }

  const failure = checkVersionTransition(input)

  if (failure) {
    console.error(failure)
    process.exit(1)
  }

  console.log('OK: the version transition check passed.')
}

const runningDirectly =
  process.argv[1] &&
  (process.argv[1].endsWith('check-version-transition.mjs') ||
    process.argv[1].endsWith('check-version-transition'))

if (runningDirectly) {
  main()
}
