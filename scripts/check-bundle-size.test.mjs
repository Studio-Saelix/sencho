/**
 * Tests for scripts/check-bundle-size.mjs
 *
 * Run:  node --test scripts/check-bundle-size.test.mjs
 *
 * The CLI cases build a small fake dist directory, so they exercise the same
 * path CI runs without needing a real Vite build.
 */

import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { chunkName, compare, groupOf, initialAssets, measure } from './check-bundle-size.mjs'

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), 'check-bundle-size.mjs')
const NAMED = ['monaco', 'xterm']

const INDEX_HTML = `<!doctype html>
<script src="/theme-init.js"></script>
<script type="module" src="/assets/index-Ab12Cd34.js"></script>
<link rel="modulepreload" href="/assets/monaco-Zz-9yY_8.js">
<link rel="stylesheet" href="/assets/index-Ef56Gh78.css">
<link rel="icon" href="/sencho-logo-dark.svg">`

const tempDirs = []
after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
})

/** A fake dist with a 64 KB incompressible entry chunk unless `entryBytes` says otherwise. */
function fakeDist(entryBytes = 64 * 1024) {
  const dir = mkdtempSync(join(tmpdir(), 'bundle-size-'))
  tempDirs.push(dir)
  mkdirSync(join(dir, 'assets'))
  writeFileSync(join(dir, 'index.html'), INDEX_HTML)
  // Random bytes do not compress, so the gzipped size tracks the raw size.
  const random = (n) => Buffer.from(Array.from({ length: n }, () => Math.floor(Math.random() * 256)))
  writeFileSync(join(dir, 'assets', 'index-Ab12Cd34.js'), random(entryBytes))
  writeFileSync(join(dir, 'assets', 'index-Ef56Gh78.css'), 'body{}')
  writeFileSync(join(dir, 'assets', 'monaco-Zz-9yY_8.js'), 'm')
  writeFileSync(join(dir, 'assets', 'xterm-Qq11Ww22.js'), 'x')
  writeFileSync(join(dir, 'assets', 'ts.worker-Rr33Tt44.js'), 'w')
  writeFileSync(join(dir, 'assets', 'SettingsView-Uu55Ii66.js'), 's')
  writeFileSync(join(dir, 'assets', 'ibm-plex-sans-latin-400-normal-CDDApCn2.woff2'), 'font')
  return dir
}

function writeBudget(dir, gzipKb) {
  const path = join(dir, 'budget.json')
  writeFileSync(path, JSON.stringify({ namedChunks: NAMED, gzipKb }))
  return path
}

function run(dist, budget) {
  return spawnSync(process.execPath, [SCRIPT, '--dist', dist, '--budget', budget], {
    encoding: 'utf8',
    env: { ...process.env, GITHUB_STEP_SUMMARY: '' },
  })
}

describe('chunkName', () => {
  it('strips the content hash, including hashes that contain a dash', () => {
    assert.equal(chunkName('index-Bh-4uhRG.js'), 'index')
    assert.equal(chunkName('ts.worker-DGGa2mF8.js'), 'ts.worker')
    assert.equal(chunkName('table-2-AbCdEf_1.css'), 'table-2')
  })

  it('returns null for assets that are not JS or CSS chunks', () => {
    assert.equal(chunkName('ibm-plex-sans-latin-400-normal-CDDApCn2.woff2'), null)
    assert.equal(chunkName('index.html'), null)
  })
})

describe('initialAssets', () => {
  it('collects every asset index.html loads or preloads, and nothing outside assets/', () => {
    assert.deepEqual(
      [...initialAssets(INDEX_HTML)].sort(),
      [['index-Ab12Cd34.js', 'src'], ['index-Ef56Gh78.css', 'href'], ['monaco-Zz-9yY_8.js', 'href']],
    )
  })
})

describe('groupOf', () => {
  const initial = initialAssets(INDEX_HTML)

  it('splits first-visit assets into the entry script, its preloads, and stylesheets', () => {
    assert.equal(groupOf('index-Ab12Cd34.js', initial, NAMED), 'entry-js')
    assert.equal(groupOf('index-Ef56Gh78.css', initial, NAMED), 'initial-css')
  })

  it('puts a preloaded named chunk in preload-js, not in its own group', () => {
    assert.equal(groupOf('monaco-Zz-9yY_8.js', initial, NAMED), 'preload-js')
  })

  it('separates named vendor chunks, workers, and other lazy chunks', () => {
    assert.equal(groupOf('xterm-Qq11Ww22.js', initial, NAMED), 'xterm')
    assert.equal(groupOf('ts.worker-Rr33Tt44.js', initial, NAMED), 'workers')
    assert.equal(groupOf('SettingsView-Uu55Ii66.js', initial, NAMED), 'lazy-js')
    assert.equal(groupOf('xterm-Oo77Pp88.css', initial, NAMED), 'lazy-css')
  })
})

describe('measure and compare', () => {
  it('measures gzipped bytes per group and totals the JavaScript', () => {
    const groups = measure(fakeDist(), NAMED)
    assert.ok(groups['entry-js'] > 64 * 1024, 'random entry chunk does not compress')
    assert.equal(
      groups['total-js'],
      groups['entry-js'] + groups['preload-js'] + groups.xterm + groups.workers + groups['lazy-js'],
    )
    assert.equal(groups.monaco, undefined, 'preloaded monaco is counted as a preload')
  })

  it('flags a group over budget and a measured group with no budget', () => {
    const rows = compare({ 'entry-js': 3 * 1024, xterm: 1024 }, { 'entry-js': 2, monaco: 5 })
    assert.deepEqual(
      rows.map((r) => [r.group, r.status]),
      [['entry-js', 'over'], ['monaco', 'ok'], ['xterm', 'no budget']],
    )
  })
})

describe('CLI', () => {
  const generous = {
    'entry-js': 100, 'preload-js': 1, 'initial-css': 1, 'lazy-js': 1, 'lazy-css': 1,
    workers: 1, monaco: 1, xterm: 1, 'total-js': 100,
  }

  it('passes when every group is within budget', () => {
    const dist = fakeDist()
    const result = run(dist, writeBudget(dist, generous))
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /\| entry-js \| \d+\.\d \| 100 \| ok \|/)
  })

  it('fails and names the chunk, its size, and its budget when a heavy import lands in the entry chunk', () => {
    const dist = fakeDist(200 * 1024)
    const result = run(dist, writeBudget(dist, generous))
    assert.equal(result.status, 1)
    assert.match(result.stderr, /Bundle group "entry-js" is \d+\.\d KB gzipped, over its 100 KB budget/)
  })

  it('fails when a group has no budget', () => {
    const dist = fakeDist()
    const { workers, ...withoutWorkers } = generous
    const result = run(dist, writeBudget(dist, withoutWorkers))
    assert.equal(result.status, 1)
    assert.match(result.stderr, /Bundle group "workers" has no budget/)
  })
})
