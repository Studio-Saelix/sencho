#!/usr/bin/env node

/**
 * Times Sencho's busiest read endpoints at operator scale and compares them
 * with a stored baseline.
 *
 * A change that is fine at five stacks can be slow at two hundred, and the
 * unit and e2e suites run with a handful. This benchmark starts the built
 * backend against a scratch compose directory, deploys `--stacks` one-service
 * stacks (busybox, sleeping), registers `--nodes` proxy-mode remote nodes that
 * point back at the same instance over its LAN address (so the fleet overview
 * pays a real HTTP fan-out), then times:
 *
 *   stacks             GET /api/stacks
 *   statuses-miss      GET /api/stacks/statuses after the status cache expired
 *   statuses-hit       GET /api/stacks/statuses right after a miss warmed it
 *   fleet-overview     GET /api/fleet/overview
 *
 * Each series reports min, median, p95, and max over its samples. The run
 * proves it measured real work: before and after timing, every node in the
 * fleet overview must be online and list every seeded stack, and the stack
 * statuses must show every seeded stack running. Each miss sample's cache
 * outcome is read from the backend's own debug timing log and must be a fresh
 * computation.
 *
 * With `--baseline`, the run fails when a series' median is over `--ratio`
 * times the baseline median and also more than `--floor-ms` slower (so CI
 * noise on fast endpoints does not fail it), when a baseline series is
 * missing from the results, or when the baseline was taken at another scale.
 *
 * Requirements: `npm run build` in backend/, Docker with the compose plugin,
 * and port 1852 free (the backend's fixed port).
 *
 * Usage:
 *   node scripts/perf/scale-benchmark.mjs [--stacks 200] [--nodes 10] [--samples 30]
 *     [--miss-samples 5] [--ratio 1.5] [--floor-ms 25] [--work-dir <dir>]
 *     [--out results.json] [--baseline scripts/perf/scale-benchmark-baseline.json]
 *
 * Writes a table to stdout and, when GITHUB_STEP_SUMMARY is set, to the job
 * summary. Exits 1 on a regression or when the run itself fails, including a
 * failed cleanup. `--work-dir` keeps the scratch directory (with backend.log)
 * after the run; without it a temporary directory is used and removed.
 */

import { spawn, execFile } from 'node:child_process'
import {
  appendFileSync, closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { networkInterfaces, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { randomBytes } from 'node:crypto'
import { get as httpGet } from 'node:http'

const run = promisify(execFile)

const PORT = 1852
const BASE = `http://127.0.0.1:${PORT}`
const PROJECT_PREFIX = 'senchobench-'
const BENCH_LABEL = 'io.sencho.bench=1'
const IMAGE = 'busybox:1.36'
// One shared network: a default network per project would exhaust Docker's
// address pools long before 200 stacks.
const NETWORK = 'senchobench'
const FALLBACK_SUBNET = '10.254.0.0/22'
// Must exceed STACK_STATUSES_CACHE_TTL_MS in backend/src/helpers/constants.ts.
const STATUS_CACHE_EXPIRY_MS = 16_000
// Cache outcomes (CacheFetchOutcome in backend/src/services/CacheService.ts)
// that mean the request waited on a real computation.
const MISS_OUTCOMES = new Set(['computed', 'inflight'])
export const SERIES = ['stacks', 'statuses-miss', 'statuses-hit', 'fleet-overview']
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

const DEFAULTS = {
  stacks: 200, nodes: 10, samples: 30, 'miss-samples': 5,
  'work-dir': null, out: null, baseline: null, ratio: 1.5, 'floor-ms': 25,
}
const COUNTS = new Set(['stacks', 'nodes', 'samples', 'miss-samples'])
const NUMBERS = new Set(['ratio', 'floor-ms'])

export function parseArgs(args) {
  const options = { ...DEFAULTS }
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i].startsWith('--') ? args[i].slice(2) : null
    const value = args[i + 1]
    if (!key || !(key in DEFAULTS)) throw new Error(`Unknown argument "${args[i]}"`)
    if (value === undefined || value.startsWith('--')) throw new Error(`${args[i]} needs a value`)
    if (COUNTS.has(key) || NUMBERS.has(key)) {
      const n = value.trim() === '' ? NaN : Number(value)
      if (!Number.isFinite(n) || n < 0) throw new Error(`${args[i]} must be a non-negative number`)
      if (COUNTS.has(key) && !Number.isInteger(n)) throw new Error(`${args[i]} must be a whole number`)
      options[key] = n
    } else {
      options[key] = value
    }
  }
  if (options.stacks < 1 || options.samples < 1 || options['miss-samples'] < 1) {
    throw new Error('--stacks, --samples, and --miss-samples must be at least 1')
  }
  if (options.ratio < 1) throw new Error('--ratio must be at least 1')
  return options
}

