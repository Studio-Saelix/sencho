/**
 * Tests for scripts/check-bundle-size.mjs
 *
 * Run:  node --test scripts/check-bundle-size.test.mjs
 *
 * The CLI cases build a small fake dist directory shaped like Vite's output
 * (crossorigin attributes, a modulepreloaded vendor chunk, fonts next to the
 * chunks), so they exercise the same path CI runs without a real build.
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  chunkName, compare, formatTable, groupOf, initialAssets, measure, parseArgs, parseBudget,
} from './check-bundle-size.mjs'

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url))
const SCRIPT = resolve(SCRIPTS_DIR, 'check-bundle-size.mjs')
const NAMED = ['monaco', 'xterm']

const INDEX_HTML = `<!doctype html>
<link rel="icon" type="image/svg+xml" href="/sencho-logo-dark.svg" />
<script src="/theme-init.js"></script>
<script type="module" crossorigin src="/assets/index-Ab12Cd34.js"></script>
<link rel="modulepreload" crossorigin href="/assets/rolldown-runtime-Kk00Ll11.js">
<link rel="modulepreload" crossorigin href="/assets/monaco-Zz-9yY_8.js">
<link rel="prefetch" href="/assets/SettingsView-Uu55Ii66.js">
<link rel="stylesheet" crossorigin href="/assets/index-Ef56Gh78.css">`

const tempDirs = []
after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
})

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'bundle-size-'))
  tempDirs.push(dir)
  return dir
}

/**
 * `n` bytes from a SHA-256 chain: incompressible like random data, so the
 * gzipped size tracks the raw size, but the same on every run.
 */
function incompressible(n) {
  const blocks = []
  let block = createHash('sha256').update('bundle-size').digest()
  for (let size = 0; size < n; size += block.length) {
    blocks.push(block)
    block = createHash('sha256').update(block).digest()
  }
  return Buffer.concat(blocks).subarray(0, n)
}

/** A fake dist whose entry chunk is `entryBytes` of incompressible data. */
function fakeDist({ entryBytes = 64 * 1024, indexHtml = INDEX_HTML, extra = {} } = {}) {
  const dir = tempDir()
  mkdirSync(join(dir, 'assets'))
  writeFileSync(join(dir, 'index.html'), indexHtml)
  const files = {
    'index-Ab12Cd34.js': incompressible(entryBytes),
    'index-Ef56Gh78.css': 'body{}',
    'rolldown-runtime-Kk00Ll11.js': 'r',
    'monaco-Zz-9yY_8.js': 'm',
    'xterm-Qq11Ww22.js': 'x',
    'xterm-Oo77Pp88.css': '.x{}',
    'ts.worker-Rr33Tt44.js': 'w',
    'SettingsView-Uu55Ii66.js': 's',
    'ibm-plex-sans-latin-400-normal-CDDApCn2.woff2': 'font',
    ...extra,
  }
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, 'assets', name), content)
  return dir
}

const GENEROUS = {
  'entry-js': 100, 'preload-js': 1, 'first-load-js': 100, 'initial-css': 1, 'lazy-js': 1, 'lazy-css': 1,
  workers: 1, monaco: 1, xterm: 1, 'total-js': 100,
}

function writeBudget(dir, gzipKb, namedChunks = NAMED) {
  const path = join(dir, 'budget.json')
  writeFileSync(path, JSON.stringify({ namedChunks, gzipKb }))
  return path
}

function run(args, env = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { ...process.env, GITHUB_STEP_SUMMARY: '', ...env },
  })
}

describe('chunkName', () => {
  it('strips the content hash, including hashes that contain a dash or underscore', () => {
    assert.equal(chunkName('index-Bh-4uhRG.js'), 'index')
    assert.equal(chunkName('dist-53YMm-pa.js'), 'dist')
    assert.equal(chunkName('ts.worker-DGGa2mF8.js'), 'ts.worker')
    assert.equal(chunkName('table-2-AbCdEf_1.css'), 'table-2')
  })

  it('returns null for a name without a hash', () => {
    assert.equal(chunkName('sw.js'), null)
    assert.equal(chunkName('index.html'), null)
  })
})

describe('initialAssets', () => {
  it('reads the entry script, modulepreloads, and stylesheets, and skips prefetch and non-asset URLs', () => {
    assert.deepEqual([...initialAssets(INDEX_HTML)].sort(), [
      ['index-Ab12Cd34.js', 'entry'],
      ['index-Ef56Gh78.css', 'css'],
      ['monaco-Zz-9yY_8.js', 'preload'],
      ['rolldown-runtime-Kk00Ll11.js', 'preload'],
    ])
  })

  it('accepts single quotes, unquoted values, a relative base, and any attribute order', () => {
    const html = `<script src='./assets/index-Ab12Cd34.js' type=module></script>
      <link href=assets/monaco-Zz-9yY_8.js rel=modulepreload>`
    assert.deepEqual([...initialAssets(html)].sort(), [
      ['index-Ab12Cd34.js', 'entry'],
      ['monaco-Zz-9yY_8.js', 'preload'],
    ])
  })
})

