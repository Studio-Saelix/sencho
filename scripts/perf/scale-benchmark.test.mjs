/**
 * Tests for scripts/perf/scale-benchmark.mjs
 *
 * Run:  node --test scripts/perf/scale-benchmark.test.mjs
 *
 * These cover the parts that decide pass or fail (statistics, the regression
 * rule and its limits, baseline validation and scale check, the checks that
 * the run measured real work and that miss samples were misses, the debug log
 * parsing, argument parsing, the remote-node address). The benchmark itself needs
 * Docker and a built backend, and runs in the scale-benchmark workflow.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  assertAllMisses, assertMeasuredWork, assertSameScale, compare, failures, formatTable, lanAddress, limitsFrom,
  parseArgs, parseBaseline, percentile, prepareWorkDir, statusOutcomes, summarize,
} from './scale-benchmark.mjs'

const LIMITS = { ratio: 1.5, floorMs: 25 }
const stats = (medianMs) => ({ samples: 30, minMs: medianMs, medianMs, p95Ms: medianMs, maxMs: medianMs })
const baselineOf = (series, meta = { stacks: 200, remoteNodes: 10 }) => ({ meta, series })

describe('percentile and summarize', () => {
  it('uses the nearest rank, so the median of an even list is the lower middle value', () => {
    assert.equal(percentile([4, 1, 3, 2], 50), 2)
    assert.equal(percentile([5, 1, 4, 2, 3], 50), 3)
    assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 100], 95), 19)
    assert.equal(percentile([7], 95), 7)
    assert.equal(percentile([3, 1, 2], 0), 1)
    assert.equal(percentile([3, 1, 2], 100), 3)
  })

  it('summarizes samples without reordering the caller list', () => {
    const samples = [30.04, 10, 20]
    assert.deepEqual(summarize(samples), { samples: 3, minMs: 10, medianMs: 20, p95Ms: 30, maxMs: 30 })
    assert.deepEqual(samples, [30.04, 10, 20])
  })
})

describe('compare and failures', () => {
  const baseline = baselineOf({ stacks: { medianMs: 100 }, 'statuses-hit': { medianMs: 4 } })

  it('flags a series only when it is both over the ratio and over the floor', () => {
    const rows = compare({ stacks: stats(151), 'statuses-hit': stats(28) }, baseline, LIMITS)
    assert.deepEqual(rows.map((r) => [r.name, r.status, r.baselineMs]), [
      ['stacks', 'regressed', 100],
      ['statuses-hit', 'ok', 4],
    ])
  })

  it('passes at exactly the ratio and at exactly the floor', () => {
    assert.equal(compare({ stacks: stats(150) }, baseline, LIMITS)[0].status, 'ok')
    assert.equal(compare({ 'statuses-hit': stats(29) }, baseline, LIMITS)[0].status, 'ok')
    assert.equal(compare({ 'statuses-hit': stats(29.1) }, baseline, LIMITS)[0].status, 'regressed')
  })

  it('marks a series the baseline lacks as new and one the run lacks as missing', () => {
    const rows = compare({ stacks: stats(100), fresh: stats(5) }, baseline, LIMITS)
    assert.deepEqual(rows.map((r) => [r.name, r.status]), [
      ['stacks', 'ok'], ['fresh', 'new'], ['statuses-hit', 'missing'],
    ])
    assert.deepEqual(failures(rows).map((r) => r.name), ['statuses-hit'])
  })

  it('fails the run on regressed and missing rows only, and on nothing without a baseline', () => {
    const rows = compare({ stacks: stats(999), 'statuses-hit': stats(4) }, baseline, LIMITS)
    assert.deepEqual(failures(rows).map((r) => r.name), ['stacks'])
    assert.deepEqual(failures(compare({ stacks: stats(999) }, null, LIMITS)), [])
    assert.deepEqual(failures([]), [])
  })

  it('formats every status, with a dash for absent numbers', () => {
    const table = formatTable(compare({ stacks: stats(151), fresh: stats(5) }, baseline, LIMITS))
    assert.match(table, /\| stacks \| 30 \| 151 \| 151 \| 151 \| 151 \| 100 \| regressed \|/)
    assert.match(table, /\| fresh \| 30 \| 5 \| 5 \| 5 \| 5 \| - \| new \|/)
    assert.match(table, /\| statuses-hit \| 0 \| - \| - \| - \| - \| 4 \| missing \|/)
  })
})

describe('parseBaseline and assertSameScale', () => {
  const valid = JSON.stringify(baselineOf({ stacks: { medianMs: 12 } }))

  it('accepts a baseline with its scale and positive medians', () => {
    assert.equal(parseBaseline(valid).series.stacks.medianMs, 12)
  })

  it('rejects a baseline without its scale, without series, or with a bad median', () => {
    assert.throws(() => parseBaseline('{"series":{"stacks":{"medianMs":1}}}'), /must record the stacks and remoteNodes/)
    assert.throws(() => parseBaseline(JSON.stringify(baselineOf({}))), /has no series/)
    for (const medianMs of [0, -1, null, '12']) {
      assert.throws(() => parseBaseline(JSON.stringify(baselineOf({ stacks: { medianMs } }))), /needs a positive medianMs/)
    }
    assert.throws(() => parseBaseline(JSON.stringify(baselineOf({ stacks: {} }))), /needs a positive medianMs/)
    assert.throws(() => parseBaseline('{"meta":{"stacks":200,"remoteNodes":10},"series":{"stacks":{"medianMs":1e999}}}'), /needs a positive medianMs/)
    assert.throws(() => parseBaseline('null'), /must record the stacks and remoteNodes/)
    assert.throws(() => parseBaseline('[]'), /must record the stacks and remoteNodes/)
  })

  it('names the file when it is not JSON', () => {
    assert.throws(() => parseBaseline('{oops', 'scripts/perf/scale-benchmark-baseline.json'), /scale-benchmark-baseline.json is not valid JSON/)
  })

  it('refuses to compare a run at a different scale', () => {
    const baseline = parseBaseline(valid)
    assert.doesNotThrow(() => assertSameScale(baseline, { stacks: 200, nodes: 10 }))
    assert.throws(() => assertSameScale(baseline, { stacks: 60, nodes: 10 }), /taken at 200 stacks and 10 remote nodes; this run uses 60 and 10/)
    assert.throws(() => assertSameScale(baseline, { stacks: 200, nodes: 5 }), /this run uses 200 and 5/)
  })
})

describe('statusOutcomes', () => {
  it('reads the cache outcome of each statuses request and ignores other debug lines', () => {
    const log = [
      '[Stacks:debug] route=GET / nodeId=1 count=200 elapsedMs=4 outcome=ok',
      '[Stacks:debug] route=GET /statuses nodeId=1 cacheOutcome=computed count=200 dockerMs=180 elapsedMs=210 outcome=ok',
      '[Fleet:debug] Overview requested, fetching 11 nodes',
      '[Stacks:debug] route=GET /statuses nodeId=1 cacheOutcome=hit count=200 elapsedMs=1 outcome=ok',
      '[Stacks:debug] route=GET /statuses nodeId=1 cacheOutcome=null count=0 outcome=error',
    ].join('\n')
    assert.deepEqual(statusOutcomes(log), ['computed', 'hit', 'null'])
  })
})

describe('assertAllMisses', () => {
  it('accepts one computed or inflight outcome per sample', () => {
    assert.doesNotThrow(() => assertAllMisses(['computed', 'inflight', 'computed'], 3))
  })

  it('rejects a hit, a stale fallback, an unreadable outcome, or a count that does not match', () => {
    assert.throws(() => assertAllMisses(['computed', 'hit', 'computed'], 3), /logged outcomes: computed, hit, computed/)
    assert.throws(() => assertAllMisses(['stale'], 1), /not all cache misses/)
    assert.throws(() => assertAllMisses(['unknown'], 1), /not all cache misses/)
    assert.throws(() => assertAllMisses(['computed', 'computed'], 3), /not all cache misses/)
    assert.throws(() => assertAllMisses([], 1), /logged outcomes: none/)
  })
})

describe('assertMeasuredWork', () => {
  const names = (n) => Array.from({ length: n }, (_, i) => `senchobench-${String(i + 1).padStart(3, '0')}`)
  const node = (name, stacks, status = 'online') => ({ name, status, stacks })
  const running = (n) => Object.fromEntries(names(n).map((s) => [s, { status: 'running' }]))
  const good = {
    overview: [node('Local', names(3)), node('bench-remote-1', [...names(3), 'other'])],
    statuses: { ...running(3), other: { status: 'exited' } },
    stacks: 3,
    nodes: 1,
    when: 'Before timing',
  }

  it('passes when every node is online and lists every stack, and every stack runs', () => {
    assert.doesNotThrow(() => assertMeasuredWork(good))
  })

  it('fails when a remote node went offline', () => {
    const overview = [good.overview[0], node('bench-remote-1', names(3), 'offline')]
    assert.throws(() => assertMeasuredWork({ ...good, overview }), /Before timing: expected 2 online nodes in the fleet overview, got 1/)
  })

  it('fails when a node is online but its stack list did not come back', () => {
    const overview = [good.overview[0], node('bench-remote-1', null)]
    assert.throws(() => assertMeasuredWork({ ...good, overview }), /node "bench-remote-1" lists 0 of 3 benchmark stacks/)
  })

  it('fails when a seeded stack is not running', () => {
    const statuses = { ...running(3), 'senchobench-002': { status: 'exited' } }
    assert.throws(() => assertMeasuredWork({ ...good, statuses }), /2 of 3 benchmark stacks report running/)
  })
})

describe('parseArgs', () => {
  it('reads options and keeps the documented defaults for the rest', () => {
    const options = parseArgs(['--stacks', '20', '--baseline', 'b.json', '--floor-ms', '40'])
    assert.equal(options.stacks, 20)
    assert.equal(options.baseline, 'b.json')
    assert.equal(options['floor-ms'], 40)
    const defaults = parseArgs([])
    assert.deepEqual(
      [defaults.stacks, defaults.nodes, defaults.samples, defaults['miss-samples'], defaults.ratio, defaults['floor-ms']],
      [200, 10, 30, 5, 1.5, 25],
    )
  })

  it('feeds --ratio and --floor-ms into the regression rule', () => {
    const baseline = baselineOf({ stacks: { medianMs: 50 } })
    const ratioLimits = limitsFrom(parseArgs(['--ratio', '2']))
    assert.equal(compare({ stacks: stats(99) }, baseline, ratioLimits)[0].status, 'ok')
    assert.equal(compare({ stacks: stats(101) }, baseline, ratioLimits)[0].status, 'regressed')
    // 30 ms slower and over 1.5x: the default 25 ms floor fails it, a 40 ms floor does not.
    assert.equal(compare({ stacks: stats(80) }, baseline, limitsFrom(parseArgs([])))[0].status, 'regressed')
    assert.equal(compare({ stacks: stats(80) }, baseline, limitsFrom(parseArgs(['--floor-ms', '40'])))[0].status, 'ok')
  })

  it('rejects unknown flags, missing values, bad numbers, and out-of-range counts', () => {
    assert.throws(() => parseArgs(['--stack', '20']), /Unknown argument "--stack"/)
    assert.throws(() => parseArgs(['--stacks']), /--stacks needs a value/)
    assert.throws(() => parseArgs(['--stacks', 'many']), /must be a non-negative number/)
    assert.throws(() => parseArgs(['--stacks', '']), /must be a non-negative number/)
    assert.throws(() => parseArgs(['--stacks', '-1']), /must be a non-negative number/)
    assert.throws(() => parseArgs(['--stacks', '2.5']), /must be a whole number/)
    assert.throws(() => parseArgs(['--samples', '0']), /must be at least 1/)
    assert.throws(() => parseArgs(['--miss-samples', '0']), /must be at least 1/)
    assert.throws(() => parseArgs(['--ratio', '0.9']), /--ratio must be at least 1/)
    assert.throws(() => parseArgs(['--stacks', '0']), /must be at least 1/)
    assert.throws(() => parseArgs(['--floor-ms', '-1']), /must be a non-negative number/)
    assert.throws(() => parseArgs(['--stacks', '--nodes', '3']), /--stacks needs a value/)
  })

  it('accepts zero remote nodes, a ratio of exactly 1, and fractional limits', () => {
    const options = parseArgs(['--nodes', '0', '--ratio', '1', '--floor-ms', '12.5'])
    assert.deepEqual([options.nodes, options.ratio, options['floor-ms']], [0, 1, 12.5])
  })
})

describe('lanAddress', () => {
  it('skips loopback, link-local, and IPv6, and returns the first usable IPv4', () => {
    const interfaces = {
      lo: [{ family: 'IPv4', internal: true, address: '127.0.0.1' }],
      eth0: [
        { family: 'IPv6', internal: false, address: 'fe80::1' },
        { family: 'IPv4', internal: false, address: '169.254.10.2' },
        { family: 'IPv4', internal: false, address: '10.1.0.4' },
      ],
    }
    assert.equal(lanAddress(interfaces), '10.1.0.4')
  })

  it('fails clearly when there is no usable address', () => {
    assert.throws(() => lanAddress({ lo: [{ family: 'IPv4', internal: true, address: '127.0.0.1' }] }), /No non-loopback IPv4/)
  })
})

describe('prepareWorkDir', () => {
  const root = mkdtempSync(join(tmpdir(), 'scale-workdir-'))
  after(() => rmSync(root, { recursive: true, force: true }))

  it('creates a new directory and accepts an empty one', () => {
    assert.equal(prepareWorkDir(join(root, 'new')), join(root, 'new'))
    mkdirSync(join(root, 'empty'))
    assert.equal(prepareWorkDir(join(root, 'empty')), join(root, 'empty'))
  })

  it('refuses a directory with leftovers from an earlier run', () => {
    mkdirSync(join(root, 'used'))
    writeFileSync(join(root, 'used', 'backend.log'), 'old')
    assert.throws(() => prepareWorkDir(join(root, 'used')), /is not empty; use a new or empty directory/)
  })

  it('makes a temporary directory when none is given', () => {
    const dir = prepareWorkDir(null)
    assert.match(dir, /sencho-scale-/)
    rmSync(dir, { recursive: true, force: true })
  })
})