/** A baseline file's contents, or an error naming what is wrong with it. */
export function parseBaseline(text) {
  const baseline = JSON.parse(text)
  const { meta, series } = baseline ?? {}
  if (!Number.isInteger(meta?.stacks) || !Number.isInteger(meta?.remoteNodes)) {
    throw new Error('Baseline meta must record the stacks and remoteNodes it was taken at')
  }
  if (series === null || typeof series !== 'object' || Object.keys(series).length === 0) {
    throw new Error('Baseline has no series')
  }
  for (const [name, stats] of Object.entries(series)) {
    if (typeof stats?.medianMs !== 'number' || !(stats.medianMs > 0)) {
      throw new Error(`Baseline series "${name}" needs a positive medianMs`)
    }
  }
  return baseline
}

/** Throws when the baseline was taken at a different scale than this run. */
export function assertSameScale(baseline, options) {
  if (baseline.meta.stacks !== options.stacks || baseline.meta.remoteNodes !== options.nodes) {
    throw new Error(
      `Baseline was taken at ${baseline.meta.stacks} stacks and ${baseline.meta.remoteNodes} remote nodes; `
      + `this run uses ${options.stacks} and ${options.nodes}`,
    )
  }
}

/** Nearest-rank percentile of an unsorted list of numbers. */
export function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b)
  const rank = Math.ceil((p / 100) * sorted.length)
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1]
}

export function summarize(samples) {
  return {
    samples: samples.length,
    minMs: round(Math.min(...samples)),
    medianMs: round(percentile(samples, 50)),
    p95Ms: round(percentile(samples, 95)),
    maxMs: round(Math.max(...samples)),
  }
}

function round(ms) {
  return Math.round(ms * 10) / 10
}

/**
 * One row per series, with the baseline median and a status: `ok`,
 * `regressed`, `new` (in the results, not the baseline), or `missing` (in the
 * baseline, not the results). Without a baseline every row is `ok`.
 */
export function compare(series, baseline, { ratio, floorMs }) {
  const rows = Object.entries(series).map(([name, stats]) => {
    const base = baseline?.series[name]
    if (!base) return { name, ...stats, baselineMs: null, status: baseline ? 'new' : 'ok' }
    const regressed = stats.medianMs > base.medianMs * ratio && stats.medianMs - base.medianMs > floorMs
    return { name, ...stats, baselineMs: base.medianMs, status: regressed ? 'regressed' : 'ok' }
  })
  for (const [name, base] of Object.entries(baseline?.series ?? {})) {
    if (!(name in series)) {
      rows.push({ name, samples: 0, minMs: null, medianMs: null, p95Ms: null, maxMs: null, baselineMs: base.medianMs, status: 'missing' })
    }
  }
  return rows
}

/** The rows that fail the run. */
export function failures(rows) {
  return rows.filter((r) => r.status === 'regressed' || r.status === 'missing')
}