describe('groupOf', () => {
  const initial = initialAssets(INDEX_HTML)

  it('splits first-visit assets into the entry script, its preloads, and stylesheets', () => {
    assert.equal(groupOf('index-Ab12Cd34.js', initial, NAMED), 'entry-js')
    assert.equal(groupOf('rolldown-runtime-Kk00Ll11.js', initial, NAMED), 'preload-js')
    assert.equal(groupOf('index-Ef56Gh78.css', initial, NAMED), 'initial-css')
  })

  it('keeps a named vendor chunk in its own group even when it is preloaded', () => {
    assert.equal(groupOf('monaco-Zz-9yY_8.js', initial, NAMED), 'monaco')
    assert.equal(groupOf('xterm-Qq11Ww22.js', initial, NAMED), 'xterm')
  })

  it('separates workers from other lazy chunks', () => {
    assert.equal(groupOf('ts.worker-Rr33Tt44.js', initial, NAMED), 'workers')
    assert.equal(groupOf('SettingsView-Uu55Ii66.js', initial, NAMED), 'lazy-js')
    assert.equal(groupOf('xterm-Oo77Pp88.css', initial, NAMED), 'lazy-css')
  })
})

describe('measure', () => {
  it('counts each chunk once per group, and preloaded named chunks toward first load', () => {
    const groups = measure(fakeDist(), NAMED)
    const gz = (s) => groups[s] ?? 0
    assert.ok(gz('entry-js') > 64 * 1024, 'incompressible entry chunk does not shrink')
    assert.equal(gz('first-load-js'), gz('entry-js') + gz('preload-js') + gz('monaco'))
    assert.equal(
      gz('total-js'),
      gz('entry-js') + gz('preload-js') + gz('monaco') + gz('xterm') + gz('workers') + gz('lazy-js'),
    )
    assert.ok(gz('lazy-css') > 0 && gz('initial-css') > 0)
  })

  it('throws when index.html has no entry script under assets/', () => {
    const dist = fakeDist({ indexHtml: '<html><body>nothing here</body></html>' })
    assert.throws(() => measure(dist, NAMED), /has no module script under assets/)
  })

  it('throws on a JS or CSS asset whose name has no recognisable hash', () => {
    const dist = fakeDist({ extra: { 'sw.js': 'self' } })
    assert.throws(() => measure(dist, NAMED), /Unrecognised asset name "sw.js"/)
  })
})

describe('compare', () => {
  it('flags over budget, no budget, and a budgeted group that measured nothing; the exact budget passes', () => {
    const rows = compare({ 'entry-js': 3 * 1024, 'lazy-js': 2 * 1024, xterm: 1024 }, { 'entry-js': 2, 'lazy-js': 2, monaco: 5 })
    assert.deepEqual(rows.map((r) => [r.group, r.status]), [
      ['entry-js', 'over'], ['lazy-js', 'ok'], ['monaco', 'empty'], ['xterm', 'no budget'],
    ])
  })

  it('formats one table row per group', () => {
    const table = formatTable([{ group: 'entry-js', kb: 1.25, budget: 2, status: 'ok' }])
    assert.match(table, /^\| Group \| Gzipped KB \| Budget KB \| Status \|/)
    assert.match(table, /\| entry-js \| 1\.3 \| 2 \| ok \|$/)
  })
})

describe('parseBudget and parseArgs', () => {
  it('rejects a budget that is not a positive number', () => {
    for (const kb of ['"625kb"', '0', '-1', 'null']) {
      assert.throws(
        () => parseBudget(`{"namedChunks":[],"gzipKb":{"entry-js":${kb}}}`, 'b.json'),
        /"entry-js" must be a positive number/,
        `budget ${kb}`,
      )
    }
  })

  it('rejects a malformed namedChunks or gzipKb, and a named chunk that shadows a group', () => {
    assert.throws(() => parseBudget('{"gzipKb":{}}', 'b.json'), /namedChunks must be an array/)
    assert.throws(() => parseBudget('{"namedChunks":[1],"gzipKb":{}}', 'b.json'), /namedChunks must be an array/)
    assert.throws(() => parseBudget('{"namedChunks":[]}', 'b.json'), /gzipKb must be an object/)
    assert.throws(() => parseBudget('{"namedChunks":[],"gzipKb":[]}', 'b.json'), /gzipKb must be an object/)
    assert.throws(() => parseBudget('{"namedChunks":["total-js"],"gzipKb":{}}', 'b.json'), /"total-js" is a group name/)
  })

  it('accepts the committed budget file', () => {
    const path = resolve(SCRIPTS_DIR, '../frontend/bundle-budget.json')
    const budget = parseBudget(readFileSync(path, 'utf8'), path)
    for (const name of budget.namedChunks) assert.ok(budget.gzipKb[name], `${name} has a budget`)
  })

  it('rejects unknown flags and flags without a value', () => {
    assert.throws(() => parseArgs(['--dst', 'x']), /Unknown argument "--dst"/)
    assert.throws(() => parseArgs(['--dist=x']), /Unknown argument "--dist=x"/)
    assert.throws(() => parseArgs(['--dist']), /--dist needs a value/)
    assert.throws(() => parseArgs(['--dist', '--budget', 'b']), /--dist needs a value/)
    assert.deepEqual(parseArgs(['--budget', 'b.json']), { dist: 'frontend/dist', budget: 'b.json' })
  })
})

