#!/usr/bin/env node

/**
 * Measures what a running Sencho costs while an operator leaves one tab open,
 * and compares it with an earlier release.
 *
 * Every poller, cache, and background service adds a little idle cost, and on
 * a small self-hosted box those add up without any single change looking
 * expensive. This probe opens the Dashboard in headless Chromium, lets it
 * settle, then for `--minutes` counts the `/api` requests the tab makes and
 * the WebSocket frames it receives, and samples the Sencho container with
 * `docker stats`, over ssh when `--ssh` names the host.
 *
 * Each run appends one record to `--history`, keyed by `--label` (default:
 * the version the instance reports). Set `--label` to the release under audit:
 * a release candidate reports the previous version until it is tagged. The
 * run compares against the most recent record with a different label (or the
 * one `--baseline-label` names) and fails when idle cost grew past a
 * threshold:
 *   memory   median container memory (docker stats MemUsage) more than 20% higher
 *   requests /api requests per minute from the tab more than 50% higher
 * Mean CPU more than 50% and more than 1 point higher is reported as `higher`
 * but does not fail the run: on a shared bench it moved from 1.6% to 4.9%
 * between two runs of the same image.
 *
 * A run that cannot vouch for its numbers fails and records nothing: the
 * instance at `--url` must be the one in `--container` (started within 30 s
 * of it and, when the container publishes ports, publishing the URL's port),
 * neither the container nor the Sencho process may restart during the run,
 * the tab must make /api requests with no 401 or 403 and no more than 10%
 * failures, and every docker stats sample must be readable.
 *
 * The account must be a local admin without MFA. Credentials come from
 * SENCHO_USERNAME and SENCHO_PASSWORD and are never written to the record;
 * export them from a secrets source rather than typing them on the command
 * line, where they would land in shell history.
 *
 * Usage:
 *   node scripts/perf/idle-footprint.mjs --url http://host:1852 --history idle-footprint.json \
 *     [--label 0.99.0] [--baseline-label 0.98.3] [--ssh user@host] [--container sencho]
 *     [--minutes 10] [--settle-seconds 60] [--sample-seconds 30]
 */

import { execFile } from 'node:child_process'
import { existsSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)

const DEFAULTS = {
  url: null, history: null, label: null, 'baseline-label': null, ssh: null, container: 'sencho',
  minutes: 10, 'settle-seconds': 60, 'sample-seconds': 30,
}
const NUMERIC = new Set(['minutes', 'settle-seconds', 'sample-seconds'])
const CONTAINER_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/
const COMMAND_TIMEOUT_MS = 60_000
// The meta start time and the container start time are taken by different
// clocks a moment apart; anything closer than this is the same start.
const START_TOLERANCE_MS = 30_000
export const MIN_SAMPLES = 5
export const MAX_FAILED_SHARE = 0.1
export const THRESHOLDS = { memoryRatio: 1.2, requestsRatio: 1.5, cpuRatio: 1.5, cpuFloorPoints: 1 }

export function parseArgs(args) {
  const options = { ...DEFAULTS }
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i].startsWith('--') ? args[i].slice(2) : null
    const value = args[i + 1]
    if (!key || !(key in DEFAULTS)) throw new Error(`Unknown argument "${args[i]}"`)
    if (value === undefined || value === '' || value.startsWith('--')) throw new Error(`${args[i]} needs a value`)
    if (NUMERIC.has(key)) {
      const n = value.trim() === '' ? NaN : Number(value)
      if (!Number.isFinite(n) || n <= 0) throw new Error(`${args[i]} must be a positive number`)
      options[key] = n
    } else {
      options[key] = value
    }
  }
  if (!options.url) throw new Error('--url is required')
  if (!options.history) throw new Error('--history is required')
  if (!CONTAINER_NAME.test(options.container)) throw new Error(`--container "${options.container}" is not a container name`)
  if (options.ssh?.startsWith('-')) throw new Error('--ssh must be a host, not an option')
  const expectedSamples = Math.ceil((options.minutes * 60) / options['sample-seconds'])
  if (expectedSamples < MIN_SAMPLES) {
    throw new Error(`--minutes ${options.minutes} at --sample-seconds ${options['sample-seconds']} gives ${expectedSamples} samples; need at least ${MIN_SAMPLES}`)
  }
  return options
}

const UNITS = { B: 1, KB: 1e3, MB: 1e6, GB: 1e9, KIB: 1024, MIB: 1024 ** 2, GIB: 1024 ** 3 }

/** Bytes from a docker stats size such as "123.4MiB" or "1.2GB". */
export function parseSize(text) {
  const match = /^(\d+(?:\.\d+)?)\s*([KMG]?i?B)$/i.exec(text.trim())
  if (!match) throw new Error(`Unreadable size "${text}"`)
  return Number(match[1]) * UNITS[match[2].toUpperCase()]
}