export function formatTable(rows) {
  const lines = [
    '| Series | Samples | Median ms | p95 ms | Min ms | Max ms | Baseline median ms | Status |',
    '|---|---:|---:|---:|---:|---:|---:|---|',
  ]
  const cell = (v) => (v === null ? '-' : String(v))
  for (const r of rows) {
    lines.push(`| ${r.name} | ${r.samples} | ${cell(r.medianMs)} | ${cell(r.p95Ms)} | ${cell(r.minMs)} | ${cell(r.maxMs)} | ${cell(r.baselineMs)} | ${r.status} |`)
  }
  return lines.join('\n')
}

/**
 * The first non-internal, non-link-local IPv4 address, for the remote nodes
 * to target (the backend rejects loopback). The backend's outbound blocklist
 * (backend/src/utils/outboundTarget.ts) also rejects documentation and
 * benchmark ranges such as 198.18.0.0/15; a host whose only address is in one
 * of those fails at node creation with "API URL target is not allowed".
 */
export function lanAddress(interfaces = networkInterfaces()) {
  for (const addresses of Object.values(interfaces)) {
    for (const a of addresses ?? []) {
      if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.')) return a.address
    }
  }
  throw new Error('No non-loopback IPv4 address found for the remote nodes to target')
}

/** Cache outcomes of `GET /statuses` from the backend's debug timing lines. */
export function statusOutcomes(logText) {
  const outcomes = []
  for (const line of logText.split('\n')) {
    if (!line.includes('[Stacks:debug]') || !line.includes('route=GET /statuses')) continue
    outcomes.push(/cacheOutcome=(\w+)/.exec(line)?.[1] ?? 'unknown')
  }
  return outcomes
}

/**
 * Throws unless the fleet overview has `nodes + 1` online nodes that each list
 * all `stacks` seeded stacks, and the statuses show every one running.
 */
export function assertMeasuredWork({ overview, statuses, stacks, nodes, when }) {
  const online = overview.filter((n) => n.status === 'online')
  if (online.length !== nodes + 1) {
    throw new Error(`${when}: expected ${nodes + 1} online nodes in the fleet overview, got ${online.length}`)
  }
  for (const node of overview) {
    const seen = (node.stacks ?? []).filter((s) => s.startsWith(PROJECT_PREFIX)).length
    if (seen !== stacks) throw new Error(`${when}: node "${node.name}" lists ${seen} of ${stacks} benchmark stacks`)
  }
  const running = Object.entries(statuses).filter(([name, info]) => name.startsWith(PROJECT_PREFIX) && info.status === 'running')
  if (running.length !== stacks) throw new Error(`${when}: ${running.length} of ${stacks} benchmark stacks report running`)
}

function composeFile(index) {
  return [
    'services:',
    '  app:',
    `    image: ${IMAGE}`,
    '    command: ["sleep", "infinity"]',
    '    labels:',
    '      io.sencho.bench: "1"',
    `      bench.index: "${index}"`,
    'networks:',
    '  default:',
    `    name: ${NETWORK}`,
    '    external: true',
    '',
  ].join('\n')
}

/** Runs `fn` over `items`, `size` at a time; every call settles before a failure is thrown. */
async function inBatches(items, size, fn) {
  for (let i = 0; i < items.length; i += size) {
    const results = await Promise.allSettled(items.slice(i, i + size).map(fn))
    const failed = results.find((r) => r.status === 'rejected')
    if (failed) throw failed.reason
  }
}

/**
 * Removes every benchmark container and the shared network, found by label so
 * a partly deployed or crashed run is cleaned up too.
 */
async function removeBenchResources() {
  const { stdout } = await run('docker', ['ps', '-aq', '--filter', `label=${BENCH_LABEL}`])
  const ids = stdout.split('\n').filter(Boolean)
  await inBatches(ids, 50, (id) => run('docker', ['rm', '-f', id]))
  const networks = await run('docker', ['network', 'ls', '-q', '--filter', `label=${BENCH_LABEL}`])
  for (const id of networks.stdout.split('\n').filter(Boolean)) await run('docker', ['network', 'rm', id])
}