describe('CLI', () => {
  it('passes when every group is within budget and writes the job summary', () => {
    const dist = fakeDist()
    const summary = join(dist, 'summary.md')
    const result = run(['--dist', dist, '--budget', writeBudget(dist, GENEROUS)], { GITHUB_STEP_SUMMARY: summary })
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /\| entry-js \| \d+\.\d \| 100 \| ok \|/)
    assert.match(readFileSync(summary, 'utf8'), /### Frontend bundle size[\s\S]*\| entry-js \|/)
  })

  it('fails, names the group, its size and its budget, and still prints the table when a heavy import lands in the entry chunk', () => {
    const dist = fakeDist({ entryBytes: 200 * 1024 })
    const result = run(['--dist', dist, '--budget', writeBudget(dist, GENEROUS)])
    assert.equal(result.status, 1)
    assert.match(result.stderr, /Bundle group "entry-js" is \d+\.\d KB gzipped, over its 100 KB budget/)
    assert.match(result.stdout, /\| entry-js \| \d+\.\d \| 100 \| over \|/)
  })

  it('fails when a group has no budget', () => {
    const dist = fakeDist()
    const { workers: _omitted, ...withoutWorkers } = GENEROUS
    const result = run(['--dist', dist, '--budget', writeBudget(dist, withoutWorkers)])
    assert.equal(result.status, 1)
    assert.match(result.stderr, /Bundle group "workers" has no budget/)
  })

  it('fails when a named chunk no longer exists in the build', () => {
    const dist = fakeDist()
    const result = run(['--dist', dist, '--budget', writeBudget(dist, { ...GENEROUS, charts: 5 }, [...NAMED, 'charts'])])
    assert.equal(result.status, 1)
    assert.match(result.stderr, /Bundle group "charts" measured 0 bytes/)
  })

  it('fails with a message, not a pass, when the dist cannot be read', () => {
    const dir = tempDir()
    const result = run(['--dist', join(dir, 'missing'), '--budget', writeBudget(dir, GENEROUS)])
    assert.equal(result.status, 1)
    assert.match(result.stderr, /^Bundle size check failed: /)
  })

  it('still reports the result when the job summary cannot be written', () => {
    const dist = fakeDist({ entryBytes: 200 * 1024 })
    const result = run(['--dist', dist, '--budget', writeBudget(dist, GENEROUS)], { GITHUB_STEP_SUMMARY: join(dist, 'no', 'such', 'file') })
    assert.equal(result.status, 1)
    assert.match(result.stderr, /Bundle group "entry-js" is .* over its 100 KB budget/)
    assert.match(result.stderr, /Could not write the job summary/)
  })

  it('runs the check when invoked through a symlinked directory', () => {
    const link = join(tempDir(), 'scripts')
    symlinkSync(SCRIPTS_DIR, link)
    const viaLink = (dist, budget) => spawnSync(
      process.execPath,
      [join(link, 'check-bundle-size.mjs'), '--dist', dist, '--budget', budget],
      { encoding: 'utf8', env: { ...process.env, GITHUB_STEP_SUMMARY: '' } },
    )
    const ok = fakeDist()
    const passed = viaLink(ok, writeBudget(ok, GENEROUS))
    assert.equal(passed.status, 0, passed.stderr)
    assert.match(passed.stdout, /\| entry-js \|/, 'the check ran and printed its table')
    const heavy = fakeDist({ entryBytes: 200 * 1024 })
    assert.equal(viaLink(heavy, writeBudget(heavy, GENEROUS)).status, 1, 'a symlinked invocation must not import-and-exit 0')
  })

  it('does not run the check when imported from stdin', () => {
    const result = spawnSync(process.execPath, ['--input-type=module', '-'], {
      input: `await import(${JSON.stringify(SCRIPT)}); console.log('imported')`,
      encoding: 'utf8',
    })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout.trim(), 'imported')
  })
})
