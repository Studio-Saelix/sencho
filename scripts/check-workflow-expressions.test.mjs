/**
 * Tests for scripts/check-workflow-expressions.sh
 *
 * Run:  node --test scripts/check-workflow-expressions.test.mjs
 *
 * Each fixture under scripts/fixtures/workflow-expressions is a workflow the guard must
 * accept or reject, and the rejection must name the file and line.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const guard = join(here, 'check-workflow-expressions.sh')
const fixture = (name) => join(here, 'fixtures', 'workflow-expressions', name)
const run = (...paths) => spawnSync('bash', [guard, ...paths], { encoding: 'utf8' })

describe('check-workflow-expressions', () => {
  it('accepts a workflow that uses ${{ }} everywhere', () => {
    const r = run(fixture('good.yml'))
    assert.equal(r.status, 0, r.stdout + r.stderr)
  })

  it('rejects a single-brace expression and names file:line', () => {
    const r = run(fixture('bad-single-brace.yml'))
    assert.equal(r.status, 1)
    assert.match(r.stdout, /bad-single-brace\.yml:7:/)
  })

  it('rejects a build-arg that reads steps. without ${{ }}', () => {
    const r = run(fixture('bad-build-arg.yml'))
    assert.equal(r.status, 1)
    assert.match(r.stderr, /bad-build-arg\.yml:7:/)
  })

  it('does not flag the line after the build-args block', () => {
    const r = run(fixture('bad-build-arg.yml'))
    assert.doesNotMatch(r.stderr, /:8:/)
  })

  it('rejects a "$ {" split and a run of four braces', () => {
    const r = run(fixture('bad-braces.yml'))
    assert.equal(r.status, 1)
    assert.match(r.stdout, /bad-braces\.yml:4:/)
    assert.match(r.stdout, /bad-braces\.yml:5:/)
  })

  it('rejects a build-arg under a |- block and one on the key line', () => {
    for (const name of ['bad-build-arg-chomp.yml', 'bad-build-arg-inline.yml', 'bad-build-arg-quoted.yml']) {
      const r = run(fixture(name))
      assert.equal(r.status, 1, name)
      assert.match(r.stderr, /build-arg reads/, name)
    }
  })

  it('rejects a single-brace function call', () => {
    const r = run(fixture('bad-function.yml'))
    assert.equal(r.status, 1)
    assert.match(r.stdout, /bad-function\.yml:4:/)
  })

  it('fails on a path that does not exist instead of passing on nothing', () => {
    const r = run(fixture('missing.yml'))
    assert.equal(r.status, 2)
    assert.match(r.stderr, /no such path/)
  })

  it('passes on the repository workflows', () => {
    const r = spawnSync('bash', [guard, join(here, '..', '.github')], { encoding: 'utf8' })
    assert.equal(r.status, 0, r.stdout + r.stderr)
  })
})
