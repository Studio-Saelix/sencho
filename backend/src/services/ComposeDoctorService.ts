import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';

import DockerController from './DockerController';
import { ComposeService } from './ComposeService';
import { FileSystemService } from './FileSystemService';
import { DatabaseService, type PreflightAcknowledgement, type PreflightRunRow } from './DatabaseService';
import { computeStackHashes } from './DriftLedgerService';
import { parseComposeDependencies } from '../helpers/composeDependencyParse';
import { parseEffectiveModel, type EffectiveModel } from './preflight/effectiveModel';
import { getExposureContext } from './network/exposureContext';
import { isStackMeshManaged } from './network/managedMeshAttachment';
import type { ExposureIntent } from './network/types';
import { SEVERITY_RANK, RENDER_FAILED_RULE_ID, isPreflightNoteFinding } from './preflight/rules';
import type {
  BindCheck, NodePortBinding, PreflightContext, PreflightFinding, PreflightReport, PreflightSeverity, PreflightStatus, MissingEnvFile,
  ServiceHealthcheckEvidence,
} from './preflight/types';
import type { AssuranceCoverage } from './assurance/types';
import { runAssuranceRules, parseCoverage, unrecordedCoverage } from './assurance/coverage';
import {
  findFingerprintCollisions, normalizeDoctorHit, normalizeStoredFinding, serializeSourceLocation,
  withDecision, type AssuranceFinding,
} from './assurance/finding';
import { buildAuthoredProject, locateFinding, type AuthoredLocation, type AuthoredProject } from './composeSource';
import { dropStaleStoredLocations } from './assurance/locationFreshness';
import { assuranceRuleOrder, getAssuranceRule } from './assurance/ruleRegistry';
import { collectServiceHealthcheckEvidence } from './healthcheck/collectServiceHealthcheckEvidence';
import {
  applyPreflightAcknowledgements, parseServiceImages, type PreflightAckFilterContext,
} from '../utils/preflight-ack-filter';

import { isPathWithinBase } from '../utils/validation';
import { getErrorMessage } from '../utils/errors';
import { errorMessageForLog, redactSensitiveText, sanitizeForLog } from '../utils/safeLog';
import { parseUnsetEnvVars, parseMissingRequiredVars, readEnvFileKeys } from '../helpers/envVarParse';
import { resolveStackEnvSources, type StackEnvSources } from '../helpers/envFileResolution';
import { isSelfStack } from '../helpers/selfStackGuard';
import { classifyUnsetEnvVars, type LiteralDollarWarning } from '../helpers/unsetEnvClassification';
import { listNodeContainers } from '../helpers/dockerEndpointGuard';
import {
  COMPOSE_VERSION_PROBE_TIMEOUT_MS,
  composeVersionContainerFromLabels,
  findComposeVersionSkew,
  type ComposeVersionSkew,
} from '../helpers/composeVersionSkew';
import { withTimeout } from '../utils/withTimeout';

const MAX_RENDER_ERROR = 600; // chars kept from a (redacted) render error

/** Severity descending, then registry order, so output is deterministic. */
function compareFindings(
  a: { severity: PreflightSeverity; ruleId: string },
  b: { severity: PreflightSeverity; ruleId: string },
): number {
  return (SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity])
    || (assuranceRuleOrder(a.ruleId) - assuranceRuleOrder(b.ruleId));
}

function sortNormalized(findings: AssuranceFinding[]): AssuranceFinding[] {
  return [...findings].sort(compareFindings);
}

/** Attach the digest of the file a location points into, so a later read can
 *  prove the range still applies to the content it was computed against. A
 *  location whose file has no digest (unreadable, too large, or not read at
 *  all) is not actionable: a fallback line 1 would be a wrong line, so it is
 *  dropped here as well as on a later read. */
function withFileHash(
  project: AuthoredProject | null,
  location: AuthoredLocation | undefined,
): AuthoredLocation | undefined {
  if (!location || !project) return undefined;
  const fileHash = project.files.find(file => file.file === location.file)?.contentHash;
  return fileHash === undefined ? undefined : { ...location, fileHash };
}

/** Project one finding onto the Doctor wire shape, without a decision. The wire
 *  type predates the contract and stays additive: a finding's subject and
 *  identity are backend internals until a normalized wire format exists. An
 *  authored range travels only with the digest of the content it was computed
 *  against, so the client can prove the file it opens is that revision. */