/** The shared network, on a fixed subnet when Docker's default pools are used up. */
async function createNetwork() {
  const create = (extra) => run('docker', ['network', 'create', '--label', BENCH_LABEL, ...extra, NETWORK])
  try {
    await create([])
  } catch (error) {
    if (!/address pools have been fully subnetted/.test(error.stderr ?? '')) throw error
    await create(['--subnet', FALLBACK_SUBNET])
  }
}

async function deployStacks(composeDir, count) {
  await run('docker', ['pull', '-q', IMAGE])
  await createNetwork()
  const names = Array.from({ length: count }, (_, i) => `${PROJECT_PREFIX}${String(i + 1).padStart(3, '0')}`)
  for (const [i, name] of names.entries()) {
    mkdirSync(join(composeDir, name))
    writeFileSync(join(composeDir, name, 'compose.yaml'), composeFile(i + 1))
  }
  await inBatches(names, 10, (name) => run('docker', ['compose', 'up', '-d', '--quiet-pull'], { cwd: join(composeDir, name) }))
}

async function portInUse() {
  try {
    await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(1000) })
    return true
  } catch {
    return false
  }
}

/** Starts the backend; `exited` settles when the process is gone, for any reason. */
function startServer(workDir, logPath) {
  const log = openSync(logPath, 'a')
  const child = spawn(process.execPath, ['dist/index.js'], {
    cwd: join(REPO_ROOT, 'backend'),
    env: {
      ...process.env,
      NODE_ENV: 'production',
      API_RATE_LIMIT: '1000000',
      COMPOSE_DIR: join(workDir, 'compose'),
      DATA_DIR: join(workDir, 'data'),
      JWT_SECRET: randomBytes(32).toString('hex'),
    },
    stdio: ['ignore', log, log],
  })
  closeSync(log)
  const server = { child, spawnError: null }
  server.exited = new Promise((resolveExit) => {
    child.on('error', (error) => {
      server.spawnError = error
      resolveExit()
    })
    child.on('exit', () => resolveExit())
  })
  return server
}

function serverGone(server) {
  return server.spawnError !== null || server.child.exitCode !== null || server.child.signalCode !== null
}

/** SIGTERM, then SIGKILL if the backend is still running after its shutdown window. */
async function stopServer(server) {
  if (serverGone(server)) return
  server.child.kill('SIGTERM')
  const timedOut = await Promise.race([server.exited.then(() => false), sleep(15_000).then(() => true)])
  if (timedOut) {
    server.child.kill('SIGKILL')
    await server.exited
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Generous: on a host with slow fsync the schema setup alone can take a minute.
async function waitForHealth(server, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs
  let lastError = 'no response'
  while (Date.now() < deadline) {
    if (server.spawnError) throw new Error(`Backend could not start: ${server.spawnError.message}`)
    if (serverGone(server)) {
      throw new Error(`Backend exited (code ${server.child.exitCode}, signal ${server.child.signalCode})`)
    }
    try {
      const res = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(2000) })
      if (res.ok) return
      lastError = `HTTP ${res.status}`
    } catch (error) {
      lastError = error.cause?.code ?? error.message
    }
    await sleep(500)
  }
  throw new Error(`Backend did not report healthy within ${timeoutMs / 1000}s (last: ${lastError})`)
}

async function api(method, path, { cookie, body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(cookie && { cookie }) },
    body: body && JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`${method} ${path} returned ${res.status}: ${await res.text()}`)
  return res
}

/**
 * Creates the admin account, issues a full-admin API token (what a real remote
 * node is given), registers the remote nodes, and returns the session cookie.
 */
async function setUp(nodes, remoteHost) {
  const password = randomBytes(18).toString('base64url')
  const res = await api('POST', '/api/auth/setup', {
    body: { username: 'bench', password, confirmPassword: password },
  })
  const cookie = res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ')
  if (!cookie) throw new Error('Setup returned no session cookie')
  if (nodes === 0) return cookie
  const token = await (await api('POST', '/api/api-tokens', {
    cookie, body: { name: 'bench-fleet', scope: 'full-admin', expires_in: 30 },
  })).json()
  for (let i = 1; i <= nodes; i++) {
    await api('POST', '/api/nodes', {
      cookie,
      body: { name: `bench-remote-${i}`, type: 'remote', mode: 'proxy', api_url: `http://${remoteHost}:${PORT}`, api_token: token.token },
    })
  }
  return cookie
}