/**
 * Memory in MiB and CPU percent from one `docker stats --format '{{json .}}'`
 * line. A stopped container reports zero memory or a non-numeric CPU; either
 * throws, as does an empty line.
 */
export function parseDockerStats(line) {
  if (!line.trim()) throw new Error('docker stats printed nothing; is the container name right?')
  const stats = JSON.parse(line)
  const memMiB = parseSize(stats.MemUsage.split('/')[0]) / 1024 ** 2
  const cpuPct = Number(String(stats.CPUPerc).replace('%', ''))
  if (!(memMiB > 0) || !Number.isFinite(cpuPct)) {
    throw new Error(`Unusable docker stats sample (MemUsage ${stats.MemUsage}, CPUPerc ${stats.CPUPerc}); is the container running?`)
  }
  return { memMiB, cpuPct }
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

/**
 * The API path a request URL counts under, with ids collapsed so one
 * endpoint is one entry, or null when it is not an API call. Works under a
 * reverse-proxy base path.
 */
export function apiPath(url) {
  const { pathname } = new URL(url)
  const index = pathname.indexOf('/api/')
  if (index === -1) return null
  return pathname.slice(index).split('/')
    .map((segment) => (/^\d+$/.test(segment) || /^[0-9a-f]{12,}$/i.test(segment) ? ':id' : segment))
    .join('/')
}

/** The `count` paths the tab requested most, as "path: n" strings. */
export function topPaths(counts, count = 8) {
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, count).map(([path, n]) => `${path}: ${n}`)
}

/**
 * The record a run appends. Throws, so nothing is appended, when the
 * measurement cannot be trusted.
 */
export function buildRecord({ label, version, image, imageId, url, host, elapsedMs, samples, traffic }) {
  const minutes = elapsedMs / 60_000
  if (samples.length < MIN_SAMPLES) throw new Error(`Only ${samples.length} docker stats samples; need at least ${MIN_SAMPLES}`)
  if (traffic.authFailures > 0) throw new Error(`${traffic.authFailures} /api responses were 401 or 403; the tab lost its session`)
  if (traffic.total === 0) throw new Error('The tab made no /api requests; it is not showing the Dashboard')
  if (traffic.failed > traffic.total * MAX_FAILED_SHARE) {
    throw new Error(`${traffic.failed} of ${traffic.total} /api requests failed; the request rate does not describe a healthy idle tab`)
  }
  return {
    label: label ?? version,
    version,
    image,
    imageId,
    url,
    host,
    date: new Date().toISOString(),
    minutes: round(minutes),
    ...summarizeSamples(samples),
    requestsPerMinute: round(traffic.total / minutes),
    failedRequests: traffic.failed,
    websocketOpens: traffic.websocketOpens,
    websocketFramesPerMinute: round(traffic.websocketFrames / minutes),
    topPaths: topPaths(traffic.counts),
  }
}

/**
 * The record to compare against: the latest with `baselineLabel` when given,
 * otherwise the latest with a label other than `label`. Null when there is
 * none; throws when `baselineLabel` is given and no record has it.
 */
export function previousRecord(history, label, baselineLabel = null) {
  for (let i = history.length - 1; i >= 0; i--) {
    const r = history[i]
    if (baselineLabel ? r.label === baselineLabel : r.label !== label) return r
  }
  if (baselineLabel) throw new Error(`No record labelled "${baselineLabel}" in the history`)
  return null
}

const usable = (n) => typeof n === 'number' && Number.isFinite(n) && n > 0

/**
 * One row per metric: past its threshold against `previous` it is `grew`
 * (memory, requests; fails the run) or `higher` (CPU; reported only), `ok`
 * otherwise, and `no baseline` when there is no previous value to compare
 * (no previous record, or a missing or zero value).
 */
export function compare(current, previous, limits = THRESHOLDS) {
  const row = (metric, key, crossed, label = 'grew') => {
    const before = previous?.[key]
    if (!usable(before)) return { metric, now: current[key], before: null, status: 'no baseline' }
    return { metric, now: current[key], before, status: crossed(current[key], before) ? label : 'ok' }
  }
  return [
    row('memory median MiB', 'memMedianMiB', (now, before) => now > before * limits.memoryRatio),
    row('requests per minute', 'requestsPerMinute', (now, before) => now > before * limits.requestsRatio),
    row('cpu mean %', 'cpuMeanPct', (now, before) => now > before * limits.cpuRatio && now - before > limits.cpuFloorPoints, 'higher'),
  ]
}

/** 1 when a gated metric (memory or requests) grew past its threshold, else 0. */
export function exitCode(rows) {
  return rows.some((r) => r.status === 'grew') ? 1 : 0
}

