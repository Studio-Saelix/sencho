import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';

import DockerController from './DockerController';
import { ComposeService } from './ComposeService';
import { FileSystemService } from './FileSystemService';
import { DatabaseService } from './DatabaseService';
import { computeStackHashes } from './DriftLedgerService';
import { parseComposeDependencies } from '../helpers/composeDependencyParse';
import { parseEffectiveModel, type EffectiveModel } from './preflight/effectiveModel';
import { runRules, SEVERITY_RANK, RULE_IDS, RENDER_FAILED_RULE_ID } from './preflight/rules';
import type {
  BindCheck, NodePortBinding, PreflightContext, PreflightFinding, PreflightReport, PreflightSeverity, PreflightStatus,
} from './preflight/types';

import { isPathWithinBase } from '../utils/validation';
import { getErrorMessage } from '../utils/errors';
import { redactSensitiveText, sanitizeForLog } from '../utils/safeLog';

const MAX_RENDER_ERROR = 600; // chars kept from a (redacted) render error

/** Collect the deduplicated capture-group-1 matches of a global regex over stderr. */
function collectNames(stderr: string, re: RegExp): string[] {
  const names = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(stderr)) !== null) names.add(m[1]);
  return [...names];
}

/**
 * Pull the names of variables Compose reported as unset from its stderr.
 * Compose prints this in logfmt (`msg="The \"VAR\" variable is not set..."`),
 * so the name is wrapped in an escaped quote; the pattern tolerates the
 * escaped, plain-quoted, and unquoted forms across Compose versions.
 */
export function parseUnsetEnvVars(stderr: string): string[] {
  return collectNames(stderr, /([A-Za-z_][A-Za-z0-9_]*)\\?"?\s+variable is not set/gi);
}

/** Names of required (${VAR:?...}) variables Compose reported as missing. Names only, never values. */
export function parseMissingRequiredVars(stderr: string): string[] {
  return collectNames(stderr, /required variable\s+\\?"?([A-Za-z_][A-Za-z0-9_]*)\\?"?\s+is missing/gi);
}

const ruleOrder = new Map(RULE_IDS.map((id, i) => [id, i]));
/** Severity descending, then registry order, so output is deterministic. */
function sortFindings(findings: PreflightFinding[]): PreflightFinding[] {
  return [...findings].sort((a, b) =>
    (SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]) ||
    ((ruleOrder.get(a.ruleId) ?? 0) - (ruleOrder.get(b.ruleId) ?? 0)));
}

