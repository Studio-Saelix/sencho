/**
 * Tests for scripts/perf/scale-benchmark.mjs
 *
 * Run:  node --test scripts/perf/scale-benchmark.test.mjs
 *
 * These cover the parts that decide pass or fail (statistics, the regression
 * rule, baseline validation, the checks that the run measured real work,
 * argument parsing, the remote-node address). The benchmark itself needs
 * Docker and a built backend, and runs in the scale-benchmark workflow.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  assertMeasuredWork, assertSameScale, compare, failures, formatTable, lanAddress, parseArgs, parseBaseline,
  percentile, statusOutcomes, summarize,
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
  })

  it('refuses to compare a run at a different scale', () => {
    const baseline = parseBaseline(valid)
    assert.doesNotThrow(() => assertSameScale(baseline, { stacks: 200, nodes: 10 }))
    assert.throws(() => assertSameScale(baseline, { stacks: 60, nodes: 10 }), /taken at 200 stacks and 10 remote nodes; this run uses 60 and 10/)
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
    const options = parseArgs(['--ratio', '2', '--floor-ms', '40'])
    const limits = { ratio: options.ratio, floorMs: options['floor-ms'] }
    const baseline = baselineOf({ stacks: { medianMs: 50 } })
    assert.equal(compare({ stacks: stats(99) }, baseline, limits)[0].status, 'ok')
    assert.equal(compare({ stacks: stats(101) }, baseline, limits)[0].status, 'regressed')
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