function projectFinding(finding: AssuranceFinding): PreflightFinding {
  const location = finding.location;
  const authored = location?.file !== undefined && location.line !== undefined && location.column !== undefined
    && location.endLine !== undefined && location.endColumn !== undefined && location.fileHash !== undefined
    ? {
      file: location.file,
      ...(location.authoredPath !== undefined || location.path !== undefined
        ? { path: location.authoredPath ?? location.path }
        : {}),
      line: location.line,
      column: location.column,
      endLine: location.endLine,
      endColumn: location.endColumn,
      fileHash: location.fileHash,
    }
    : undefined;
  return {
    ruleId: finding.ruleId,
    severity: finding.severity,
    title: finding.title,
    message: finding.message,
    ...(finding.location?.path !== undefined ? { sourcePath: finding.location.path } : {}),
    ...(authored ? { location: authored } : {}),
    ...(finding.remediation !== undefined ? { remediation: finding.remediation } : {}),
    ...(finding.scope.service !== undefined ? { service: finding.scope.service } : {}),
  };
}

/** The wire finding of a decided finding: the acknowledgement fields are read
 *  off the finding's own decision, so the wire and the contract cannot disagree. */
function projectDecided(finding: AssuranceFinding): PreflightFinding {
  const wire = projectFinding(finding);
  const decision = finding.decision;
  if (!decision) return { ...wire, acknowledged: false };
  return {
    ...wire,
    acknowledged: true,
    acknowledgementId: decision.id,
    acknowledgementReason: decision.reason,
    acknowledgementExpiry: decision.expiry.mode,
    ...(decision.expiry.expiresAt !== undefined ? { acknowledgementExpiresAt: decision.expiry.expiresAt } : {}),
  };
}

/**
 * Attach each finding's acknowledgement decision. Every finding is matched on
 * its own projection, so nothing pairs two sequences by position and a later
 * sort or filter cannot move a decision onto another finding. `now` is read once
 * by the caller, so every finding of one report sees the same clock.
 */
function decideFindings(
  findings: readonly AssuranceFinding[],
  ackCtx: PreflightAckFilterContext,
  acks: PreflightAcknowledgement[],
  now: number,
): AssuranceFinding[] {
  return findings.map(finding => {
    const [decided] = applyPreflightAcknowledgements([projectFinding(finding)], ackCtx, acks, now);
    return withDecision(finding, decided);
  });
}

function highestOf(findings: PreflightFinding[]): PreflightSeverity | null {
  let best: PreflightSeverity | null = null;
  for (const f of findings) {
    if (isPreflightNoteFinding(f.ruleId)) continue;
    if (best === null || SEVERITY_RANK[f.severity] > SEVERITY_RANK[best]) best = f.severity;
  }
  return best;
}

function activeFields(
  renderable: boolean,
  findings: PreflightFinding[],
): Pick<PreflightReport, 'activeStatus' | 'activeHighestSeverity' | 'activeCount' | 'acknowledgedCount'> {
  // Notes stay in `findings` for display but do not affect All Clear or active severity.
  const issueFindings = findings.filter(f => !isPreflightNoteFinding(f.ruleId));
  const active = issueFindings.filter(f => !f.acknowledged);
  const acknowledgedCount = issueFindings.length - active.length;
  const activeHighestSeverity = highestOf(active);
  const activeStatus: PreflightStatus = !renderable
    ? 'unrenderable'
    : (activeHighestSeverity ?? 'pass');
  return {
    activeStatus,
    activeHighestSeverity,
    activeCount: active.length,
    acknowledgedCount,
  };
}

function buildServiceImages(model: EffectiveModel | null): string | null {
  if (!model) return null;
  const map: Record<string, string> = {};
  for (const svc of model.services) {
    if (svc.image) map[svc.name] = svc.image;
  }
  return Object.keys(map).length > 0 ? JSON.stringify(map) : null;
}

/** The acknowledgements of a stack plus the stored context their expiry reads. */
function loadAcknowledgementInputs(
  nodeId: number,
  stackName: string,
  renderedHash: string | null,
  serviceImagesJson: string | null,
): { acks: PreflightAcknowledgement[]; ackCtx: PreflightAckFilterContext } {
  return {
    acks: DatabaseService.getInstance().getPreflightAcknowledgements(nodeId, stackName),
    ackCtx: { renderedHash, serviceImages: parseServiceImages(serviceImagesJson) },
  };
}

