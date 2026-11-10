/**
 * Tests for scripts/perf/idle-footprint.mjs
 *
 * Run:  node --test scripts/perf/idle-footprint.test.mjs
 *
 * These cover the parts that decide what is recorded and whether a release
 * grew (docker stats parsing, summaries, the previous-release lookup, the
 * thresholds). The probe itself needs a running instance and a browser, and
 * runs as a release audit step.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  compare, formatTable, parseArgs, parseDockerStats, parseSize, previousRecord, shellQuote, summarizeSamples, topPaths,
} from './idle-footprint.mjs'

describe('parseSize and parseDockerStats', () => {
  it('reads binary and decimal docker stats units', () => {
    assert.equal(parseSize('512KiB'), 512 * 1024)
    assert.equal(parseSize('1.5GiB'), 1.5 * 1024 ** 3)
    assert.equal(parseSize('200MB'), 200e6)
    assert.equal(parseSize('0B'), 0)
    assert.throws(() => parseSize('--'), /Unreadable size/)
  })

  it('takes used memory, not the limit, and CPU as a number', () => {
    const line = JSON.stringify({ MemUsage: '182.3MiB / 11.17GiB', CPUPerc: '2.45%', Name: 'sencho' })
    const stats = parseDockerStats(line)
    assert.ok(Math.abs(stats.memMiB - 182.3) < 1e-9)
    assert.equal(stats.cpuPct, 2.45)
  })
})

describe('summarizeSamples and topPaths', () => {
  it('reports median and max memory and mean and max CPU', () => {
    const summary = summarizeSamples([
      { memMiB: 100, cpuPct: 1 }, { memMiB: 120, cpuPct: 3 }, { memMiB: 110, cpuPct: 2 }, { memMiB: 130, cpuPct: 6 },
    ])
    assert.deepEqual(summary, { samples: 4, memMedianMiB: 115, memMaxMiB: 130, cpuMeanPct: 3, cpuMaxPct: 6 })
  })

  it('lists the most requested paths first', () => {
    const counts = new Map([['/api/stats', 20], ['/api/stacks/statuses', 40], ['/api/meta', 1]])
    assert.deepEqual(topPaths(counts, 2), ['/api/stacks/statuses: 40', '/api/stats: 20'])
  })
})

describe('previousRecord', () => {
  const history = [{ label: '0.98.1' }, { label: '0.98.2' }, { label: '0.98.3' }, { label: '0.98.3' }]

  it('skips earlier runs with the same label and returns the latest other label', () => {
    assert.equal(previousRecord(history, '0.98.3').label, '0.98.2')
  })

  it('returns null when only the current label has been measured', () => {
    assert.equal(previousRecord([{ label: '0.98.3' }], '0.98.3'), null)
    assert.equal(previousRecord([], '0.98.3'), null)
  })
})

describe('compare', () => {
  const previous = { memMedianMiB: 200, requestsPerMinute: 10, cpuMeanPct: 2 }
  const statuses = (current) => compare(current, previous).map((r) => [r.metric, r.status])

  it('flags memory over 20%, requests over 50%, and CPU over 50% and 1 point', () => {
    assert.deepEqual(statuses({ memMedianMiB: 241, requestsPerMinute: 16, cpuMeanPct: 3.1 }), [
      ['memory median MiB', 'grew'], ['requests per minute', 'grew'], ['cpu mean %', 'grew'],
    ])
  })

  it('passes at exactly the thresholds, and ignores a CPU rise under 1 point', () => {
    assert.deepEqual(statuses({ memMedianMiB: 240, requestsPerMinute: 15, cpuMeanPct: 3 }), [
      ['memory median MiB', 'ok'], ['requests per minute', 'ok'], ['cpu mean %', 'ok'],
    ])
    const lowCpu = compare({ memMedianMiB: 1, requestsPerMinute: 1, cpuMeanPct: 0.9 }, { ...previous, cpuMeanPct: 0.2 })
    assert.equal(lowCpu[2].status, 'ok')
  })

  it('reports no baseline when there is no previous release', () => {
    const rows = compare({ memMedianMiB: 999, requestsPerMinute: 99, cpuMeanPct: 99 }, null)
    assert.deepEqual(rows.map((r) => r.status), ['no baseline', 'no baseline', 'no baseline'])
    assert.match(formatTable(rows, undefined), /\| memory median MiB \| 999 \| - \| no baseline \|/)
  })
})

describe('shellQuote', () => {
  it('keeps a docker format template one argument through a remote shell', () => {
    assert.equal(shellQuote('{{json .}}'), "'{{json .}}'")
    assert.equal(shellQuote("it's"), `'it'\\''s'`)
  })
})

describe('parseArgs', () => {
  it('requires the url and history file and keeps defaults for the rest', () => {
    const options = parseArgs(['--url', 'http://h:1852', '--history', 'h.json', '--minutes', '2'])
    assert.equal(options.minutes, 2)
    assert.equal(options.container, 'sencho')
    assert.equal(options.ssh, null)
    assert.equal(options.label, null)
    assert.throws(() => parseArgs(['--history', 'h.json']), /--url is required/)
    assert.throws(() => parseArgs(['--url', 'http://h:1852']), /--history is required/)
  })

  it('rejects unknown flags, missing values, and non-positive numbers', () => {
    assert.throws(() => parseArgs(['--minute', '2']), /Unknown argument "--minute"/)
    assert.throws(() => parseArgs(['--url']), /--url needs a value/)
    assert.throws(() => parseArgs(['--url', 'u', '--history', 'h', '--minutes', '0']), /positive number/)
  })
})
