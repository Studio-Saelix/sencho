#!/usr/bin/env node

/**
 * Measures what a running Sencho costs while an operator leaves one tab open,
 * and compares it with the previous release.
 *
 * Every poller, cache, and background service adds a little idle cost, and on
 * a small self-hosted box those add up without any single change looking
 * expensive. This probe opens the Dashboard in headless Chromium, lets it
 * settle, then for `--minutes` counts the `/api` requests the tab makes and
 * samples the Sencho container's memory and CPU with `docker stats`, over ssh
 * when `--ssh` names the host.
 *
 * Each run appends one record to `--history`, keyed by `--label` (default: the
 * version the instance reports). Set `--label` to the release under audit: a
 * release candidate reports the previous version until it is tagged. With a
 * previous record for a different label in that file, the run compares
 * against it and fails when idle cost grew past a threshold:
 *   memory   median RSS more than 20% higher
 *   requests per minute from the tab more than 50% higher
 *   cpu      mean CPU more than 50% higher and more than 1 point higher
 *
 * Credentials come from SENCHO_USERNAME and SENCHO_PASSWORD so they never
 * reach shell history or the results file.
 *
 * Usage:
 *   SENCHO_USERNAME=... SENCHO_PASSWORD=... node scripts/perf/idle-footprint.mjs \
 *     --url http://host:1852 --history idle-footprint.json \
 *     [--label 0.99.0] [--ssh user@host] [--container sencho] [--minutes 10]
 *     [--settle-seconds 60] [--sample-seconds 30]
 */

import { execFile } from 'node:child_process'
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)

const DEFAULTS = {
  url: null, history: null, label: null, ssh: null, container: 'sencho',
  minutes: 10, 'settle-seconds': 60, 'sample-seconds': 30,
}
const NUMERIC = new Set(['minutes', 'settle-seconds', 'sample-seconds'])
export const THRESHOLDS = { memoryRatio: 1.2, requestsRatio: 1.5, cpuRatio: 1.5, cpuFloorPoints: 1 }

export function parseArgs(args) {
  const options = { ...DEFAULTS }
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i].startsWith('--') ? args[i].slice(2) : null
    const value = args[i + 1]
    if (!key || !(key in DEFAULTS)) throw new Error(`Unknown argument "${args[i]}"`)
    if (value === undefined || value.startsWith('--')) throw new Error(`${args[i]} needs a value`)
    if (NUMERIC.has(key)) {
      const n = Number(value)
      if (!Number.isFinite(n) || n <= 0) throw new Error(`${args[i]} must be a positive number`)
      options[key] = n
    } else {
      options[key] = value
    }
  }
  if (!options.url) throw new Error('--url is required')
  if (!options.history) throw new Error('--history is required')
  return options
}

const UNITS = { B: 1, KB: 1e3, MB: 1e6, GB: 1e9, KIB: 1024, MIB: 1024 ** 2, GIB: 1024 ** 3 }

/** Bytes from a docker stats size such as "123.4MiB" or "1.2GB". */
export function parseSize(text) {
  const match = /^([\d.]+)\s*([KMG]?i?B)$/i.exec(text.trim())
  if (!match) throw new Error(`Unreadable size "${text}"`)
  return Number(match[1]) * UNITS[match[2].toUpperCase()]
}

/** Memory in MiB and CPU percent from one `docker stats --format '{{json .}}'` line. */
export function parseDockerStats(line) {
  const stats = JSON.parse(line)
  const used = stats.MemUsage.split('/')[0]
  return {
    memMiB: parseSize(used) / 1024 ** 2,
    cpuPct: Number(stats.CPUPerc.replace('%', '')),
  }
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

const round = (n) => Math.round(n * 10) / 10

export function summarizeSamples(samples) {
  const mem = samples.map((s) => s.memMiB)
  const cpu = samples.map((s) => s.cpuPct)
  return {
    samples: samples.length,
    memMedianMiB: round(median(mem)),
    memMaxMiB: round(Math.max(...mem)),
    cpuMeanPct: round(cpu.reduce((a, b) => a + b, 0) / cpu.length),
    cpuMaxPct: round(Math.max(...cpu)),
  }
}

/** The `count` paths the tab requested most, as "path: n" strings. */
export function topPaths(counts, count = 8) {
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, count).map(([path, n]) => `${path}: ${n}`)
}

/** The latest record in history for a label other than `label`, or null. */
export function previousRecord(history, label) {
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].label !== label) return history[i]
  }
  return null
}

/** One row per metric, flagged `grew` when it crossed its threshold against `previous`. */
export function compare(current, previous, limits = THRESHOLDS) {
  const row = (metric, now, before, grew) => ({ metric, now, before, status: before === null ? 'no baseline' : grew ? 'grew' : 'ok' })
  const p = previous ?? {}
  return [
    row('memory median MiB', current.memMedianMiB, p.memMedianMiB ?? null, current.memMedianMiB > p.memMedianMiB * limits.memoryRatio),
    row('requests per minute', current.requestsPerMinute, p.requestsPerMinute ?? null, current.requestsPerMinute > p.requestsPerMinute * limits.requestsRatio),
    row('cpu mean %', current.cpuMeanPct, p.cpuMeanPct ?? null,
      current.cpuMeanPct > p.cpuMeanPct * limits.cpuRatio && current.cpuMeanPct - p.cpuMeanPct > limits.cpuFloorPoints),
  ]
}

