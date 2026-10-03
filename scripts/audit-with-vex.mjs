#!/usr/bin/env node
/**
 * Dependency audit gate that honors the OpenVEX triage document.
 *
 * `npm audit --audit-level=high` fails on every high or critical advisory,
 * including ones with no patched release that triage already accepted in
 * security/vex/sencho.openvex.json. This script runs the same audit and fails
 * only on advisories the VEX document does not cover, so one not_affected
 * statement suppresses both the Trivy image scan and this gate.
 *
 * Matching rules:
 * - npm reports advisories by GHSA URL, never by CVE. A statement covers an
 *   advisory when its vulnerability name or @id equals the URL or the GHSA id
 *   from it. Trivy matches the same statement by the CVE in `name`, so a
 *   statement carries the CVE in `name` and the GHSA URL in `@id`.
 * - A statement covers a package when one of its product or subcomponent
 *   purls is pkg:npm/<name> with no version or with the installed version.
 * - npm marks a package that is vulnerable only through a dependency with a
 *   string entry in `via`; it is suppressed when every dependency it points
 *   at is suppressed.
 *
 * Run:  node scripts/audit-with-vex.mjs [--dir backend] [--vex <path>] [--audit-level high]
 *
 * Tests: node --test scripts/audit-with-vex.test.mjs
 */

import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const DEFAULT_VEX = join(HERE, '..', 'security', 'vex', 'sencho.openvex.json')
const SEVERITY_ORDER = ['info', 'low', 'moderate', 'high', 'critical']

/** Severities at or above `threshold`; npm audit --audit-level semantics. */
export function gateLevelsFromThreshold(threshold) {
  const index = SEVERITY_ORDER.indexOf(threshold)
  if (index === -1) {
    throw new Error(`unknown audit level "${threshold}" (expected one of ${SEVERITY_ORDER.join(', ')})`)
  }
  return SEVERITY_ORDER.slice(index)
}

/** Split a purl into type, decoded name, and version (null when absent). */
export function parsePurl(purl) {
  if (typeof purl !== 'string' || !purl.startsWith('pkg:')) return null
  const rest = purl.slice(4).split('#')[0].split('?')[0]
  const slash = rest.indexOf('/')
  if (slash <= 0) return null
  const type = rest.slice(0, slash)
  let name = rest.slice(slash + 1)
  let version = null
  const at = name.lastIndexOf('@')
  if (at > 0) {
    const rawVersion = name.slice(at + 1)
    version = rawVersion === '' ? null : rawVersion
    name = name.slice(0, at)
  }
  try {
    name = decodeURIComponent(name)
  } catch {
    // Keep the raw segment when it is not valid percent-encoding.
  }
  return { type, name, version }
}

/** Every product and subcomponent purl in a VEX statement. */
export function statementPurls(statement) {
  const purls = []
  for (const product of statement?.products ?? []) {
    if (product?.['@id']) purls.push(product['@id'])
    for (const subcomponent of product?.subcomponents ?? []) {
      if (subcomponent?.['@id']) purls.push(subcomponent['@id'])
    }
  }
  return purls
}

/** Identifiers a statement answers to: name, @id, and the GHSA id inside @id. */
export function statementAdvisoryIds(statement) {
  const ids = new Set()
  const vulnerability = statement?.vulnerability ?? {}
  for (const value of [vulnerability.name, vulnerability['@id']]) {
    if (typeof value !== 'string') continue
    ids.add(value)
    const ghsa = /(GHSA-[a-z0-9-]+)/i.exec(value)?.[1]
    if (ghsa) ids.add(ghsa)
  }
  return ids
}

/** Identifiers npm gives for one `via` advisory object. */
export function advisoryIdsFromVia(viaEntry) {
  const ids = new Set()
  if (typeof viaEntry === 'string' || !viaEntry) return ids
  if (typeof viaEntry.url === 'string') {
    ids.add(viaEntry.url)
    const ghsa = /(GHSA-[a-z0-9-]+)/i.exec(viaEntry.url)?.[1]
    if (ghsa) ids.add(ghsa)
  }
  return ids
}

/** True when the statement is not_affected and names one of the advisory ids. */
export function statementCoversAdvisory(statement, advisoryIds) {
  if (statement?.status !== 'not_affected') return false
  const statementIds = statementAdvisoryIds(statement)
  for (const id of advisoryIds) {
    if (statementIds.has(id)) return true
  }
  return false
}

/** True when a statement product purl is pkg:npm/<name> at a matching version. */
export function statementCoversPackage(statement, packageName, versions) {
  for (const purl of statementPurls(statement)) {
    const parsed = parsePurl(purl)
    if (!parsed || parsed.type !== 'npm' || parsed.name !== packageName) continue
    if (parsed.version === null || versions.has(parsed.version)) return true
  }
  return false
}

/** Installed versions for the lockfile node paths npm reports. */
export function installedVersions(lock, nodePaths) {
  const versions = new Set()
  for (const nodePath of nodePaths ?? []) {
    const version = lock?.packages?.[nodePath]?.version
    if (version) versions.add(version)
  }
  return versions
}