/**
 * Compose Doctor: renders the effective model and runs the deterministic
 * preflight rule registry against the active node. Advisory only (it never
 * blocks a deploy), read-only with respect to the stack, and node-scoped. It
 * never stores, returns, or logs an environment value.
 */
export class ComposeDoctorService {
  private static instance: ComposeDoctorService | null = null;

  static getInstance(): ComposeDoctorService {
    if (!ComposeDoctorService.instance) ComposeDoctorService.instance = new ComposeDoctorService();
    return ComposeDoctorService.instance;
  }

  private constructor() { /* singleton */ }

  /** Run all checks, persist the result (replacing any prior run), return the report. */
  async runPreflight(nodeId: number, stackName: string, ranBy: string | null): Promise<PreflightReport> {
    const fsSvc = FileSystemService.getInstance(nodeId);
    let source: string | null = null;
    try {
      source = await fsSvc.getStackContent(stackName);
    } catch (err) {
      // An unreadable source is logged here (not silently swallowed) so a later
      // skipped hash or source comparison is traceable.
      console.warn('[ComposeDoctor] Source unreadable for %s; source-derived checks skipped:',
        sanitizeForLog(stackName), errorMessageForLog(err));
    }
    // renderedHash is the parsed-SOURCE-model hash (the same `rendered_hash`
    // meaning the drift ledger uses), deliberately not a hash of docker's
    // rendered output, which inlines resolved env values and must never be hashed.
    const hashes = source !== null
      ? computeStackHashes(source)
      : { sourceHash: null as string | null, renderedHash: null as string | null };
    const authored = await this.loadAuthoredProject(nodeId, stackName);
    const sourceServiceNames = source !== null ? this.sourceServiceNames(source, authored) : null;

    // An unknown source service set must stay unknown: treating it as empty
    // makes every rendered service look like it was pulled in from elsewhere.
    const ctx = await this.buildContext(
      nodeId, stackName, sourceServiceNames ?? [], source !== null, sourceServiceNames !== null,
    );
    const { findings: hits, coverage } = runAssuranceRules(ctx);
    const normalized = sortNormalized(hits.map(hit => {
      const rule = getAssuranceRule(hit.ruleId);
      if (!rule) throw new Error(`Compose Doctor rule "${hit.ruleId}" is missing from the assurance registry`);
      return normalizeDoctorHit(nodeId, stackName, hit, rule, withFileHash(authored, locateFinding(authored, hit, ctx.model)));
    }));
    const collisions = findFingerprintCollisions(normalized);
    if (collisions.length > 0) {
      // Different findings under one identity mean a rule emitted several hits
      // without a distinct subject. They are all kept (the wire report is
      // unchanged), and the rule ids are named here so the rule gets its subject.
      console.warn('[ComposeDoctor] Findings share a fingerprint for rule(s) %s in %s on node %d',
        sanitizeForLog(collisions.join(', ')), sanitizeForLog(stackName), nodeId);
    }
    const serviceImages = buildServiceImages(ctx.model);
    // The decisions use the hashes and images this run stores, not whatever run
    // is stored last, so a failed persist cannot pair them with an older run.
    const { acks, ackCtx } = loadAcknowledgementInputs(nodeId, stackName, hashes.renderedHash, serviceImages);
    const findings = decideFindings(normalized, ackCtx, acks, Date.now()).map(projectDecided);
    const highestSeverity = highestOf(findings);
    const status: PreflightStatus = !ctx.renderable ? 'unrenderable' : (highestSeverity ?? 'pass');

    const report: PreflightReport = {
      stack: stackName,
      ranAt: Date.now(),
      ranBy,
      renderable: ctx.renderable,
      renderError: ctx.renderError === null ? null : redactSensitiveText(ctx.renderError),
      status,
      highestSeverity,
      sourceHash: hashes.sourceHash,
      renderedHash: hashes.renderedHash,
      findings,
      coverage,
      ...activeFields(ctx.renderable, findings),
    };
    this.persist(nodeId, report, serviceImages, normalized);
    return report;
  }

