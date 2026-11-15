#!/usr/bin/env node

/**
 * Fails when the gzipped frontend bundle outgrows frontend/bundle-budget.json.
 *
 * Bundle growth is the regression nobody sees in review: one import in the
 * wrong place pulls a heavy dependency into the first page load, and every
 * test still passes. This check runs after `vite build` and compares each
 * group of chunks against a budget, so growth becomes a deliberate, reviewed
 * edit to the budget file instead of an accident.
 *
 * Groups:
 *   entry-js       the module script dist/index.html runs
 *   preload-js     preloaded chunks outside a named group
 *   initial-css    stylesheets dist/index.html links
 *   <name>         a chunk listed in the budget's `namedChunks`, which
 *                  mirrors vite.config.ts `manualChunks`; measured by name
 *                  whether or not index.html preloads it
 *   first-load-js  entry plus every preloaded chunk, named ones included:
 *                  the JavaScript a first visit downloads
 *   workers        Monaco language workers (*.worker chunks)
 *   lazy-js / lazy-css  every other on-demand chunk
 *   total-js       all JavaScript
 *
 * Sizes are gzipped bytes, which is close to what a browser transfers. The
 * check fails loudly rather than passing on a build it cannot read: a group
 * with no budget, a budgeted group that measured nothing, a JS or CSS asset
 * whose name it does not recognise, and an index.html with no entry script
 * are all failures.
 *
 * Usage:
 *   node scripts/check-bundle-size.mjs [--dist frontend/dist] [--budget frontend/bundle-budget.json]
 *
 * Writes the size table to stdout, and to the GitHub job summary when
 * GITHUB_STEP_SUMMARY is set. Exits 1 when the check fails.
 */

import { appendFileSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'

// Rolldown names chunks `<name>-<8 char hash>.<ext>`; the hash alphabet
// includes `-` and `_`.
const HASHED = /^(.+)-[A-Za-z0-9_-]{8}\.(js|css)$/
const CODE_ASSET = /\.(js|mjs|css)$/
const FLAG_OPTIONS = { '--dist': 'dist', '--budget': 'budget' }
const RESERVED_GROUPS = [
  'entry-js', 'preload-js', 'first-load-js', 'initial-css', 'workers', 'lazy-js', 'lazy-css', 'total-js',
]

/** The chunk name without its content hash, or null when the name has no hash. */
export function chunkName(file) {
  const match = HASHED.exec(file)
  return match ? match[1] : null
}

function attribute(tag, name) {
  const match = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag)
  return match ? (match[1] ?? match[2] ?? match[3]) : null
}