function highestOf(findings: PreflightFinding[]): PreflightSeverity | null {
  let best: PreflightSeverity | null = null;
  for (const f of findings) {
    if (best === null || SEVERITY_RANK[f.severity] > SEVERITY_RANK[best]) best = f.severity;
  }
  return best;
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
        sanitizeForLog(stackName), sanitizeForLog(getErrorMessage(err, 'unknown')));
    }
    const sourceReadable = source !== null;
    // renderedHash is the parsed-SOURCE-model hash (the same `rendered_hash`
    // meaning the drift ledger uses), deliberately not a hash of docker's
    // rendered output, which inlines resolved env values and must never be hashed.
    const hashes = source !== null
      ? computeStackHashes(source)
      : { sourceHash: null as string | null, renderedHash: null as string | null };
    const sourceServiceNames = source !== null ? parseComposeDependencies(source).services.map(s => s.name) : [];

    const ctx = await this.buildContext(nodeId, stackName, sourceServiceNames, sourceReadable);
    const findings = sortFindings(runRules(ctx));
    const highestSeverity = highestOf(findings);
    const status: PreflightStatus = !ctx.renderable ? 'unrenderable' : (highestSeverity ?? 'pass');

    const report: PreflightReport = {
      stack: stackName,
      ranAt: Date.now(),
      ranBy,
      renderable: ctx.renderable,
      renderError: ctx.renderError,
      status,
      highestSeverity,
      sourceHash: hashes.sourceHash,
      renderedHash: hashes.renderedHash,
      findings,
    };
    this.persist(nodeId, report);
    return report;
  }

  /** Read the last stored run for a stack, mapped to the report shape. */
  getLatest(nodeId: number, stackName: string): PreflightReport {
    const db = DatabaseService.getInstance();
    const run = db.getLatestPreflightRun(nodeId, stackName);
    if (!run) {
      return {
        stack: stackName, ranAt: null, ranBy: null, renderable: true, renderError: null,
        status: 'never-run', highestSeverity: null, sourceHash: null, renderedHash: null, findings: [],
      };
    }
    const findings = sortFindings(db.getPreflightFindings(run.id).map(r => ({
      ruleId: r.rule_id,
      severity: r.severity as PreflightSeverity,
      title: r.title,
      message: r.message,
      sourcePath: r.source_path ?? undefined,
      remediation: r.remediation ?? undefined,
      service: r.service ?? undefined,
    })));
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
    };
  }

  private async buildContext(nodeId: number, stackName: string, sourceServiceNames: string[], sourceReadable: boolean): Promise<PreflightContext> {
    const fsSvc = FileSystemService.getInstance(nodeId);
    const baseDir = fsSvc.getBaseDir();

    let renderable = false;
    let renderError: string | null = null;
    let model: EffectiveModel | null = null;
    let unsetEnvVars: string[] = [];
    try {
      const result = await ComposeService.getInstance(nodeId).renderConfig(stackName);
      if (result.rendered !== null) {
        // Unset-variable warnings come from stderr and do not depend on the
        // model parsing, so capture them before attempting the parse, so a parse
        // failure does not also suppress the env-unset findings.
        unsetEnvVars = parseUnsetEnvVars(result.stderr);
        try {
          model = parseEffectiveModel(JSON.parse(result.rendered), stackName);
          renderable = true;
        } catch (parseErr) {
          // JSON.parse errors carry no file content, so the message is safe to log.
          console.warn('[ComposeDoctor] Effective model parse failed for %s:',
            sanitizeForLog(stackName), sanitizeForLog(getErrorMessage(parseErr, 'unknown')));
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

    const { nodePorts, existingNetworkNames, existingVolumeNames, existingContainers } = await this.nodeState(nodeId, fsSvc, stackName);
    const bindChecks = model ? await this.resolveBindChecks(model, baseDir) : [];

    return {
      stackName,
      platform: process.platform,
      model,
      renderable,
      renderError,
      unsetEnvVars,
      sourceServiceNames,
      sourceReadable,
      nodePorts,
      existingNetworkNames,
      existingVolumeNames,
      existingContainers,
      bindChecks,
    };
  }

  /** Snapshot the node's ports/networks/volumes/containers. Degrades to empty if Docker is unreachable. */
  private async nodeState(nodeId: number, fsSvc: FileSystemService, stackName: string): Promise<{
    nodePorts: NodePortBinding[];
    existingNetworkNames: Set<string>;
    existingVolumeNames: Set<string>;
    existingContainers: { name: string; stack: string | null }[];
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
      };
    } catch (error) {
      console.warn('[ComposeDoctor] Node snapshot unavailable for %s; node-state checks skipped:',
        sanitizeForLog(stackName), sanitizeForLog(getErrorMessage(error, 'unknown')));
      return { nodePorts: [], existingNetworkNames: new Set(), existingVolumeNames: new Set(), existingContainers: [] };
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
  private persist(nodeId: number, report: PreflightReport): void {
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
          status: report.status,
          highest_severity: report.highestSeverity,
          created_at: report.ranAt,
          created_by: report.ranBy,
        },
        report.findings.map(f => ({
          id: randomUUID(),
          run_id: runId,
          rule_id: f.ruleId,
          severity: f.severity,
          title: f.title,
          message: f.message,
          source_path: f.sourcePath ?? null,
          remediation: f.remediation ?? null,
          service: f.service ?? null,
          created_at: report.ranAt!,
        })),
      );
    } catch (error) {
      console.error('[ComposeDoctor] Failed to persist preflight run for %s:',
        sanitizeForLog(report.stack), sanitizeForLog(getErrorMessage(error, 'unknown')));
    }
  }
}
