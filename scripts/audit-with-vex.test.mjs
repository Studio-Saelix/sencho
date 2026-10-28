/**
 * Tests for scripts/audit-with-vex.mjs
 *
 * Run:  node --test scripts/audit-with-vex.test.mjs
 *
 * All fixtures are inline objects. The test imports pure functions; main() is
 * never invoked because the CLI guard fires only when the file runs directly.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  parsePurl,
  gateLevelsFromThreshold,
  statementCoversPackage,
  statementCoversAdvisory,
  evaluateAudit,
} from './audit-with-vex.mjs'

const BRACES_ADVISORY = 'https://github.com/advisories/GHSA-vfj7-8cjw-p6xm'

function bracesReport() {
  return {
    auditReportVersion: 2,
    vulnerabilities: {
      braces: {
        name: 'braces',
        severity: 'high',
        via: [{
          source: 1240992,
          name: 'braces',
          dependency: 'braces',
          title: 'braces vulnerable to stack-exhaustion denial of service through deeply nested patterns',
          url: BRACES_ADVISORY,
          severity: 'high',
          range: '<=3.0.3',
        }],
        effects: ['chokidar', 'micromatch'],
        range: '*',
        nodes: ['node_modules/braces'],
        fixAvailable: false,
      },
      chokidar: { name: 'chokidar', severity: 'high', via: ['braces'], nodes: ['node_modules/chokidar'] },
      micromatch: { name: 'micromatch', severity: 'high', via: ['braces'], nodes: ['node_modules/micromatch'] },
      nodemon: { name: 'nodemon', severity: 'high', via: ['chokidar'], nodes: ['node_modules/nodemon'] },
      'http-proxy-middleware': { name: 'http-proxy-middleware', severity: 'high', via: ['micromatch'], nodes: ['node_modules/http-proxy-middleware'] },
    },
    metadata: { vulnerabilities: { high: 5, critical: 0, total: 5 } },
  }
}

const BRACES_LOCK = {
  lockfileVersion: 3,
  packages: {
    'node_modules/braces': { version: '3.0.3' },
    'node_modules/chokidar': { version: '3.6.0' },
    'node_modules/micromatch': { version: '4.0.8' },
    'node_modules/nodemon': { version: '3.1.13' },
    'node_modules/http-proxy-middleware': { version: '4.2.0' },
  },
}

function bracesStatement(overrides = {}) {
  return {
    vulnerability: {
      '@id': BRACES_ADVISORY,
      name: 'CVE-2026-93687',
      description: 'braces is vulnerable to stack-exhaustion denial of service (GHSA-vfj7-8cjw-p6xm)',
    },
    products: [{ '@id': 'pkg:npm/braces@3.0.3' }],
    status: 'not_affected',
    justification: 'vulnerable_code_cannot_be_controlled_by_adversary',
    ...overrides,
  }
}

describe('parsePurl', () => {
  it('reads an unscoped npm purl', () => {
    assert.deepEqual(parsePurl('pkg:npm/braces@3.0.3'), { type: 'npm', name: 'braces', version: '3.0.3' })
  })

  it('decodes a scoped npm purl', () => {
    assert.deepEqual(parsePurl('pkg:npm/%40scope/name@1.2.3'), { type: 'npm', name: '@scope/name', version: '1.2.3' })
  })

  it('treats a missing version as null', () => {
    assert.deepEqual(parsePurl('pkg:npm/braces'), { type: 'npm', name: 'braces', version: null })
  })

  it('strips qualifiers and subpath', () => {
    assert.deepEqual(parsePurl('pkg:golang/github.com/docker/docker@v28.5.2+incompatible?foo=bar#sub'), {
      type: 'golang',
      name: 'github.com/docker/docker',
      version: 'v28.5.2+incompatible',
    })
  })

  it('rejects non-purl input', () => {
    assert.equal(parsePurl('braces@3.0.3'), null)
    assert.equal(parsePurl(undefined), null)
  })

  it('treats a trailing @ as no version', () => {
    assert.deepEqual(parsePurl('pkg:npm/foo@'), { type: 'npm', name: 'foo', version: null })
  })
})

describe('gateLevelsFromThreshold', () => {
  it('treats high as high plus critical', () => {
    assert.deepEqual(gateLevelsFromThreshold('high'), ['high', 'critical'])
  })

  it('rejects an unknown level', () => {
    assert.throws(() => gateLevelsFromThreshold('severe'))
  })
})

describe('statement matching', () => {
  it('matches a package by exact version and by unversioned purl', () => {
    assert.equal(statementCoversPackage(bracesStatement(), 'braces', new Set(['3.0.3'])), true)
    const unversioned = bracesStatement({ products: [{ '@id': 'pkg:npm/braces' }] })
    assert.equal(statementCoversPackage(unversioned, 'braces', new Set(['9.9.9'])), true)
  })

  it('does not match a different version', () => {
    assert.equal(statementCoversPackage(bracesStatement(), 'braces', new Set(['3.0.2'])), false)
  })

  it('matches a subcomponent purl', () => {
    const statement = bracesStatement({ products: [{ '@id': 'pkg:oci/sencho', subcomponents: [{ '@id': 'pkg:npm/braces@3.0.3' }] }] })
    assert.equal(statementCoversPackage(statement, 'braces', new Set(['3.0.3'])), true)
  })

  it('matches an advisory by the GHSA in the statement @id', () => {
    assert.equal(statementCoversAdvisory(bracesStatement(), new Set([BRACES_ADVISORY, 'GHSA-vfj7-8cjw-p6xm'])), true)
  })

  it('ignores a statement that is not not_affected', () => {
    assert.equal(statementCoversAdvisory(bracesStatement({ status: 'affected' }), new Set([BRACES_ADVISORY])), false)
  })
})

describe('evaluateAudit', () => {
  it('suppresses the advisory and every dependent package', () => {
    const { failures, suppressed } = evaluateAudit(
      bracesReport(),
      { statements: [bracesStatement()] },
      BRACES_LOCK,
      gateLevelsFromThreshold('high'),
    )
    assert.deepEqual(failures, [])
    assert.deepEqual(
      suppressed.sort(),
      ['braces', 'chokidar', 'http-proxy-middleware', 'micromatch', 'nodemon'],
    )
  })

  it('fails every package when there is no statement', () => {
    const { failures } = evaluateAudit(
      bracesReport(),
      { statements: [] },
      BRACES_LOCK,
      gateLevelsFromThreshold('high'),
    )
    assert.equal(failures.length, 5)
    assert.ok(failures.some(failure => failure.name === 'braces' && failure.versions.includes('3.0.3')))
  })

  it('does not suppress a version the statement does not cover', () => {
    const statement = bracesStatement({ products: [{ '@id': 'pkg:npm/braces@3.0.2' }] })
    const { failures } = evaluateAudit(
      bracesReport(),
      { statements: [statement] },
      BRACES_LOCK,
      gateLevelsFromThreshold('high'),
    )
    assert.ok(failures.some(failure => failure.name === 'braces'))
    assert.ok(failures.some(failure => failure.name === 'nodemon'))
  })

  it('ignores advisories below the gate level', () => {
    const report = {
      vulnerabilities: {
        leftpad: {
          name: 'leftpad',
          severity: 'moderate',
          via: [{ url: 'https://github.com/advisories/GHSA-aaaa-bbbb-cccc', severity: 'moderate' }],
          nodes: ['node_modules/leftpad'],
        },
      },
    }
    const { failures, suppressed, belowGate } = evaluateAudit(report, { statements: [] }, { packages: { 'node_modules/leftpad': { version: '1.0.0' } } }, gateLevelsFromThreshold('high'))
    assert.deepEqual(failures, [])
    assert.deepEqual(suppressed, [])
    assert.deepEqual(belowGate, ['leftpad'])
  })

  it('fails a critical advisory without a statement', () => {
    const report = {
      vulnerabilities: {
        openssl: {
          name: 'openssl',
          severity: 'critical',
          via: [{ url: 'https://github.com/advisories/GHSA-dddd-eeee-ffff', severity: 'critical' }],
          nodes: ['node_modules/openssl'],
        },
      },
    }
    const { failures } = evaluateAudit(report, { statements: [] }, { packages: { 'node_modules/openssl': { version: '1.0.0' } } }, gateLevelsFromThreshold('high'))
    assert.equal(failures.length, 1)
    assert.equal(failures[0].severity, 'critical')
  })

  it('fails closed when the lockfile has no version for the node path', () => {
    const { failures } = evaluateAudit(
      bracesReport(),
      { statements: [bracesStatement()] },
      { packages: {} },
      gateLevelsFromThreshold('high'),
    )
    assert.ok(failures.some(failure => failure.name === 'braces'))
  })

  it('matches a scoped npm package', () => {
    const report = {
      vulnerabilities: {
        '@scope/pkg': {
          name: '@scope/pkg',
          severity: 'high',
          via: [{ url: 'https://github.com/advisories/GHSA-zzzz-yyyy-xxxx', severity: 'high' }],
          nodes: ['node_modules/@scope/pkg'],
        },
      },
    }
    const statement = {
      vulnerability: { name: 'CVE-2026-00001', '@id': 'https://github.com/advisories/GHSA-zzzz-yyyy-xxxx' },
      products: [{ '@id': 'pkg:npm/%40scope/pkg@2.0.0' }],
      status: 'not_affected',
    }
    const { failures, suppressed } = evaluateAudit(
      report,
      { statements: [statement] },
      { packages: { 'node_modules/@scope/pkg': { version: '2.0.0' } } },
      gateLevelsFromThreshold('high'),
    )
    assert.deepEqual(failures, [])
    assert.deepEqual(suppressed, ['@scope/pkg'])
  })

  it('fails when one of several advisories is uncovered', () => {
    const report = {
      vulnerabilities: {
        pkg: {
          name: 'pkg',
          severity: 'high',
          via: [
            { url: 'https://github.com/advisories/GHSA-1111-2222-3333', severity: 'high' },
            { url: 'https://github.com/advisories/GHSA-4444-5555-6666', severity: 'high' },
          ],
          nodes: ['node_modules/pkg'],
        },
      },
    }
    const statement = {
      vulnerability: { name: 'CVE-2026-00002', '@id': 'https://github.com/advisories/GHSA-1111-2222-3333' },
      products: [{ '@id': 'pkg:npm/pkg@1.0.0' }],
      status: 'not_affected',
    }
    const { failures } = evaluateAudit(
      report,
      { statements: [statement] },
      { packages: { 'node_modules/pkg': { version: '1.0.0' } } },
      gateLevelsFromThreshold('high'),
    )
    assert.equal(failures.length, 1)
    assert.equal(failures[0].name, 'pkg')
  })

  it('passes an empty report', () => {
    const { failures, suppressed, belowGate } = evaluateAudit(
      { vulnerabilities: {} },
      { statements: [] },
      { packages: {} },
      gateLevelsFromThreshold('high'),
    )
    assert.deepEqual(failures, [])
    assert.deepEqual(suppressed, [])
    assert.deepEqual(belowGate, [])
  })

  it('propagates suppression through a chain deeper than two', () => {
    const report = {
      vulnerabilities: {
        root: { name: 'root', severity: 'high', via: [{ url: 'https://github.com/advisories/GHSA-aaaa-1111-bbbb', severity: 'high' }], nodes: ['node_modules/root'] },
        mid: { name: 'mid', severity: 'high', via: ['root'], nodes: ['node_modules/mid'] },
        leaf: { name: 'leaf', severity: 'high', via: ['mid'], nodes: ['node_modules/leaf'] },
      },
    }
    const statement = {
      vulnerability: { name: 'CVE-2026-00003', '@id': 'https://github.com/advisories/GHSA-aaaa-1111-bbbb' },
      products: [{ '@id': 'pkg:npm/root@1.0.0' }],
      status: 'not_affected',
    }
    const { failures } = evaluateAudit(
      report,
      { statements: [statement] },
      {
        packages: {
          'node_modules/root': { version: '1.0.0' },
          'node_modules/mid': { version: '1.0.0' },
          'node_modules/leaf': { version: '1.0.0' },
        },
      },
      gateLevelsFromThreshold('high'),
    )
    assert.deepEqual(failures, [])
  })
})
