/**
 * Tests for scripts/perf/scale-benchmark.mjs
 *
 * Run:  node --test scripts/perf/scale-benchmark.test.mjs
 *
 * These cover the parts that decide pass or fail (statistics, the regression
 * rule, argument parsing, the remote-node address). The benchmark itself needs
 * Docker and a built backend, and runs in the scheduled scale-benchmark
 * workflow.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { compare, formatTable, lanAddress, parseArgs, percentile, summarize } from './scale-benchmark.mjs'

const LIMITS = { ratio: 1.5, floorMs: 25 }

describe('percentile and summarize', () => {
  it('uses the nearest rank, so the median of an even list is the lower middle value', () => {
    assert.equal(percentile([4, 1, 3, 2], 50), 2)
    assert.equal(percentile([5, 1, 4, 2, 3], 50), 3)
    assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 100], 95), 19)
    assert.equal(percentile([7], 95), 7)
  })

  it('summarizes samples without reordering the caller list', () => {
    const samples = [30.04, 10, 20]
    assert.deepEqual(summarize(samples), { samples: 3, minMs: 10, medianMs: 20, p95Ms: 30, maxMs: 30 })
    assert.deepEqual(samples, [30.04, 10, 20])
  })
})

describe('compare', () => {
  const baseline = { series: { stacks: { medianMs: 100 }, statuses: { medianMs: 4 } } }
  const stats = (medianMs) => ({ samples: 30, minMs: medianMs, medianMs, p95Ms: medianMs, maxMs: medianMs })

  it('flags a series only when it is both over the ratio and over the floor', () => {
    const rows = compare({ stacks: stats(151), statuses: stats(28) }, baseline, LIMITS)
    assert.deepEqual(rows.map((r) => [r.name, r.status, r.baselineMs]), [
      ['stacks', 'regressed', 100],
      ['statuses', 'ok', 4],
    ])
  })

  it('passes at exactly the ratio, and flags a fast endpoint once it is slower by more than the floor', () => {
    assert.equal(compare({ stacks: stats(150) }, baseline, LIMITS)[0].status, 'ok')
    assert.equal(compare({ statuses: stats(30) }, baseline, LIMITS)[0].status, 'regressed')
  })

  it('marks a series the baseline lacks as new, and everything ok without a baseline', () => {
    assert.equal(compare({ fresh: stats(5) }, baseline, LIMITS)[0].status, 'new')
    assert.deepEqual(compare({ stacks: stats(999) }, null, LIMITS).map((r) => [r.status, r.baselineMs]), [['ok', null]])
  })

  it('formats one row per series with the baseline median', () => {
    const table = formatTable(compare({ stacks: stats(120) }, baseline, LIMITS))
    assert.match(table, /\| stacks \| 30 \| 120 \| 120 \| 120 \| 120 \| 100 \| ok \|/)
  })
})

describe('parseArgs', () => {
  it('reads numeric and path options and keeps defaults for the rest', () => {
    const options = parseArgs(['--stacks', '20', '--baseline', 'b.json', '--ratio', '2'])
    assert.equal(options.stacks, 20)
    assert.equal(options.baseline, 'b.json')
    assert.equal(options.ratio, 2)
    assert.equal(options.nodes, 10)
    assert.equal(options.samples, 30)
  })

  it('rejects unknown flags, missing values, bad numbers, and zero samples', () => {
    assert.throws(() => parseArgs(['--stack', '20']), /Unknown argument "--stack"/)
    assert.throws(() => parseArgs(['--stacks']), /--stacks needs a value/)
    assert.throws(() => parseArgs(['--stacks', 'many']), /must be a non-negative number/)
    assert.throws(() => parseArgs(['--samples', '0']), /at least 1/)
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