export function formatTable(rows, previousVersion) {
  const lines = [`| Metric | Now | ${previousVersion ?? 'Previous'} | Status |`, '|---|---:|---:|---|']
  for (const r of rows) lines.push(`| ${r.metric} | ${r.now} | ${r.before ?? '-'} | ${r.status} |`)
  return lines.join('\n')
}

/** One argument quoted for a POSIX shell, so ssh's remote shell passes it through intact. */
export function shellQuote(arg) {
  return `'${arg.replaceAll("'", `'\\''`)}'`
}

function docker(options, args) {
  return options.ssh
    ? run('ssh', ['-o', 'BatchMode=yes', options.ssh, ['docker', ...args].map(shellQuote).join(' ')])
    : run('docker', args)
}

async function dockerStats(options) {
  const { stdout } = await docker(options, ['stats', '--no-stream', '--format', '{{json .}}', options.container])
  return parseDockerStats(stdout.trim().split('\n')[0])
}

/** The image the container runs, so a record says exactly what was measured. */
async function containerImage(options) {
  const { stdout } = await docker(options, ['inspect', '--format', '{{.Config.Image}}', options.container])
  return stdout.trim()
}

async function instanceVersion(url) {
  const res = await fetch(new URL('/api/meta', url))
  if (!res.ok) throw new Error(`GET /api/meta returned ${res.status}`)
  const meta = await res.json()
  if (!meta.version) throw new Error('/api/meta did not report a version')
  return meta.version
}

async function openDashboard(url) {
  const username = process.env.SENCHO_USERNAME
  const password = process.env.SENCHO_PASSWORD
  if (!username || !password) throw new Error('Set SENCHO_USERNAME and SENCHO_PASSWORD')
  const { chromium } = await import('@playwright/test')
  const browser = await chromium.launch()
  const context = await browser.newContext({ baseURL: url, viewport: { width: 1440, height: 900 } })
  const login = await context.request.post('/api/auth/login', { data: { username, password } })
  if (!login.ok()) {
    await browser.close()
    throw new Error(`Login returned ${login.status()}`)
  }
  const page = await context.newPage()
  await page.goto('/', { waitUntil: 'networkidle' })
  return { browser, page }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function measure(options) {
  const version = await instanceVersion(options.url)
  const image = await containerImage(options) // Also fails early when the container cannot be read.
  const { browser, page } = await openDashboard(options.url)
  try {
    console.error(`Settling for ${options['settle-seconds']}s...`)
    await sleep(options['settle-seconds'] * 1000)
    const counts = new Map()
    let total = 0
    page.on('request', (req) => {
      const { pathname } = new URL(req.url())
      if (!pathname.startsWith('/api/')) return
      total++
      counts.set(pathname, (counts.get(pathname) ?? 0) + 1)
    })
    const samples = []
    const endAt = Date.now() + options.minutes * 60_000
    console.error(`Measuring for ${options.minutes} min...`)
    while (Date.now() < endAt) {
      samples.push(await dockerStats(options))
      await sleep(Math.min(options['sample-seconds'] * 1000, Math.max(0, endAt - Date.now())))
    }
    return {
      label: options.label ?? version,
      version,
      image,
      date: new Date().toISOString(),
      minutes: options.minutes,
      ...summarizeSamples(samples),
      requestsPerMinute: round(total / options.minutes),
      topPaths: topPaths(counts),
    }
  } finally {
    await browser.close()
  }
}

async function main(args) {
  const options = parseArgs(args)
  const history = existsSync(options.history) ? JSON.parse(readFileSync(options.history, 'utf8')) : []
  const record = await measure(options)
  const previous = previousRecord(history, record.label)
  writeFileSync(options.history, `${JSON.stringify([...history, record], null, 2)}\n`)

  const rows = compare(record, previous)
  console.log(`Idle footprint of ${record.label} (${record.image}) over ${record.minutes} min (${record.samples} samples)\n`)
  if (previous) console.log(`Compared with ${previous.label} (${previous.image}) measured ${previous.date}\n`)
  console.log(formatTable(rows, previous?.label))
  console.log(`\nBusiest paths: ${record.topPaths.join(', ')}`)
  const grew = rows.filter((r) => r.status === 'grew')
  for (const r of grew) console.error(`${r.metric} grew from ${r.before} to ${r.now} since ${previous.label}.`)
  return grew.length > 0 ? 1 : 0
}

function isMain() {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (process.argv[1] && isMain()) {
  main(process.argv.slice(2)).then(
    (code) => { process.exitCode = code },
    (error) => {
      console.error(`Idle footprint probe failed: ${error.message}`)
      process.exitCode = 1
    },
  )
}