  /**
   * The latest stored run row, its normalized findings (an acknowledged one
   * carries its read-time decision), and its coverage. `getLatest` is a
   * projection of this, and the Doctor tab's GET route, update readiness, and the
   * networking findings all read `getLatest`, so the contract is on the hot path
   * rather than a parallel model. A fresh `runPreflight` decides its findings the
   * same way (`decideFindings`).
   */
  async getLatestAssurance(nodeId: number, stackName: string): Promise<{
    run: PreflightRunRow | null;
    findings: AssuranceFinding[];
    coverage: AssuranceCoverage;
  }> {
    const run = DatabaseService.getInstance().getLatestPreflightRun(nodeId, stackName);
    if (!run) return { run: null, findings: [], coverage: unrecordedCoverage() };
    const { acks, ackCtx } = loadAcknowledgementInputs(nodeId, stackName, run.rendered_hash, run.service_images);
    // A range is only actionable while the file it names still has the content
    // the run hashed; an edited file drops the link until its content matches
    // the run again.
    const stored = await dropStaleStoredLocations(nodeId, stackName, this.readNormalized(nodeId, stackName, run.id));
    return {
      run,
      // One clock reading for the whole read.
      findings: decideFindings(stored, ackCtx, acks, Date.now()),
      coverage: parseCoverage(run.coverage),
    };
  }

  /** Read stored rows through the contract: redacted, sorted, legacy-aware. */
  private readNormalized(nodeId: number, stackName: string, runId: string): AssuranceFinding[] {
    return sortNormalized(
      DatabaseService.getInstance().getPreflightFindings(runId)
        .map(row => normalizeStoredFinding(row, nodeId, stackName)),
    );
  }

  /** Read the last stored run for a stack, mapped to the report shape. */
  async getLatest(nodeId: number, stackName: string): Promise<PreflightReport> {
    const { run, findings: decided, coverage } = await this.getLatestAssurance(nodeId, stackName);
    if (!run) {
      return {
        stack: stackName, ranAt: null, ranBy: null, renderable: true, renderError: null,
        status: 'never-run', highestSeverity: null, sourceHash: null, renderedHash: null, findings: [],
        coverage,
        activeStatus: 'never-run', activeHighestSeverity: null, activeCount: 0, acknowledgedCount: 0,
      };
    }
    const findings = decided.map(projectDecided);
    const renderable = run.status !== 'unrenderable';
    // The render error is carried by the render-failed finding, not a column.
    const renderError = renderable ? null : (findings.find(f => f.ruleId === RENDER_FAILED_RULE_ID)?.message ?? null);
    return {
      stack: stackName,
      ranAt: run.created_at,
      ranBy: run.created_by,
      renderable,
      renderError,
      status: run.status as PreflightStatus,
      highestSeverity: (run.highest_severity as PreflightSeverity | null) ?? null,
      sourceHash: run.source_hash,
      renderedHash: run.rendered_hash,
      findings,
      coverage,
      ...activeFields(renderable, findings),
    };
  }

  /**
   * The authored source model, built fail-soft: a model failure leaves every
   * finding unlocated (today's behaviour) and never fails the run. The warning
   * names the stack and a sanitized message, never file content.
   */
  private async loadAuthoredProject(nodeId: number, stackName: string): Promise<AuthoredProject | null> {
    try {
      return await buildAuthoredProject(nodeId, stackName);
    } catch (error) {
      console.warn('[ComposeDoctor] Authored source model unavailable for %s:',
        sanitizeForLog(stackName), errorMessageForLog(error));
      return null;
    }
  }

  /**
   * The services the primary authored file declares, or null when that cannot
   * be known. The YAML library's alias-expansion budget makes the light
   * `parseComposeDependencies` parser report a whole file as unparseable, and
   * an empty list would read as "zero services" to `effective-model-expanded`.
   * The authored parser follows aliases and merge keys under its own depth cap
   * and still knows the top-level keys when it refuses the rest, so it answers
   * first; the light parser is only a fallback for a model this run could not
   * build.
   */
  private sourceServiceNames(source: string, authored: AuthoredProject | null): string[] | null {
    const primary = authored?.files.find(file => file.kind === 'compose-primary');
    if (primary?.serviceNames !== undefined) return primary.serviceNames;
    const declared = parseComposeDependencies(source);
    return declared.parseError ? null : declared.services.map(service => service.name);
  }