export function formatTable(rows, previousLabel) {
  const lines = [`| Metric | Now | ${previousLabel ?? 'Previous'} | Status |`, '|---|---:|---:|---|']
  for (const r of rows) lines.push(`| ${r.metric} | ${r.now} | ${r.before ?? '-'} | ${r.status} |`)
  return lines.join('\n')
}

/** One argument quoted for a POSIX shell, so ssh's remote shell passes it through intact. */
export function shellQuote(arg) {
  return `'${arg.replaceAll("'", `'\\''`)}'`
}

function docker(options, args) {
  return options.ssh
    ? run('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '--', options.ssh,
      ['docker', ...args].map(shellQuote).join(' ')], { timeout: COMMAND_TIMEOUT_MS })
    : run('docker', args, { timeout: COMMAND_TIMEOUT_MS })
}

async function dockerStats(options) {
  const { stdout } = await docker(options, ['stats', '--no-stream', '--format', '{{json .}}', options.container])
  return parseDockerStats(stdout.trim().split('\n')[0])
}

/** Image, image id, start time, restart count, and published host ports, to pin what is measured. */
async function containerState(options) {
  // Each value is compact JSON with no spaces (image refs, ids, timestamps, numbers, port maps).
  const format = '{{json .Config.Image}} {{json .Image}} {{json .State.StartedAt}} {{json .RestartCount}} {{json .NetworkSettings.Ports}}'
  const { stdout } = await docker(options, ['inspect', '--format', format, options.container])
  const [image, imageId, startedAt, restartCount, ports] = stdout.trim().split(' ').map((v) => JSON.parse(v))
  const hostPorts = Object.values(ports ?? {}).flat().filter(Boolean).map((p) => Number(p.HostPort))
  return { image, imageId, startedAt, restartCount, hostPorts }
}

async function instanceMeta(url) {
  const res = await fetch(new URL('/api/meta', url), { signal: AbortSignal.timeout(15_000) })
  if (!res.ok) throw new Error(`GET /api/meta returned ${res.status}`)
  const meta = await res.json()
  if (!meta.version) throw new Error('/api/meta did not report a version')
  return meta
}

/**
 * Throws unless the instance at the URL is the container: it started within
 * moments of it and, when the container publishes ports, one of them is the
 * URL's port. A container on the host network publishes none.
 */
export function assertSameInstance(meta, state, url) {
  const gap = Math.abs(new Date(meta.startedAt).getTime() - new Date(state.startedAt).getTime())
  if (!(gap <= START_TOLERANCE_MS)) {
    throw new Error(`The instance at --url started at ${meta.startedAt}, the container at ${state.startedAt}; --container or --ssh names a different instance`)
  }
  const { port, protocol } = new URL(url)
  const urlPort = Number(port || (protocol === 'https:' ? 443 : 80))
  if (state.hostPorts.length > 0 && !state.hostPorts.includes(urlPort)) {
    throw new Error(`The container publishes ports ${state.hostPorts.join(', ')}, not ${urlPort} from --url; --container or --ssh names a different instance`)
  }
}

/** Logs in and opens the Dashboard, with `watch(page)` attached before the first request. */
async function openDashboard(url, watch) {
  const username = process.env.SENCHO_USERNAME
  const password = process.env.SENCHO_PASSWORD
  if (!username || !password) throw new Error('Set SENCHO_USERNAME and SENCHO_PASSWORD')
  const { chromium } = await import('@playwright/test')
  const browser = await chromium.launch()
  try {
    const context = await browser.newContext({ baseURL: url, viewport: { width: 1440, height: 900 } })
    const login = await context.request.post('/api/auth/login', { data: { username, password } })
    if (!login.ok()) throw new Error(`Login returned ${login.status()}`)
    if ((await login.json()).mfaRequired) throw new Error('This account has MFA; use a local account without it')
    const page = await context.newPage()
    const watched = watch(page)
    await page.goto('/', { waitUntil: 'networkidle', timeout: 60_000 })
    return { browser, watched }
  } catch (error) {
    await browser.close().catch(() => {})
    throw error
  }
}

/** Counts the tab's API and WebSocket traffic while `active` is true. */
function watchTraffic(page) {
  const traffic = {
    active: false, total: 0, failed: 0, authFailures: 0, websocketOpens: 0, websocketFrames: 0, counts: new Map(),
  }
  // Outcomes are counted only for requests counted in `total`, so a request
  // sent while settling cannot add a failure without adding a request.
  const counted = new WeakSet()
  page.on('request', (req) => {
    const path = traffic.active ? apiPath(req.url()) : null
    if (path === null) return
    counted.add(req)
    traffic.total++
    traffic.counts.set(path, (traffic.counts.get(path) ?? 0) + 1)
  })
  page.on('response', (res) => {
    if (!counted.has(res.request())) return
    if (res.status() === 401 || res.status() === 403) traffic.authFailures++
    else if (res.status() >= 400) traffic.failed++
  })
  page.on('requestfailed', (req) => {
    if (counted.has(req)) traffic.failed++
  })
  page.on('websocket', (ws) => {
    if (traffic.active) traffic.websocketOpens++
    ws.on('framereceived', () => {
      if (traffic.active) traffic.websocketFrames++
    })
  })
  return traffic
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function measure(options) {
  const meta = await instanceMeta(options.url)
  const before = await containerState(options)
  assertSameInstance(meta, before, options.url)
  await dockerStats(options) // Fails early on a stopped container.
  const { browser, watched: traffic } = await openDashboard(options.url, watchTraffic)
  try {
    console.error(`Settling for ${options['settle-seconds']}s...`)
    await sleep(options['settle-seconds'] * 1000)
    const samples = []
    console.error(`Measuring for ${options.minutes} min...`)
    traffic.active = true
    const started = Date.now()
    const endAt = started + options.minutes * 60_000
    while (Date.now() < endAt) {
      samples.push(await dockerStats(options))
      await sleep(Math.min(options['sample-seconds'] * 1000, Math.max(0, endAt - Date.now())))
    }
    traffic.active = false
    const elapsedMs = Date.now() - started
    const after = await containerState(options)
    if (after.startedAt !== before.startedAt || after.restartCount !== before.restartCount) {
      throw new Error('The container restarted during the run')
    }
    if ((await instanceMeta(options.url)).startedAt !== meta.startedAt) {
      throw new Error('Sencho restarted inside the container during the run')
    }
    return buildRecord({
      label: options.label, version: meta.version, image: before.image, imageId: before.imageId,
      url: new URL(options.url).origin, host: options.ssh ?? 'local', elapsedMs, samples, traffic,
    })
  } finally {
    await browser.close().catch((error) => console.error(`Could not close the browser: ${error.message}`))
  }
}

function readHistory(path) {
  if (!existsSync(path)) return []
  let history
  try {
    history = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new Error(`${path} is not valid JSON: ${error.message}`)
  }
  if (!Array.isArray(history) || !history.every((r) => typeof r?.label === 'string')) {
    throw new Error(`${path} must hold a JSON array of records, each with a label`)
  }
  return history
}

/** Appends to the history as it is now (another run may have added to it) and swaps the file in whole. */
function appendRecord(path, record) {
  const history = readHistory(path)
  const temp = `${path}.${process.pid}.tmp`
  try {
    writeFileSync(temp, `${JSON.stringify([...history, record], null, 2)}\n`)
    renameSync(temp, path)
  } catch (error) {
    rmSync(temp, { force: true })
    throw error
  }
}

async function main(args) {
  const options = parseArgs(args)
  const history = readHistory(options.history)
  if (history.length === 0) console.error(`Starting a new history at ${options.history}`)
  // Fail before the measurement, not after it, when the named baseline is not there.
  if (options['baseline-label']) previousRecord(history, null, options['baseline-label'])
  const record = await measure(options)
  const previous = previousRecord(history, record.label, options['baseline-label'])
  const rows = compare(record, previous)
  appendRecord(options.history, { ...record, status: exitCode(rows) ? 'grew' : 'ok' })

  console.log(`Idle footprint of ${record.label} (${record.image}) over ${record.minutes} min (${record.samples} samples)\n`)
  if (previous) {
    console.log(`Compared with ${previous.label} (${previous.image}) measured ${previous.date}`)
    if (previous.imageId === record.imageId) {
      console.log('The previous record measured the same image; the comparison says nothing about this release.')
    }
    if (previous.host !== record.host || previous.url !== record.url) {
      console.log(`The previous record was taken on ${previous.host} (${previous.url}); this comparison is indicative only.`)
    }
    console.log('')
  } else {
    console.log('No earlier record to compare with; this run is the baseline for the next one.\n')
  }
  console.log(formatTable(rows, previous?.label))
  console.log(`\nWebSocket: ${record.websocketOpens} opened, ${record.websocketFramesPerMinute} frames per minute. Failed /api requests: ${record.failedRequests}.`)
  console.log(`Busiest paths: ${record.topPaths.join(', ')}`)
  for (const r of rows.filter((row) => row.status === 'grew' || row.status === 'higher')) {
    const note = r.status === 'higher' ? ' (reported, not gated: rerun to tell a trend from bench noise)' : ''
    console.error(`${r.metric} grew from ${r.before} to ${r.now} since ${previous.label}${note}.`)
  }
  return exitCode(rows)
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