/**
 * Milliseconds for one GET, body included. Each request opens its own
 * connection (`agent: false`): the miss series waits longer than the server's
 * keep-alive timeout, and a reused socket could be closed under the request.
 */
function timeRequest(path, cookie) {
  return new Promise((resolvePromise, reject) => {
    const started = performance.now()
    const req = httpGet(`${BASE}${path}`, { agent: false, headers: { cookie }, timeout: 120_000 }, (res) => {
      res.resume()
      res.on('error', reject)
      res.on('end', () => {
        if (res.statusCode !== 200) reject(new Error(`GET ${path} returned ${res.statusCode}`))
        else resolvePromise(performance.now() - started)
      })
    })
    req.on('timeout', () => req.destroy(new Error(`GET ${path} took over 120s`)))
    req.on('error', reject)
  })
}

async function sampleSeries(path, cookie, count, gapMs = 0) {
  const samples = []
  for (let i = 0; i < count; i++) {
    if (gapMs > 0) await sleep(gapMs)
    samples.push(await timeRequest(path, cookie))
  }
  return summarize(samples)
}

async function checkMeasuredWork(cookie, options, when) {
  const overview = await (await api('GET', '/api/fleet/overview', { cookie })).json()
  const statuses = await (await api('GET', '/api/stacks/statuses', { cookie })).json()
  assertMeasuredWork({ overview, statuses, stacks: options.stacks, nodes: options.nodes, when })
}

const setDeveloperMode = (cookie, on) => api('PATCH', '/api/settings', { cookie, body: { developer_mode: on ? '1' : '0' } })

/**
 * The miss series, with developer mode on only for its duration so the
 * backend logs each request's cache outcome. Throws if any sample was served
 * from the cache.
 */
async function sampleMisses(cookie, count, logPath) {
  await setDeveloperMode(cookie, true)
  const logStart = statSync(logPath).size
  let summary
  try {
    summary = await sampleSeries('/api/stacks/statuses', cookie, count, STATUS_CACHE_EXPIRY_MS)
  } finally {
    await setDeveloperMode(cookie, false)
  }
  const outcomes = statusOutcomes(readFileSync(logPath).subarray(logStart).toString('utf8'))
  if (outcomes.length !== count || !outcomes.every((o) => MISS_OUTCOMES.has(o))) {
    throw new Error(`statuses-miss samples were not all cache misses (logged outcomes: ${outcomes.join(', ') || 'none'})`)
  }
  return summary
}

async function measureAll(cookie, options, logPath) {
  const series = {}
  series.stacks = await sampleSeries('/api/stacks', cookie, options.samples)
  // The miss series ends with a fresh computation, so the hit series that
  // follows starts on a warm cache.
  series['statuses-miss'] = await sampleMisses(cookie, options['miss-samples'], logPath)
  series['statuses-hit'] = await sampleSeries('/api/stacks/statuses', cookie, options.samples)
  series['fleet-overview'] = await sampleSeries('/api/fleet/overview', cookie, options.samples)
  return series
}