  private async buildContext(
    nodeId: number,
    stackName: string,
    sourceServiceNames: string[],
    sourceReadable: boolean,
    sourceServicesKnown: boolean,
  ): Promise<PreflightContext> {
    const fsSvc = FileSystemService.getInstance(nodeId);
    const baseDir = fsSvc.getBaseDir();

    let renderable = false;
    let renderError: string | null = null;
    let model: EffectiveModel | null = null;
    let unsetEnvVars: string[] = [];
    let literalDollarWarnings: LiteralDollarWarning[] = [];
    let missingEnvFiles: MissingEnvFile[] = [];

    // The env context is the resolved env sources plus the key names of every
    // env file that is present. It is null when resolution failed or when a file
    // Compose would read cannot be read, so the env rules are reported as
    // skipped (partial coverage) instead of quietly returning nothing.
    let envContext: { sources: StackEnvSources; fileKeys: string[] } | null = null;
    try {
      const sources = await resolveStackEnvSources(nodeId, stackName);
      missingEnvFiles = sources.envFiles
        .filter(f => f.isInjectionSource && f.required && f.existence === 'missing')
        .map(f => ({ rawPath: f.rawPaths[0], services: f.declaringServices }));
      const fileKeys = await this.collectEnvFileKeys(sources, baseDir);
      if (fileKeys === null) {
        console.warn('[ComposeDoctor] An env file for %s cannot be read; env checks skipped',
          sanitizeForLog(stackName));
      } else {
        envContext = { sources, fileKeys };
      }
    } catch (err) {
      console.warn('[ComposeDoctor] env-file resolution failed for %s:',
        sanitizeForLog(stackName), errorMessageForLog(err));
    }
    const envContextAvailable = envContext !== null;

    try {
      const result = await ComposeService.getInstance(nodeId).renderConfig(stackName);
      if (result.rendered !== null) {
        // Unset-variable warnings come from stderr and do not depend on the
        // model parsing, so capture them before attempting the parse, so a parse
        // failure does not also suppress the env-unset findings.
        const rawUnset = parseUnsetEnvVars(result.stderr);
        if (envContext) {
          const classified = classifyUnsetEnvVars(rawUnset, envContext.sources, envContext.fileKeys);
          unsetEnvVars = classified.intentional;
          literalDollarWarnings = classified.literalDollar;
        } else {
          // Without authored env context, never surface raw stderr names as unset
          // variables; they may be literal-dollar fragments from secret values.
          unsetEnvVars = [];
          literalDollarWarnings = rawUnset.length > 0 ? [{ likelySecret: false }] : [];
        }
        try {
          model = parseEffectiveModel(JSON.parse(result.rendered), stackName);
          renderable = true;
        } catch (parseErr) {
          // JSON.parse errors carry no file content, so the message is safe to log.
          console.warn('[ComposeDoctor] Effective model parse failed for %s:',
            sanitizeForLog(stackName), errorMessageForLog(parseErr));
          renderError = 'Sencho could not parse the rendered Compose model.';
        }
      } else {
        // The raw stderr from `docker compose config` can echo file content
        // (and therefore secrets), so it is never stored. We surface only safe,
        // structural signals: the names of any required variables Compose
        // reported as missing, otherwise a generic nudge.
        const missing = parseMissingRequiredVars(result.stderr);
        renderError = missing.length
          ? `Required variable${missing.length > 1 ? 's' : ''} ${missing.join(', ')} ${missing.length > 1 ? 'have' : 'has'} no value, so the effective model cannot be rendered.`
          : 'Sencho could not render the effective Compose model. Check the compose and env files for a YAML syntax error, an unresolved include or merge, or a required variable with no value, then re-run.';
      }
    } catch (err) {
      // Spawn failure (docker unavailable). Spawn errors carry no file content;
      // redact defensively anyway.
      renderError = redactSensitiveText(getErrorMessage(err, 'docker compose could not be started.')).slice(0, MAX_RENDER_ERROR).trim()
        || 'Sencho could not run docker compose on this node.';
    }

    const { nodePorts, existingNetworkNames, existingVolumeNames, existingContainers, nodeStateAvailable } = await this.nodeState(nodeId, fsSvc, stackName);
    const [bindChecks, healthchecks] = await Promise.all([
      model ? this.resolveBindChecks(model, baseDir) : Promise.resolve([] as BindCheck[]),
      model
        ? collectServiceHealthcheckEvidence(nodeId, stackName, model, nodeStateAvailable)
        : Promise.resolve({} as Record<string, ServiceHealthcheckEvidence>),
    ]);
    const { stackIntent, serviceIntents, accessUrlPorts, hasAccessUrls, exposureAvailable } = this.exposureState(nodeId, stackName);
    const selfStack = await isSelfStack(stackName);
    const meshManaged = model ? await isStackMeshManaged(nodeId, stackName) : false;
    const composeVersionSkew = await this.composeVersionSkew(nodeId, stackName);

    return {
      stackName,
      platform: process.platform,
      model,
      renderable,
      renderError,
      unsetEnvVars,
      literalDollarWarnings,
      missingEnvFiles,
      sourceServiceNames,
      sourceReadable,
      sourceServicesKnown,
      nodePorts,
      existingNetworkNames,
      existingVolumeNames,
      existingContainers,
      nodeStateAvailable,
      bindChecks,
      stackIntent,
      serviceIntents,
      accessUrlPorts,
      hasAccessUrls,
      exposureAvailable,
      envContextAvailable,
      isSelfStack: selfStack,
      meshManaged,
      healthchecks,
      composeVersionSkew,
    };
  }

