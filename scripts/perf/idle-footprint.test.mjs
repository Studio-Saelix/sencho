/**
 * Tests for scripts/perf/idle-footprint.mjs
 *
 * Run:  node --test scripts/perf/idle-footprint.test.mjs
 *
 * These cover the parts that decide what is recorded and whether a release
 * grew: docker stats parsing, the record and its validity checks, API path
 * counting, the instance check, the comparison record lookup, the thresholds,
 * the exit code, and argument parsing. The probe itself needs a running
 * instance and a browser, so it is not run in CI; the release audit runs it.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  MIN_SAMPLES, apiPath, assertSameInstance, buildRecord, compare, exitCode, formatTable, parseArgs, parseDockerStats,
  parseSize, previousRecord, shellQuote, summarizeSamples, topPaths,
} from './idle-footprint.mjs'

describe('parseSize and parseDockerStats', () => {
  it('reads binary and decimal docker stats units, in any case', () => {
    assert.equal(parseSize('512KiB'), 512 * 1024)
    assert.equal(parseSize('1.5GiB'), 1.5 * 1024 ** 3)
    assert.equal(parseSize('200MB'), 200e6)
    assert.equal(parseSize('3kB'), 3e3)
    assert.equal(parseSize('0B'), 0)
  })

  it('rejects sizes it cannot read', () => {
    for (const text of ['--', '1.2.3MiB', 'MiB', '']) assert.throws(() => parseSize(text), /Unreadable size/, text)
  })

  it('takes used memory, not the limit, and CPU as a number', () => {
    const line = JSON.stringify({ MemUsage: '182.3MiB / 11.17GiB', CPUPerc: '2.45%', Name: 'sencho' })
    const stats = parseDockerStats(line)
    assert.ok(Math.abs(stats.memMiB - 182.3) < 1e-9)
    assert.equal(stats.cpuPct, 2.45)
  })

  it('accepts an idle container at 0% CPU', () => {
    assert.equal(parseDockerStats(JSON.stringify({ MemUsage: '90MiB / 1GiB', CPUPerc: '0.00%' })).cpuPct, 0)
  })

  it('names the container when docker stats prints nothing', () => {
    assert.throws(() => parseDockerStats(''), /printed nothing; is the container name right/)
  })

  it('rejects the zero memory and dashes of a stopped container', () => {
    assert.throws(() => parseDockerStats(JSON.stringify({ MemUsage: '0B / 0B', CPUPerc: '0.00%' })), /is the container running/)
    assert.throws(() => parseDockerStats(JSON.stringify({ MemUsage: '100MiB / 1GiB', CPUPerc: '--' })), /is the container running/)
  })
})

describe('summarizeSamples, apiPath, and topPaths', () => {
  it('reports median and max memory and mean and max CPU, for odd and even counts', () => {
    const even = summarizeSamples([
      { memMiB: 100, cpuPct: 1 }, { memMiB: 120, cpuPct: 3 }, { memMiB: 110, cpuPct: 2 }, { memMiB: 130, cpuPct: 6 },
    ])
    assert.deepEqual(even, { samples: 4, memMedianMiB: 115, memMaxMiB: 130, cpuMeanPct: 3, cpuMaxPct: 6 })
    const odd = summarizeSamples([{ memMiB: 105.25, cpuPct: 0.1 }, { memMiB: 101, cpuPct: 0.2 }, { memMiB: 99, cpuPct: 0.25 }])
    assert.deepEqual(odd, { samples: 3, memMedianMiB: 101, memMaxMiB: 105.3, cpuMeanPct: 0.2, cpuMaxPct: 0.3 })
  })

  it('counts API calls under one path per endpoint, behind a base path too, and ignores the rest', () => {
    assert.equal(apiPath('http://h:1852/api/stacks/statuses?x=1'), '/api/stacks/statuses')
    assert.equal(apiPath('http://h/sencho/api/nodes/12/stats'), '/api/nodes/:id/stats')
    assert.equal(apiPath('http://h/api/containers/4f3a9c1b2d7e8f90/logs'), '/api/containers/:id/logs')
    assert.equal(apiPath('http://h/assets/index-Ab12Cd34.js'), null)
  })

  it('lists the most requested paths first, eight by default', () => {
    const counts = new Map(Array.from({ length: 10 }, (_, i) => [`/api/p${i}`, i]))
    assert.deepEqual(topPaths(counts, 2), ['/api/p9: 9', '/api/p8: 8'])
    assert.equal(topPaths(counts).length, 8)
  })
})

describe('buildRecord', () => {
  const samples = Array.from({ length: MIN_SAMPLES }, () => ({ memMiB: 100, cpuPct: 1 }))
  const traffic = {
    total: 60, failed: 1, authFailures: 0, websocketOpens: 2, websocketFrames: 30, counts: new Map([['/api/stats', 60]]),
  }
  const input = {
    label: null, version: '0.98.2', image: 'saelix/sencho:latest', imageId: 'sha256:abc', url: 'http://h:1852',
    host: 'ops@h', elapsedMs: 120_000, samples, traffic,
  }

  it('defaults the label to the reported version and rates traffic over the measured time', () => {
    const record = buildRecord(input)
    assert.equal(record.label, '0.98.2')
    assert.deepEqual([record.url, record.host, record.topPaths], ['http://h:1852', 'ops@h', ['/api/stats: 60']])
    assert.ok(!Number.isNaN(Date.parse(record.date)))
    assert.equal(record.minutes, 2)
    assert.equal(record.requestsPerMinute, 30)
    assert.equal(record.websocketFramesPerMinute, 15)
    assert.deepEqual([record.failedRequests, record.websocketOpens, record.imageId], [1, 2, 'sha256:abc'])
    assert.equal(buildRecord({ ...input, label: '0.99.0' }).label, '0.99.0')
  })

  it('refuses a run with too few samples, a lost session, no API traffic, or too many failures', () => {
    assert.throws(() => buildRecord({ ...input, samples: samples.slice(1) }), /need at least 5/)
    assert.throws(() => buildRecord({ ...input, traffic: { ...traffic, authFailures: 1 } }), /1 \/api responses were 401 or 403/)
    assert.throws(() => buildRecord({ ...input, traffic: { ...traffic, total: 0 } }), /not showing the Dashboard/)
    assert.throws(() => buildRecord({ ...input, traffic: { ...traffic, failed: 7 } }), /7 of 60 \/api requests failed/)
    assert.doesNotThrow(() => buildRecord({ ...input, traffic: { ...traffic, failed: 6 } }))
  })
})

describe('assertSameInstance', () => {
  const state = (startedAt, hostPorts = [1852]) => ({ startedAt, hostPorts })
  const url = 'http://h:1852'

  it('accepts the process starting a moment after its container, as epoch ms or ISO', () => {
    assert.doesNotThrow(() => assertSameInstance({ startedAt: Date.parse('2026-11-09T10:00:02Z') }, state('2026-11-09T10:00:00.5Z'), url))
    assert.doesNotThrow(() => assertSameInstance({ startedAt: '2026-11-09T10:00:01Z' }, state('2026-11-09T10:00:00Z', []), url))
  })

  it('rejects a start time from another instance, or none at all', () => {
    assert.throws(() => assertSameInstance({ startedAt: '2026-11-09T10:01:00Z' }, state('2026-11-09T10:00:00Z'), url), /different instance/)
    assert.throws(() => assertSameInstance({}, state('2026-11-09T10:00:00Z'), url), /different instance/)
  })

  it('rejects a container that does not publish the URL port', () => {
    const sameStart = { startedAt: '2026-11-09T10:00:01Z' }
    assert.throws(() => assertSameInstance(sameStart, state('2026-11-09T10:00:00Z', [1853]), url), /publishes ports 1853, not 1852/)
    assert.throws(() => assertSameInstance(sameStart, state('2026-11-09T10:00:00Z', [8080]), 'https://h'), /not 443/)
  })
})

describe('previousRecord', () => {
  const history = [{ label: '0.98.1' }, { label: '0.98.2' }, { label: '0.98.3' }, { label: '0.98.3' }]

  it('skips earlier runs with the same label and returns the latest other label', () => {
    assert.equal(previousRecord(history, '0.98.3').label, '0.98.2')
  })

  it('uses the named baseline label when given, and fails when it is not in the history', () => {
    assert.equal(previousRecord(history, '0.98.3', '0.98.1').label, '0.98.1')
    assert.throws(() => previousRecord(history, '0.98.3', '0.97.0'), /No record labelled "0.97.0"/)
  })

  it('returns null when only the current label has been measured', () => {
    assert.equal(previousRecord([{ label: '0.98.3' }], '0.98.3'), null)
    assert.equal(previousRecord([], '0.98.3'), null)
  })
})

describe('compare and exitCode', () => {
  const previous = { memMedianMiB: 200, requestsPerMinute: 10, cpuMeanPct: 2 }
  const at = (current, before = previous) => compare(current, before).map((r) => r.status)
  const base = { memMedianMiB: 200, requestsPerMinute: 10, cpuMeanPct: 2 }

  it('flags memory over 20% and requests over 50%, and passes at exactly the threshold', () => {
    assert.deepEqual(at({ ...base, memMedianMiB: 241 }), ['grew', 'ok', 'ok'])
    assert.deepEqual(at({ ...base, memMedianMiB: 240 }), ['ok', 'ok', 'ok'])
    assert.deepEqual(at({ ...base, requestsPerMinute: 16 }), ['ok', 'grew', 'ok'])
    assert.deepEqual(at({ ...base, requestsPerMinute: 15 }), ['ok', 'ok', 'ok'])
  })

  it('reports CPU as higher only when it is over both 50% and 1 point', () => {
    assert.equal(at({ ...base, cpuMeanPct: 3.1 })[2], 'higher')
    // Exactly 50% higher and well over 1 point: not more than 50%.
    assert.equal(at({ ...base, cpuMeanPct: 30 }, { ...previous, cpuMeanPct: 20 })[2], 'ok')
    // Over 1 point but not over 50%: a busy host moving from 20% to 25%.
    assert.equal(at({ ...base, cpuMeanPct: 25 }, { ...previous, cpuMeanPct: 20 })[2], 'ok')
    // Over 50% but not over 1 point: 0.2% to 0.9%.
    assert.equal(at({ ...base, cpuMeanPct: 0.9 }, { ...previous, cpuMeanPct: 0.2 })[2], 'ok')
    // Over 50% and exactly 1 point: not more than 1 point.
    assert.equal(at({ ...base, cpuMeanPct: 2 }, { ...previous, cpuMeanPct: 1 })[2], 'ok')
  })

  it('reports no baseline for a missing previous record, a missing field, or a zero value', () => {
    assert.deepEqual(at({ memMedianMiB: 999, requestsPerMinute: 99, cpuMeanPct: 99 }, null), ['no baseline', 'no baseline', 'no baseline'])
    assert.deepEqual(at(base, { memMedianMiB: 200, requestsPerMinute: 0 }), ['ok', 'no baseline', 'no baseline'])
    assert.deepEqual(at(base, { memMedianMiB: '200', requestsPerMinute: NaN, cpuMeanPct: null }), ['no baseline', 'no baseline', 'no baseline'])
  })

  it('applies every limit passed in', () => {
    const defaults = { memoryRatio: 1.2, requestsRatio: 1.5, cpuRatio: 1.5, cpuFloorPoints: 1 }
    const before = { ...previous, cpuMeanPct: 4 }
    const grown = { memMedianMiB: 230, requestsPerMinute: 13, cpuMeanPct: 5.5 }
    assert.deepEqual(compare(grown, before, defaults).map((r) => r.status), ['ok', 'ok', 'ok'])
    const strict = (override) => compare(grown, before, { ...defaults, ...override }).map((r) => r.status)
    assert.deepEqual(strict({ memoryRatio: 1.1 }), ['grew', 'ok', 'ok'])
    assert.deepEqual(strict({ requestsRatio: 1.2 }), ['ok', 'grew', 'ok'])
    assert.deepEqual(strict({ cpuRatio: 1.2 }), ['ok', 'ok', 'higher'])
    assert.deepEqual(strict({ cpuRatio: 1.2, cpuFloorPoints: 2 }), ['ok', 'ok', 'ok'])
  })

  it('exits 1 only when memory or requests grew, not for higher CPU', () => {
    assert.equal(exitCode(compare({ ...base, memMedianMiB: 241 }, previous)), 1)
    assert.equal(exitCode(compare({ ...base, requestsPerMinute: 16 }, previous)), 1)
    assert.equal(exitCode(compare({ ...base, cpuMeanPct: 9 }, previous)), 0)
    assert.equal(exitCode(compare(base, previous)), 0)
    assert.equal(exitCode(compare(base, null)), 0)
  })

  it('formats the previous label as the column and each status', () => {
    const table = formatTable(compare({ ...base, memMedianMiB: 241 }, previous), '0.98.2')
    assert.match(table, /^\| Metric \| Now \| 0\.98\.2 \| Status \|/)
    assert.match(table, /\| memory median MiB \| 241 \| 200 \| grew \|/)
    assert.match(table, /\| requests per minute \| 10 \| 10 \| ok \|/)
    const noBaseline = formatTable(compare(base, null))
    assert.match(noBaseline, /^\| Metric \| Now \| Previous \| Status \|/)
    assert.match(noBaseline, /\| memory median MiB \| 200 \| - \| no baseline \|/)
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
    const options = parseArgs(['--url', 'http://h:1852', '--history', 'h.json', '--minutes', '3'])
    assert.equal(options.minutes, 3)
    assert.equal(options.container, 'sencho')
    assert.equal(options.ssh, null)
    assert.equal(options.label, null)
    assert.equal(options['baseline-label'], null)
    assert.throws(() => parseArgs(['--history', 'h.json']), /--url is required/)
    assert.throws(() => parseArgs(['--url', 'http://h:1852']), /--history is required/)
  })

  it('rejects unknown flags, missing values, and non-positive or unreadable numbers', () => {
    const required = ['--url', 'u', '--history', 'h']
    assert.throws(() => parseArgs(['--minute', '2']), /Unknown argument "--minute"/)
    assert.throws(() => parseArgs(['--url']), /--url needs a value/)
    assert.throws(() => parseArgs(['--url', '--history', 'x']), /--url needs a value/)
    assert.throws(() => parseArgs([...required, '--minutes', '0']), /positive number/)
    assert.throws(() => parseArgs([...required, '--minutes', 'abc']), /positive number/)
    assert.throws(() => parseArgs([...required, '--minutes', '']), /--minutes needs a value/)
    for (const flag of ['--minutes', '--settle-seconds', '--sample-seconds']) {
      assert.throws(() => parseArgs([...required, flag, 'Infinity']), /positive number/, flag)
      assert.throws(() => parseArgs([...required, flag, '-1']), /positive number/, flag)
    }
    assert.throws(() => parseArgs([...required, '--ssh', '']), /--ssh needs a value/)
  })

  it('rejects a window too short for the minimum number of samples', () => {
    const required = ['--url', 'u', '--history', 'h']
    assert.throws(() => parseArgs([...required, '--minutes', '1']), /gives 2 samples; need at least 5/)
    assert.doesNotThrow(() => parseArgs([...required, '--minutes', '1', '--sample-seconds', '12']))
  })

  it('rejects a container name or ssh target that would be read as an option', () => {
    const required = ['--url', 'u', '--history', 'h']
    assert.throws(() => parseArgs([...required, '--container', '-a']), /is not a container name/)
    assert.throws(() => parseArgs([...required, '--container', 'a;b']), /is not a container name/)
    assert.throws(() => parseArgs([...required, '--ssh', '-oProxyCommand=x']), /must be a host/)
    assert.equal(parseArgs([...required, '--container', 'sencho-agent', '--ssh', 'ops@h']).container, 'sencho-agent')
  })
})