async function gitRevision() {
  try {
    return (await run('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT })).stdout.trim()
  } catch (error) {
    console.error(`Could not read the git revision: ${error.message}`)
    return null
  }
}

function printLogTail(logPath) {
  try {
    console.error(`Backend log tail (${logPath}):\n${readFileSync(logPath, 'utf8').split('\n').slice(-40).join('\n')}`)
  } catch {
    // The run failed before the backend started; there is no log.
  }
}

/**
 * Stops the backend and removes every benchmark resource. Safe to call more
 * than once; later calls wait for the first.
 */
function makeCleanup(state, options) {
  let pending = null
  return () => {
    pending ??= (async () => {
      const errors = []
      if (state.server) await stopServer(state.server).catch((e) => errors.push(e))
      console.error('Removing benchmark stacks...')
      await removeBenchResources().catch((e) => errors.push(e))
      if (!options['work-dir']) {
        try {
          rmSync(state.workDir, { recursive: true, force: true })
        } catch (e) {
          errors.push(e)
        }
      }
      if (errors.length > 0) {
        throw new Error(`Cleanup failed (remove containers labelled ${BENCH_LABEL} by hand): ${errors.map((e) => e.message).join('; ')}`)
      }
    })()
    return pending
  }
}

/** Ctrl-C or a cancelled job still stops the backend and removes the stacks. */
function cleanUpOnSignal(cleanup) {
  const onSignal = (signal) => {
    console.error(`${signal} received, cleaning up...`)
    cleanup().catch((error) => console.error(error.message)).finally(() => process.exit(130))
  }
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)
  return () => {
    process.off('SIGINT', onSignal)
    process.off('SIGTERM', onSignal)
  }
}

async function benchmark(options) {
  if (await portInUse()) throw new Error(`Port ${PORT} is already serving; stop that instance first`)
  const remoteHost = lanAddress()
  const state = { server: null, workDir: options['work-dir'] ?? mkdtempSync(join(tmpdir(), 'sencho-scale-')) }
  mkdirSync(join(state.workDir, 'compose'), { recursive: true })
  mkdirSync(join(state.workDir, 'data'), { recursive: true })
  const logPath = join(state.workDir, 'backend.log')
  const cleanup = makeCleanup(state, options)
  const detachSignals = cleanUpOnSignal(cleanup)
  let results
  try {
    await removeBenchResources()
    console.error(`Deploying ${options.stacks} stacks...`)
    await deployStacks(join(state.workDir, 'compose'), options.stacks)
    state.server = startServer(state.workDir, logPath)
    await waitForHealth(state.server)
    const cookie = await setUp(options.nodes, remoteHost)
    await checkMeasuredWork(cookie, options, 'Before timing')
    console.error('Measuring...')
    const series = await measureAll(cookie, options, logPath)
    await checkMeasuredWork(cookie, options, 'After timing')
    results = {
      meta: {
        date: new Date().toISOString(), revision: await gitRevision(), node: process.version,
        runner: process.env.GITHUB_ACTIONS === 'true' ? 'github-actions' : 'local',
        stacks: options.stacks, remoteNodes: options.nodes,
      },
      series,
    }
  } catch (error) {
    printLogTail(logPath)
    await cleanup().catch((cleanupError) => console.error(cleanupError.message))
    throw error
  } finally {
    detachSignals()
  }
  await cleanup()
  return results
}

async function main(args) {
  const options = parseArgs(args)
  const baseline = options.baseline ? parseBaseline(readFileSync(options.baseline, 'utf8')) : null
  if (baseline) assertSameScale(baseline, options)
  const results = await benchmark(options)
  if (options.out) writeFileSync(options.out, `${JSON.stringify(results, null, 2)}\n`)

  const rows = compare(results.series, baseline, { ratio: options.ratio, floorMs: options['floor-ms'] })
  const table = formatTable(rows)
  console.log(table)
  if (process.env.GITHUB_STEP_SUMMARY) {
    try {
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Scale benchmark (${options.stacks} stacks, ${options.nodes} remote nodes)\n\n${table}\n`)
    } catch (error) {
      console.error(`Could not write the job summary: ${error.message}`)
    }
  }
  const failed = failures(rows)
  for (const r of failed) {
    console.error(r.status === 'missing'
      ? `${r.name}: in the baseline but not measured by this run.`
      : `${r.name}: median ${r.medianMs} ms against a baseline of ${r.baselineMs} ms (limit ${options.ratio}x and +${options['floor-ms']} ms).`)
  }
  return failed.length > 0 ? 1 : 0
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
      const cause = error.cause ? ` (${error.cause.code ?? error.cause.message})` : ''
      console.error(`Scale benchmark failed: ${error.message}${cause}`)
      process.exitCode = 1
    },
  )
}