/**
 * Compare an `npm audit --json` report against the VEX document. Returns the
 * packages at or above the gate that no statement covers, plus the suppressed
 * names for the success line. Suppression propagates through npm's `via`
 * chains, so covering the root advisory clears every dependent package.
 */
export function evaluateAudit(report, vex, lock, gateLevels) {
  const levels = new Set(gateLevels)
  const statements = vex?.statements ?? []
  const vulnerabilities = report?.vulnerabilities ?? {}

  const packages = new Map()
  for (const [name, entry] of Object.entries(vulnerabilities)) {
    const advisories = []
    const dependencies = []
    for (const via of entry.via ?? []) {
      if (typeof via === 'string') {
        dependencies.push(via)
        continue
      }
      if (!levels.has(via?.severity)) continue
      advisories.push({ severity: via.severity, url: via?.url ?? '', ids: advisoryIdsFromVia(via) })
    }
    packages.set(name, {
      severity: entry.severity,
      versions: installedVersions(lock, entry.nodes),
      advisories,
      dependencies,
    })
  }

  const suppressed = new Set()
  const belowGate = new Set()
  let changed = true
  while (changed) {
    changed = false
    for (const [name, info] of packages) {
      if (suppressed.has(name) || belowGate.has(name)) continue
      if (!levels.has(info.severity)) {
        belowGate.add(name)
        changed = true
        continue
      }
      // A gated package with no advisory or dependency evidence cannot be
      // cleared by any statement; leave it for the final loop to fail on.
      if (info.advisories.length === 0 && info.dependencies.length === 0) continue
      const advisoriesCovered = info.advisories.every(advisory =>
        statements.some(statement =>
          statementCoversAdvisory(statement, advisory.ids)
          && statementCoversPackage(statement, name, info.versions)))
      const dependenciesCovered = info.dependencies.every(dependency =>
        suppressed.has(dependency) || belowGate.has(dependency))
      if (advisoriesCovered && dependenciesCovered) {
        suppressed.add(name)
        changed = true
      }
    }
  }

  const failures = []
  for (const [name, info] of packages) {
    if (!levels.has(info.severity) || suppressed.has(name)) continue
    failures.push({
      name,
      severity: info.severity,
      versions: [...info.versions],
      advisories: info.advisories,
      dependencies: info.dependencies,
    })
  }
  return { failures, suppressed: [...suppressed], belowGate: [...belowGate] }
}

function runNpmAudit(dir) {
  const result = spawnSync('npm', ['audit', '--json'], {
    cwd: dir,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  if (result.error) {
    throw new Error(`failed to run npm audit: ${result.error.message}`)
  }
  const stdout = (result.stdout ?? '').trim()
  if (!stdout) {
    throw new Error(`npm audit produced no output (exit ${result.status}): ${(result.stderr ?? '').trim()}`)
  }
  try {
    return JSON.parse(stdout)
  } catch {
    throw new Error(`npm audit did not return JSON (exit ${result.status}): ${stdout.slice(0, 300)}`)
  }
}

function parseArgs(argv) {
  const args = { dir: process.cwd(), vex: DEFAULT_VEX, level: 'high' }
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]
    const value = argv[i + 1]
    if (flag === '--dir' && value) {
      args.dir = value
      i += 1
    } else if (flag === '--vex' && value) {
      args.vex = value
      i += 1
    } else if (flag === '--audit-level' && value) {
      args.level = value
      i += 1
    } else {
      throw new Error(`unknown argument "${flag}"`)
    }
  }
  return args
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv)
  const dir = resolve(args.dir)
  const vexPath = resolve(args.vex)
  const levels = gateLevelsFromThreshold(args.level)

  const report = runNpmAudit(dir)
  const vex = JSON.parse(readFileSync(vexPath, 'utf8'))
  const lock = JSON.parse(readFileSync(join(dir, 'package-lock.json'), 'utf8'))
  const { failures, suppressed, belowGate } = evaluateAudit(report, vex, lock, levels)

  if (failures.length > 0) {
    console.error(`Dependency audit failed: ${failures.length} package(s) at or above "${args.level}" without a VEX not_affected statement.`)
    for (const failure of failures) {
      const versions = failure.versions.length > 0 ? failure.versions.join(', ') : 'unknown version'
      console.error(`  - ${failure.name}@${versions} (${failure.severity})`)
      for (const advisory of failure.advisories) {
        console.error(`      ${advisory.url || [...advisory.ids].join(', ')}`)
      }
      if (failure.dependencies.length > 0) {
        console.error(`      via ${failure.dependencies.join(', ')}`)
      }
    }
    console.error(`Triage the advisory and add a not_affected statement to ${vexPath} (see docs/internal/runbooks/supply-chain-vex.md).`)
    return 1
  }

  const notes = []
  if (suppressed.length > 0) notes.push(`VEX suppressed: ${suppressed.join(', ')}`)
  if (belowGate.length > 0) notes.push(`below gate: ${belowGate.join(', ')}`)
  const notesNote = notes.length > 0 ? ` (${notes.join('; ')})` : ''
  console.log(`Dependency audit passed: no unsuppressed ${args.level} or higher advisories${notesNote}.`)
  return 0
}

const isCli = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isCli) {
  try {
    process.exitCode = main()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
