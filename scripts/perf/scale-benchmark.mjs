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
 *   statuses-hit       GET /api/stacks/statuses while the status cache is warm
 *   statuses-miss      GET /api/stacks/statuses after the cache has expired
 *   fleet-overview     GET /api/fleet/overview
 *
 * Each series reports min, median, p95, and max over its samples. With
 * `--baseline`, a series fails when its median is over `ratio` times the
 * baseline median and also more than `floorMs` slower, so CI noise on fast
 * endpoints does not fail the run.
 *
 * Requirements: `npm run build` in backend/, Docker with the compose plugin,
 * and port 1852 free (the backend's fixed port).
 *
 * Usage:
 *   node scripts/perf/scale-benchmark.mjs [--stacks 200] [--nodes 10] [--samples 30]
 *     [--miss-samples 5] [--work-dir <dir>] [--out results.json]
 *     [--baseline scripts/perf/scale-benchmark-baseline.json]
 *
 * Writes a table to stdout and, when GITHUB_STEP_SUMMARY is set, to the job
 * summary. Exits 1 on a regression or when the run itself fails.
 */

import { spawn, execFile } from 'node:child_process'
import { appendFileSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
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
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

const DEFAULTS = {
  stacks: 200, nodes: 10, samples: 30, 'miss-samples': 5,
  'work-dir': null, out: null, baseline: null, ratio: 1.5, 'floor-ms': 25,
}
const NUMERIC = new Set(['stacks', 'nodes', 'samples', 'miss-samples', 'ratio', 'floor-ms'])

export function parseArgs(args) {
  const options = { ...DEFAULTS }
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i].startsWith('--') ? args[i].slice(2) : null
    const value = args[i + 1]
    if (!key || !(key in DEFAULTS)) throw new Error(`Unknown argument "${args[i]}"`)
    if (value === undefined || value.startsWith('--')) throw new Error(`${args[i]} needs a value`)
    if (NUMERIC.has(key)) {
      const n = Number(value)
      if (!Number.isFinite(n) || n < 0) throw new Error(`${args[i]} must be a non-negative number`)
      options[key] = n
    } else {
      options[key] = value
    }
  }
  if (options.samples < 1) throw new Error('--samples must be at least 1')
  return options
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
 * One row per series in the results, with the baseline median and a status:
 * `ok`, `regressed`, or `new` when the baseline has no such series.
 */
export function compare(series, baseline, { ratio, floorMs }) {
  return Object.entries(series).map(([name, stats]) => {
    const base = baseline?.series?.[name]
    if (!base) return { name, ...stats, baselineMs: null, status: baseline ? 'new' : 'ok' }
    const regressed = stats.medianMs > base.medianMs * ratio && stats.medianMs - base.medianMs > floorMs
    return { name, ...stats, baselineMs: base.medianMs, status: regressed ? 'regressed' : 'ok' }
  })
}

export function formatTable(rows) {
  const lines = [
    '| Series | Samples | Median ms | p95 ms | Min ms | Max ms | Baseline median ms | Status |',
    '|---|---:|---:|---:|---:|---:|---:|---|',
  ]
  for (const r of rows) {
    const base = r.baselineMs === null ? '-' : String(r.baselineMs)
    lines.push(`| ${r.name} | ${r.samples} | ${r.medianMs} | ${r.p95Ms} | ${r.minMs} | ${r.maxMs} | ${base} | ${r.status} |`)
  }
  return lines.join('\n')
}

/** The first IPv4 address a proxy-mode node may target: not loopback or link-local. */
export function lanAddress(interfaces = networkInterfaces()) {
  for (const addresses of Object.values(interfaces)) {
    for (const a of addresses ?? []) {
      if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.')) return a.address
    }
  }
  throw new Error('No non-loopback IPv4 address found for the remote nodes to target')
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

async function inBatches(items, size, fn) {
  for (let i = 0; i < items.length; i += size) {
    await Promise.all(items.slice(i, i + size).map(fn))
  }
}

/**
 * Removes every benchmark container and the shared network, found by label so
 * a partly deployed or crashed run is cleaned up too.
 */
async function removeBenchResources() {
  const { stdout } = await run('docker', ['ps', '-aq', '--filter', `label=${BENCH_LABEL}`])
  const ids = stdout.split('\n').filter(Boolean)
  await inBatches(ids, 50, async (id) => run('docker', ['rm', '-f', id]))
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

function startServer(workDir, logPath) {
  const log = openSync(logPath, 'a')
  return spawn(process.execPath, ['dist/index.js'], {
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
}

// Generous: on a host with slow fsync the schema setup alone can take a minute.
async function waitForHealth(server, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`Backend exited with code ${server.exitCode}`)
    try {
      const res = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(2000) })
      if (res.ok) return
    } catch {
      // Not listening yet.
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`Backend did not report healthy within ${timeoutMs / 1000}s`)
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

/** Creates the admin account and returns its session cookie. */
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
    if (gapMs > 0) await new Promise((r) => setTimeout(r, gapMs))
    samples.push(await timeRequest(path, cookie))
  }
  return summarize(samples)
}

/** Checks the instance sees what was seeded, so a broken seed cannot pass as a fast run. */
async function assertSeeded(cookie, stacks, nodes) {
  const list = await (await api('GET', '/api/stacks', { cookie })).json()
  const benchStacks = list.filter((name) => name.startsWith(PROJECT_PREFIX))
  if (benchStacks.length !== stacks) throw new Error(`Expected ${stacks} stacks, the API lists ${benchStacks.length}`)
  const overview = await (await api('GET', '/api/fleet/overview', { cookie })).json()
  const online = overview.filter((n) => n.status === 'online').length
  if (online !== nodes + 1) throw new Error(`Expected ${nodes + 1} online nodes in the fleet overview, got ${online}`)
}

async function measureAll(cookie, options) {
  // Each miss sample waits out the status cache TTL first, so earlier reads
  // (including the seed check) cannot turn it into a hit.
  const missSamples = options['miss-samples']
  const series = {}
  series.stacks = await sampleSeries('/api/stacks', cookie, options.samples)
  if (missSamples > 0) {
    series['statuses-miss'] = await sampleSeries('/api/stacks/statuses', cookie, missSamples, STATUS_CACHE_EXPIRY_MS)
  }
  series['statuses-hit'] = await sampleSeries('/api/stacks/statuses', cookie, options.samples)
  series['fleet-overview'] = await sampleSeries('/api/fleet/overview', cookie, options.samples)
  return series
}

async function gitRevision() {
  try {
    return (await run('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT })).stdout.trim()
  } catch {
    return null
  }
}

async function benchmark(options) {
  if (await portInUse()) throw new Error(`Port ${PORT} is already serving; stop that instance first`)
  const remoteHost = lanAddress()
  const workDir = options['work-dir'] ?? mkdtempSync(join(tmpdir(), 'sencho-scale-'))
  mkdirSync(join(workDir, 'compose'), { recursive: true })
  mkdirSync(join(workDir, 'data'), { recursive: true })
  const logPath = join(workDir, 'backend.log')
  let server = null
  try {
    await removeBenchResources()
    console.error(`Deploying ${options.stacks} stacks...`)
    await deployStacks(join(workDir, 'compose'), options.stacks)
    server = startServer(workDir, logPath)
    await waitForHealth(server)
    const cookie = await setUp(options.nodes, remoteHost)
    await assertSeeded(cookie, options.stacks, options.nodes)
    console.error('Measuring...')
    const series = await measureAll(cookie, options)
    return {
      meta: {
        date: new Date().toISOString(), revision: await gitRevision(), node: process.version,
        runner: process.env.RUNNER_NAME ? 'github-actions' : 'local',
        stacks: options.stacks, remoteNodes: options.nodes,
      },
      series,
    }
  } catch (error) {
    try {
      console.error(`Backend log tail (${logPath}):\n${readFileSync(logPath, 'utf8').split('\n').slice(-40).join('\n')}`)
    } catch {
      // The run failed before the backend started; there is no log.
    }
    throw error
  } finally {
    server?.kill('SIGTERM')
    console.error('Removing benchmark stacks...')
    await removeBenchResources().catch((error) => console.error(`Cleanup failed, remove containers labelled ${BENCH_LABEL} by hand: ${error.message}`))
    if (!options['work-dir']) rmSync(workDir, { recursive: true, force: true })
  }
}

async function main(args) {
  const options = parseArgs(args)
  const baseline = options.baseline ? JSON.parse(readFileSync(options.baseline, 'utf8')) : null
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
  const regressed = rows.filter((r) => r.status === 'regressed')
  for (const r of regressed) {
    console.error(`${r.name}: median ${r.medianMs} ms against a baseline of ${r.baselineMs} ms (limit ${options.ratio}x and +${options['floor-ms']} ms).`)
  }
  return regressed.length > 0 ? 1 : 0
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
