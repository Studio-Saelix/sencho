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
 *   entry-js                  the module script dist/index.html runs
 *   preload-js                chunks dist/index.html preloads next to it
 *   initial-css               stylesheets dist/index.html links
 *                             (these three are what a first visit fetches)
 *   <name>                    a named vendor chunk from vite.config.ts
 *                             `manualChunks` that is not part of initial load
 *   workers                   Monaco language workers (*.worker chunks)
 *   lazy-js / lazy-css        every other on-demand chunk
 *   total-js                  all JavaScript, initial and lazy
 *
 * Sizes are gzipped bytes, which is close to what a browser transfers. A group
 * that has no budget fails the check, so a new vendor chunk gets a number on
 * purpose instead of slipping through.
 *
 * Usage:
 *   node scripts/check-bundle-size.mjs [--dist frontend/dist] [--budget frontend/bundle-budget.json]
 *
 * Writes the size table to stdout, and to the GitHub job summary when
 * GITHUB_STEP_SUMMARY is set. Exits 1 when a group is over budget or has none.
 */

import { appendFileSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { pathToFileURL } from 'node:url'

// Rolldown names chunks `<name>-<8 char hash>.<ext>`; the hash alphabet
// includes `-` and `_`.
const HASHED = /^(.+)-[A-Za-z0-9_-]{8}\.(js|css)$/

/** The chunk name without its content hash, or null for a non-chunk asset. */
export function chunkName(file) {
  const match = HASHED.exec(file)
  return match ? match[1] : null
}

/**
 * Asset file names that dist/index.html loads, mapped to how: `src` for the
 * module script, `href` for preloads and stylesheets.
 */
export function initialAssets(indexHtml) {
  const files = new Map()
  for (const match of indexHtml.matchAll(/(src|href)="\/?assets\/([^"]+)"/g)) {
    files.set(match[2], match[1])
  }
  return files
}

/** The budget group a built asset belongs to, or null when it is not JS or CSS. */
export function groupOf(file, initial, namedChunks) {
  const name = chunkName(file)
  if (name === null) return null
  const ext = file.endsWith('.css') ? 'css' : 'js'
  if (initial.has(file)) {
    if (ext === 'css') return 'initial-css'
    return initial.get(file) === 'src' ? 'entry-js' : 'preload-js'
  }
  if (ext === 'js' && name.endsWith('.worker')) return 'workers'
  if (ext === 'js' && namedChunks.includes(name)) return name
  return `lazy-${ext}`
}

/**
 * Gzipped bytes per group for a built dist directory.
 *
 * `namedChunks` are the manualChunks names that get their own group; any
 * other chunk is counted as lazy.
 */
export function measure(distDir, namedChunks) {
  const initial = initialAssets(readFileSync(join(distDir, 'index.html'), 'utf8'))
  const groups = {}
  let totalJs = 0
  for (const file of readdirSync(join(distDir, 'assets'))) {
    const group = groupOf(file, initial, namedChunks)
    if (group === null) continue
    const bytes = gzipSync(readFileSync(join(distDir, 'assets', file))).length
    groups[group] = (groups[group] ?? 0) + bytes
    if (file.endsWith('.js')) totalJs += bytes
  }
  groups['total-js'] = totalJs
  return groups
}

/** One row per measured or budgeted group, in a stable order. */
export function compare(groups, budgetKb) {
  const names = [...new Set([...Object.keys(budgetKb), ...Object.keys(groups)])]
  return names.map((group) => {
    const kb = (groups[group] ?? 0) / 1024
    const budget = budgetKb[group]
    let status = 'ok'
    if (budget === undefined) status = 'no budget'
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

function argValue(args, flag, fallback) {
  const index = args.indexOf(flag)
  return index === -1 ? fallback : args[index + 1]
}

function main(args) {
  const distDir = argValue(args, '--dist', 'frontend/dist')
  const budgetPath = argValue(args, '--budget', 'frontend/bundle-budget.json')
  const budget = JSON.parse(readFileSync(budgetPath, 'utf8'))

  const rows = compare(measure(distDir, budget.namedChunks), budget.gzipKb)
  const table = formatTable(rows)
  console.log(table)
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Frontend bundle size\n\n${table}\n`)
  }

  const failed = rows.filter((row) => row.status !== 'ok')
  for (const row of failed) {
    const detail = row.status === 'over'
      ? `is ${row.kb.toFixed(1)} KB gzipped, over its ${row.budget} KB budget`
      : `has no budget; add it to ${budgetPath}`
    console.error(`Bundle group "${row.group}" ${detail}.`)
  }
  if (failed.length > 0) {
    console.error(`If the growth is intended, raise the budget in ${budgetPath} in the same pull request and say why.`)
    process.exit(1)
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2))
}