function assetFile(url) {
  const match = /^(?:\.?\/)?assets\/([^/?#]+)$/.exec(url ?? '')
  return match ? match[1] : null
}

/**
 * How dist/index.html loads each asset: `entry` for a script under assets/,
 * `preload` for a modulepreload link, `css` for a stylesheet link. Prefetch
 * and icon links are not part of the first load and are left out.
 */
export function initialAssets(indexHtml) {
  const files = new Map()
  for (const [tag] of indexHtml.matchAll(/<(?:script|link)\b[^>]*>/gi)) {
    if (/^<script/i.test(tag)) {
      const file = assetFile(attribute(tag, 'src'))
      if (file) files.set(file, 'entry')
      continue
    }
    const file = assetFile(attribute(tag, 'href'))
    const rel = (attribute(tag, 'rel') ?? '').toLowerCase()
    if (file && rel === 'modulepreload') files.set(file, 'preload')
    if (file && rel === 'stylesheet') files.set(file, 'css')
  }
  return files
}

/** The budget group a built JS or CSS chunk belongs to. */
export function groupOf(file, initial, namedChunks) {
  const name = chunkName(file) ?? ''
  const ext = file.endsWith('.css') ? 'css' : 'js'
  const how = initial.get(file)
  if (how === 'css') return 'initial-css'
  if (how === 'entry') return 'entry-js'
  if (ext === 'js' && namedChunks.includes(name)) return name
  if (how === 'preload') return 'preload-js'
  if (ext === 'js' && name.endsWith('.worker')) return 'workers'
  return `lazy-${ext}`
}

/**
 * Gzipped bytes per group for a built dist directory. Throws when the build
 * cannot be read the way the budget assumes.
 */
export function measure(distDir, namedChunks) {
  const initial = initialAssets(readFileSync(join(distDir, 'index.html'), 'utf8'))
  if (![...initial.values()].includes('entry')) {
    throw new Error(`${join(distDir, 'index.html')} has no module script under assets/`)
  }
  const groups = { 'first-load-js': 0, 'total-js': 0 }
  for (const entry of readdirSync(join(distDir, 'assets'), { withFileTypes: true })) {
    const file = entry.name
    if (!entry.isFile() || !CODE_ASSET.test(file)) continue
    if (chunkName(file) === null) {
      throw new Error(`Unrecognised asset name "${file}": expected <name>-<8 char hash>.js or .css`)
    }
    const group = groupOf(file, initial, namedChunks)
    const bytes = gzipSync(readFileSync(join(distDir, 'assets', file))).length
    groups[group] = (groups[group] ?? 0) + bytes
    if (file.endsWith('.js')) {
      groups['total-js'] += bytes
      const how = initial.get(file)
      if (how === 'entry' || how === 'preload') groups['first-load-js'] += bytes
    }
  }
  return groups
}

/** One row per measured or budgeted group, budget order first. */
export function compare(groups, budgetKb) {
  const names = [...new Set([...Object.keys(budgetKb), ...Object.keys(groups)])]
  return names.map((group) => {
    const bytes = groups[group] ?? 0
    const kb = bytes / 1024
    const budget = budgetKb[group]
    let status = 'ok'
    if (budget === undefined) status = 'no budget'
    else if (bytes === 0) status = 'empty'
    else if (kb > budget) status = 'over'
    return { group, kb, budget, status }
  })
}

export function formatTable(rows) {
  const lines = ['| Group | Gzipped KB | Budget KB | Status |', '|---|---:|---:|---|']
  for (const row of rows) {
    const budget = row.budget === undefined ? '-' : String(row.budget)
    lines.push(`| ${row.group} | ${row.kb.toFixed(1)} | ${budget} | ${row.status} |`)
  }
  return lines.join('\n')
}

/** The budget file, or an error naming what is wrong with it. */
export function parseBudget(text, path) {
  const budget = JSON.parse(text)
  const named = budget.namedChunks
  if (!Array.isArray(named) || !named.every((n) => typeof n === 'string')) {
    throw new Error(`${path}: namedChunks must be an array of chunk names`)
  }
  const reserved = named.find((n) => RESERVED_GROUPS.includes(n))
  if (reserved) throw new Error(`${path}: "${reserved}" is a group name and cannot be a named chunk`)
  const gzipKb = budget.gzipKb
  if (gzipKb === null || typeof gzipKb !== 'object' || Array.isArray(gzipKb)) {
    throw new Error(`${path}: gzipKb must be an object of group to KB`)
  }
  for (const [group, kb] of Object.entries(gzipKb)) {
    if (typeof kb !== 'number' || !Number.isFinite(kb) || kb <= 0) {
      throw new Error(`${path}: budget for "${group}" must be a positive number of KB`)
    }
  }
  return { namedChunks: named, gzipKb }
}

export function parseArgs(args) {
  const options = { dist: 'frontend/dist', budget: 'frontend/bundle-budget.json' }
  for (let i = 0; i < args.length; i += 2) {
    const key = FLAG_OPTIONS[args[i]]
    const value = args[i + 1]
    if (!key) throw new Error(`Unknown argument "${args[i]}". Usage: [--dist <dir>] [--budget <file>]`)
    if (value === undefined || value.startsWith('--')) throw new Error(`${args[i]} needs a value`)
    options[key] = value
  }
  return options
}

function failureMessage(row, budgetPath) {
  if (row.status === 'over') return `is ${row.kb.toFixed(1)} KB gzipped, over its ${row.budget} KB budget`
  if (row.status === 'empty') return `measured 0 bytes; if the chunk is gone, remove it from ${budgetPath}`
  return `has no budget; add it to ${budgetPath}`
}

function main(args) {
  const options = parseArgs(args)
  const budget = parseBudget(readFileSync(options.budget, 'utf8'), options.budget)
  const rows = compare(measure(options.dist, budget.namedChunks), budget.gzipKb)
  const table = formatTable(rows)
  console.log(table)

  const failed = rows.filter((row) => row.status !== 'ok')
  for (const row of failed) console.error(`Bundle group "${row.group}" ${failureMessage(row, options.budget)}.`)
  if (failed.length > 0) {
    console.error(`If the growth is intended, raise the budget in ${options.budget} in the same pull request and say why.`)
  }

  if (process.env.GITHUB_STEP_SUMMARY) {
    try {
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Frontend bundle size\n\n${table}\n`)
    } catch (error) {
      console.error(`Could not write the job summary: ${error.message}`)
    }
  }
  return failed.length > 0 ? 1 : 0
}

// realpath on both sides, so a symlinked checkout still runs the check
// instead of importing it as a module and exiting 0. An argv[1] that is not a
// file (`node -`, a REPL) means this was imported, not run.
function isMain() {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (process.argv[1] && isMain()) {
  try {
    process.exitCode = main(process.argv.slice(2))
  } catch (error) {
    console.error(`Bundle size check failed: ${error.message}`)
    process.exitCode = 1
  }
}