  /**
   * The key names of every env file Sencho can resolve, or null when one of
   * them cannot be read: a file whose existence could not be checked (an access
   * error, a configured project file outside the compose directory), or one that
   * is present but cannot be opened as a file (a directory, a permission error).
   * An absent file is not an unreadable one: it contributes no keys, and
   * `env-file-missing` reports it when it is required. An `env_file` path that is
   * interpolated or leaves the stack directory has no resolved path, cannot be
   * known ahead of Compose, and is not read.
   */
  private async collectEnvFileKeys(sources: StackEnvSources, baseDir: string): Promise<string[] | null> {
    const keys: string[] = [];
    for (const file of sources.envFiles) {
      if (!file.resolvedPath || file.existence === 'missing') continue;
      if (file.existence === 'unverifiable') return null;
      const read = await readEnvFileKeys(file.resolvedPath, baseDir);
      if (read.unverifiable) return null;
      keys.push(...read.keys);
    }
    return keys;
  }

  /**
   * Containers created by a different Compose version than this node deploys
   * with. Best-effort: a failed listing or an unreadable version yields null (no
   * note) with a logged warning, and the run still completes.
   */
  private async composeVersionSkew(nodeId: number, stackName: string): Promise<ComposeVersionSkew | null> {
    try {
      const listed = await withTimeout(
        listNodeContainers(nodeId, stackName),
        COMPOSE_VERSION_PROBE_TIMEOUT_MS,
        'preflight compose version container list',
      );
      const running = await withTimeout(
        ComposeService.getInstance(nodeId).composeVersion(),
        COMPOSE_VERSION_PROBE_TIMEOUT_MS,
        'preflight compose version probe',
      );
      return findComposeVersionSkew(listed.stack.map(container => composeVersionContainerFromLabels(container.Labels)), running);
    } catch (error) {
      console.warn('[ComposeDoctor] Compose version check unavailable for %s:',
        sanitizeForLog(stackName), errorMessageForLog(error));
      return null;
    }
  }

  /**
   * The user's stored exposure intent (resolved into stack-level + per-service)
   * and the dossier's documented access-URL ports, for the exposure rules.
   * Delegates to the shared exposure-context helper (also used by the live
   * Networking findings engine) so both engines can never diverge on severity.
   * Fail-soft: a read error defaults to unset/empty so the rules simply do not
   * fire rather than the whole preflight failing.
   */
  private exposureState(nodeId: number, stackName: string): {
    stackIntent: ExposureIntent | null;
    serviceIntents: Record<string, ExposureIntent>;
    accessUrlPorts: Set<number>;
    hasAccessUrls: boolean;
    exposureAvailable: boolean;
  } {
    const context = getExposureContext(nodeId, stackName);
    if (!context.available) {
      return { stackIntent: null, serviceIntents: {}, accessUrlPorts: new Set(), hasAccessUrls: false, exposureAvailable: false };
    }
    return {
      stackIntent: context.stackIntent,
      serviceIntents: context.serviceIntents,
      accessUrlPorts: context.accessUrlPorts,
      hasAccessUrls: context.hasAccessUrls,
      exposureAvailable: true,
    };
  }

