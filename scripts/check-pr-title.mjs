#!/usr/bin/env node

/**
 * Validates a pull request title against the Conventional Commits shape.
 *
 * release-please computes the version bump and the changelog by parsing
 * conventional commit subjects off `main`. Squash-merges take the subject from
 * the PR title, so a title the parser cannot read is a change that vanishes
 * from the release notes without any warning. That happened once already: the
 * build-identity feature (#1899) merged with the title "Surface runtime build
 * identity across About, shell, and Admiral Account" and never appeared in any
 * release notes.
 *
 * commitlint only runs as a local commit-msg hook, which fires on the PR branch
 * and never on the squash that actually lands. This check closes that gap for
 * pull requests.
 *
 * The allowed types are read from commitlint.config.js so the local hook and
 * this check cannot drift apart. Only the conventional shape is enforced here:
 * the rules that matter for the release pipeline (a parsable type, and an empty
 * subject). Length, casing, and full commitlint validation stay in the local
 * hook, which sees the whole commit; this runs against a one-line title where a
 * stricter rule set would only produce noise.
 *
 * Usage:
 *   node scripts/check-pr-title.mjs "<title>"
 *
 * Exits 0 when the title parses, 1 with an explanation when it does not.
 */

import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Pull the allowed type list out of commitlint.config.js.
 *
 * The config is CommonJS and lives in this repo, so it is loaded rather than
 * pattern-matched out of its source: reading the file with a regex would break
 * the check on an unrelated reformat (double quotes, a trailing comma), and a
 * silently broken allow-list is worse than no check. Loading it also means the
 * local commit-msg hook and this check can never disagree about the types.
 *
 * A config that cannot be read, or that carries no type-enum, is a hard
 * failure, so the check fails closed instead of approving every title. Takes
 * either a path or an already-loaded config object.
 */
export function allowedTypes(commitlintConfig) {
  const config =
    typeof commitlintConfig === 'string'
      ? createRequire(import.meta.url)(resolve(repoRoot, commitlintConfig))
      : commitlintConfig
  const rule = config?.rules?.['type-enum']
  if (!Array.isArray(rule) || rule.length === 0) {
    throw new Error('No type-enum rule found in commitlint.config.js')
  }

  // commitlint writes a rule as [level, applicability, value], so the allow-list
  // is the trailing array; the shorter [level, value] form drops the middle.
  const types = rule[rule.length - 1]

  if (!Array.isArray(types) || types.length === 0) {
    throw new Error('No type-enum allow-list found in commitlint.config.js')
  }

  return types.filter((type) => typeof type === 'string')
}

/**
 * Parse a title into its conventional-commit parts, or return null when the
 * title does not match `<type>[(<scope>)][!]: <subject>`.
 *
 * The scope character class mirrors what release-please's parser accepts rather
 * than what the spec nominally allows. It tolerates spaces, tabs, and
 * punctuation inside the scope, because the parser does, but it rejects a
 * nested `(`: the parser throws on that shape and release-please catches the
 * throw and drops the commit, so accepting it here would pass a title that
 * silently never reaches the changelog. The same goes for text between the
 * closing paren and the colon.
 */
export function parseTitle(title, types) {
  const match = title.match(/^([a-z]+)(?:\(([^()]+)\))?(!)?: (.+)$/)

  if (!match) {
    return null
  }

  const [, type, scope, breaking, subject] = match

  if (!types.includes(type)) {
    return null
  }

  if (subject.trim() === '') {
    return null
  }

  return { type, scope: scope ?? null, breaking: breaking === '!', subject }
}

export function checkTitle(title, types) {
  const trimmed = (title ?? '').trim()

  if (trimmed === '') {
    return 'The pull request title is empty.'
  }

  if (parseTitle(trimmed, types)) {
    return null
  }

  return [
    `The pull request title is not a Conventional Commit: "${trimmed}"`,
    '',
    'Squash-merging uses the PR title as the commit subject, and release-please',
    'parses those subjects to build the changelog and decide the version bump.',
    'A title it cannot parse drops the change from the release notes entirely.',
    '',
    `Use <type>: <subject>, optionally <type>(<scope>): <subject>.`,
    `Allowed types: ${types.join(', ')}.`,
    '',
    'Examples:',
    '  fix(dashboard): keep the Stack Health name column readable at 1280',
    '  security(deps): bump @grpc/grpc-js to 1.14.5',
  ].join('\n')
}

export function main(argv) {
  const title = argv[2] ?? process.env.PR_TITLE ?? ''
  const types = allowedTypes('commitlint.config.js')
  const failure = checkTitle(title, types)

  if (failure) {
    console.error(failure)
    process.exit(1)
  }

  console.log(`OK: "${title}"`)
}

const runningDirectly =
  process.argv[1] &&
  (process.argv[1].endsWith('check-pr-title.mjs') ||
    process.argv[1].endsWith('check-pr-title'))

if (runningDirectly) {
  main(process.argv)
}