  /** Snapshot the node's ports/networks/volumes/containers. Degrades to empty if Docker is unreachable. */
  private async nodeState(nodeId: number, fsSvc: FileSystemService, stackName: string): Promise<{
    nodePorts: NodePortBinding[];
    existingNetworkNames: Set<string>;
    existingVolumeNames: Set<string>;
    existingContainers: { name: string; stack: string | null }[];
    nodeStateAvailable: boolean;
  }> {
    try {
      const knownStacks = await fsSvc.getStacks();
      const snapshot = await DockerController.getInstance(nodeId).getDependencySnapshot(knownStacks);
      const nodePorts = snapshot.containers.flatMap(c =>
        c.ports.map(p => ({ publishedPort: p.publishedPort, protocol: p.protocol, ip: p.ip, stack: c.stack })));
      return {
        nodePorts,
        existingNetworkNames: new Set(snapshot.networks.map(n => n.name)),
        existingVolumeNames: new Set(snapshot.volumes.map(v => v.name)),
        existingContainers: snapshot.containers.map(c => ({ name: c.name, stack: c.stack })),
        nodeStateAvailable: true,
      };
    } catch (error) {
      console.warn('[ComposeDoctor] Node snapshot unavailable for %s; node-state checks skipped:',
        sanitizeForLog(stackName), errorMessageForLog(error));
      return { nodePorts: [], existingNetworkNames: new Set(), existingVolumeNames: new Set(), existingContainers: [], nodeStateAvailable: false };
    }
  }

  /**
   * Stat each bind-mount source. Existence/ownership is probed ONLY for sources
   * that resolve inside the node's compose base dir (relative binds); absolute
   * host paths are outside Sencho's filesystem view and are left unverified.
   */
  private async resolveBindChecks(model: EffectiveModel, baseDir: string): Promise<BindCheck[]> {
    const resolvedBase = path.resolve(baseDir);
    const checks: BindCheck[] = [];
    for (const svc of model.services) {
      for (const bind of svc.binds) {
        const withinBase = isPathWithinBase(path.resolve(bind.source), resolvedBase);
        let exists = false;
        let ownerUid: number | null = null;
        if (withinBase) {
          try {
            const st = await fs.promises.stat(bind.source);
            exists = true;
            ownerUid = typeof st.uid === 'number' ? st.uid : null;
          } catch {
            exists = false;
          }
        }
        checks.push({ service: svc.name, source: bind.source, target: bind.target, withinBase, exists, ownerUid });
      }
    }
    return checks;
  }

  /** Persist the run, replacing any prior run for this stack. Best-effort. */
  private persist(
    nodeId: number,
    report: PreflightReport,
    serviceImages: string | null,
    normalized: readonly AssuranceFinding[],
  ): void {
    if (report.ranAt === null) return;
    try {
      const runId = randomUUID();
      DatabaseService.getInstance().replacePreflightRun(
        {
          id: runId,
          node_id: nodeId,
          stack_name: report.stack,
          source_hash: report.sourceHash,
          rendered_hash: report.renderedHash,
          service_images: serviceImages,
          status: report.status,
          highest_severity: report.highestSeverity,
          created_at: report.ranAt,
          created_by: report.ranBy,
          coverage: JSON.stringify(report.coverage),
        },
        normalized.map(finding => ({
          id: randomUUID(),
          run_id: runId,
          rule_id: finding.ruleId,
          severity: finding.severity,
          title: finding.title,
          message: finding.message,
          source_path: finding.location?.path ?? null,
          source_location: serializeSourceLocation(finding.location),
          remediation: finding.remediation ?? null,
          service: finding.scope.service ?? null,
          rule_version: finding.ruleVersion,
          subject_kind: finding.subject.kind,
          subject_key: finding.subject.key,
          created_at: report.ranAt!,
        })),
      );
    } catch (error) {
      console.error('[ComposeDoctor] Failed to persist preflight run for %s:',
        sanitizeForLog(report.stack), errorMessageForLog(error));
    }
  }
}
