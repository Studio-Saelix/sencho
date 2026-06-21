import { DatabaseService } from './DatabaseService';
import type { StackDriftFindingRow } from './DatabaseService';
import { FileSystemService } from './FileSystemService';
import DockerController from './DockerController';
import type { DependencySnapshot } from './DockerController';
import { parseComposeDependencies } from '../helpers/composeDependencyParse';
import type { DeclaredCompose } from '../helpers/composeDependencyParse';
import { sha256Hex } from '../utils/hashing';
import { sanitizeForLog } from '../utils/safeLog';
import { getErrorMessage } from '../utils/errors';
import { assembleStackDrift, buildStackDriftReport } from './DriftDetectionService';
import type { StackDriftReport, StackDriftFinding } from './DriftDetectionService';

/**
 * The persistence-backed Drift Ledger that builds on the read-only spatial
 * engine (DriftDetectionService). It adds the two things the engine deliberately
 * leaves out: a deploy-time baseline (so "the source changed since you deployed"
 * can be answered) and a persisted history of findings (so drift can be seen to
 * appear and resolve over time). Node-local: it reads and writes the database of
 * whichever node owns the stack.
 */

/** Temporal alignment of the on-disk compose against the last deploy baseline. */
export interface DriftTemporal {
    /** True once a deploy through Sencho has recorded baseline hashes. */
    hasBaseline: boolean;
    /** The compose file's text differs from the last deploy. */
    sourceChanged: boolean;
    /** Parsed compose model differs from the last deploy (ignores comments/whitespace). */
    renderedChanged: boolean;
}

export interface DriftReconcileResult {
    detected: number;
    resolved: number;
}

/** A whole-node reconcile outcome: a stack result plus the number of stacks
 *  scanned cleanly. A stack that throws mid-scan is logged and excluded from the
 *  count, and the scan continues with the rest. */
export interface DriftNodeReconcileResult extends DriftReconcileResult {
    stacks: number;
}

/** Stable identity for a finding across checks: same service + kind is the same finding. */
function findingKey(service: string, kind: string): string {
    return JSON.stringify([service, kind]);
}

/**
 * Order-independent serialization of the parsed model so two compose files that
 * differ only in comments, whitespace, or key order hash equal, while a real
 * change to images/ports/services/networks/volumes changes the hash. Returns null
 * when the local parser cannot produce a model (for example a file over the parse
 * size cap), so the caller stores no rendered baseline rather than a sentinel that
 * would make a later real change read as unchanged.
 */
function stableModelString(model: DeclaredCompose): string | null {
    if (model.parseError) return null;
    const services = [...model.services]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(s => ({
            name: s.name,
            image: s.image ?? null,
            dependsOn: [...s.dependsOn].sort(),
            networks: [...s.networks].sort(),
            volumes: [...s.volumes].sort(),
            ports: s.ports.map(p => `${p.hostIp}:${p.publishedPort}/${p.protocol}`).sort(),
        }));
    const networks = Object.keys(model.networks).sort().map(k => ({ key: k, ...model.networks[k] }));
    const volumes = Object.keys(model.volumes).sort().map(k => ({ key: k, ...model.volumes[k] }));
    return JSON.stringify({ services, networks, volumes });
}

/**
 * Hashes a compose file two ways: the raw text (source) and the parsed model
 * (rendered). renderedHash is null when the model cannot be parsed, so a
 * model-level comparison is simply skipped rather than forced to a false equal.
 */
export function computeStackHashes(content: string): { sourceHash: string; renderedHash: string | null } {
    const model = stableModelString(parseComposeDependencies(content));
    return {
        sourceHash: sha256Hex(content),
        renderedHash: model === null ? null : sha256Hex(model),
    };
}

export class DriftLedgerService {
    private static instance: DriftLedgerService | null = null;

    static getInstance(): DriftLedgerService {
        if (!DriftLedgerService.instance) DriftLedgerService.instance = new DriftLedgerService();
        return DriftLedgerService.instance;
    }

    private constructor() { /* singleton */ }

    /**
     * Record the deploy-time baseline hashes for a stack. Best-effort: a read or
     * hash failure is logged and swallowed so it never fails the deploy that
     * triggered it.
     */
    async recordBaseline(nodeId: number, stackName: string): Promise<void> {
        try {
            const content = await FileSystemService.getInstance(nodeId).getStackContent(stackName);
            const { sourceHash, renderedHash } = computeStackHashes(content);
            DatabaseService.getInstance().setStackDossierHashes(nodeId, stackName, sourceHash, renderedHash);
        } catch (error) {
            console.error('[DriftLedger] Failed to record baseline for %s:', sanitizeForLog(stackName), sanitizeForLog(getErrorMessage(error, 'unknown')));
        }
    }

    /** Compare the current compose content against the stored deploy baseline. */
    computeTemporal(nodeId: number, stackName: string, content: string): DriftTemporal {
        const dossier = DatabaseService.getInstance().getStackDossier(nodeId, stackName);
        const storedSource = dossier?.source_hash ?? null;
        const storedRendered = dossier?.rendered_hash ?? null;
        if (!storedSource) {
            return { hasBaseline: false, sourceChanged: false, renderedChanged: false };
        }
        const { sourceHash, renderedHash } = computeStackHashes(content);
        return {
            hasBaseline: true,
            sourceChanged: sourceHash !== storedSource,
            // Only a real model change counts; if either side has no parseable model, skip it.
            renderedChanged: storedRendered != null && renderedHash != null && renderedHash !== storedRendered,
        };
    }

    /**
     * Reconcile the spatial report's current findings against the persisted ledger:
     * insert findings that are newly seen, resolve ones that have cleared. Idempotent
     * (a repeat check with no change writes nothing). Skipped when the report is not
     * authoritative (Docker unreachable or a compose parse error) so open findings are
     * never falsely resolved. On a real transition it records one summary activity row
     * per direction so the stack Activity timeline shows drift appearing and clearing.
     */
    reconcile(nodeId: number, stackName: string, report: StackDriftReport): DriftReconcileResult {
        if (report.status === 'unreachable' || report.parseError) {
            return { detected: 0, resolved: 0 };
        }
        const db = DatabaseService.getInstance();
        const now = Date.now();
        const openByKey = new Map(db.getOpenDriftFindings(nodeId, stackName).map(r => [findingKey(r.service, r.finding_type), r]));
        const currentByKey = new Map(report.findings.map(f => [findingKey(f.service, f.kind), f]));

        const toInsert: StackDriftFinding[] = [];
        for (const [key, f] of currentByKey) {
            if (!openByKey.has(key)) toInsert.push(f);
        }
        const toResolve: StackDriftFindingRow[] = [];
        for (const [key, row] of openByKey) {
            if (!currentByKey.has(key)) toResolve.push(row);
        }
        // Stamp the check time and apply any transitions in one transaction, so the
        // "checked {time ago}" the Drift tab shows can never persist without the ledger
        // update it describes. The stamp runs even on a no-op authoritative check (no
        // transitions), so the history's "as of" stays honest while a stale finding
        // reads as history rather than as live truth.
        db.getDb().transaction(() => {
            db.setStackDossierDriftCheck(nodeId, stackName, now);
            for (const f of toInsert) {
                db.insertDriftFinding({
                    node_id: nodeId,
                    stack_name: stackName,
                    service: f.service,
                    finding_type: f.kind,
                    severity: 'warning',
                    message: f.detail,
                    expected_json: f.expected !== undefined ? JSON.stringify(f.expected) : null,
                    actual_json: f.actual !== undefined ? JSON.stringify(f.actual) : null,
                    detected_at: now,
                });
            }
            for (const row of toResolve) {
                db.resolveDriftFinding(row.id, now);
            }
        })();

        if (toInsert.length > 0) {
            this.recordActivity(nodeId, stackName, 'drift_detected', 'warning',
                `Drift detected on ${stackName}: ${toInsert.length} new finding${toInsert.length === 1 ? '' : 's'}`, now);
        }
        if (toResolve.length > 0) {
            this.recordActivity(nodeId, stackName, 'drift_resolved', 'info',
                `Drift resolved on ${stackName}: ${toResolve.length} finding${toResolve.length === 1 ? '' : 's'} cleared`, now);
        }
        return { detected: toInsert.length, resolved: toResolve.length };
    }

    /**
     * Build the spatial report for one stack and reconcile it into the ledger.
     * Used by the deploy and update success hooks (and the rollback route, which
     * re-deploys through deployStack) so a change resolves the findings it fixed and
     * records what it left behind. Best-effort: a build or reconcile failure is
     * logged and swallowed so it never fails the deploy that triggered it.
     */
    async reconcileStack(nodeId: number, stackName: string): Promise<DriftReconcileResult> {
        try {
            const report = await buildStackDriftReport(nodeId, stackName);
            return this.reconcile(nodeId, stackName, report);
        } catch (error) {
            console.error('[DriftLedger] reconcileStack failed for %s:', sanitizeForLog(stackName), sanitizeForLog(getErrorMessage(error, 'unknown')));
            return { detected: 0, resolved: 0 };
        }
    }

    /**
     * Reconcile every stack on a node against a single Docker snapshot. The
     * background scanner drives this so drift is recorded (and its activity
     * surfaced) without an operator opening each Drift tab. One snapshot is shared
     * across all stacks to keep a full-node scan cheap. A Docker-unreachable node is
     * skipped wholesale rather than falsely resolving open findings; a single stack
     * failing (unreadable compose, etc.) is logged and the scan moves on.
     */
    async reconcileNode(nodeId: number): Promise<DriftNodeReconcileResult> {
        const fs = FileSystemService.getInstance(nodeId);
        let stacks: string[];
        try {
            stacks = await fs.getStacks();
        } catch (error) {
            console.error('[DriftLedger] reconcileNode: failed to list stacks on node %d:', nodeId, sanitizeForLog(getErrorMessage(error, 'unknown')));
            return { stacks: 0, detected: 0, resolved: 0 };
        }
        let snapshot: DependencySnapshot;
        try {
            snapshot = await DockerController.getInstance(nodeId).getDependencySnapshot(stacks);
        } catch (error) {
            console.warn('[DriftLedger] reconcileNode: snapshot unavailable on node %d; scan skipped:', nodeId, sanitizeForLog(getErrorMessage(error, 'unknown')));
            return { stacks: 0, detected: 0, resolved: 0 };
        }
        let detected = 0, resolved = 0, scanned = 0;
        for (const stackName of stacks) {
            try {
                const content = await fs.getStackContent(stackName);
                const declared = parseComposeDependencies(content);
                const containers = snapshot.containers.filter(c => c.stack === stackName);
                const report = assembleStackDrift({ stack: stackName, declared, containers, networks: snapshot.networks, parseError: declared.parseError });
                const r = this.reconcile(nodeId, stackName, report);
                detected += r.detected;
                resolved += r.resolved;
                scanned += 1;
            } catch (error) {
                console.error('[DriftLedger] reconcileNode: failed for stack %s:', sanitizeForLog(stackName), sanitizeForLog(getErrorMessage(error, 'unknown')));
            }
        }
        return { stacks: scanned, detected, resolved };
    }

    /**
     * Write a drift transition to the stack activity timeline. History-only (no
     * external channel dispatch): a drift signal belongs in the activity feed, not
     * in every configured Discord/Slack webhook.
     */
    private recordActivity(
        nodeId: number,
        stackName: string,
        category: 'drift_detected' | 'drift_resolved',
        level: 'info' | 'warning',
        message: string,
        timestamp: number,
    ): void {
        try {
            DatabaseService.getInstance().addNotificationHistory(nodeId, {
                level,
                category,
                message,
                timestamp,
                stack_name: stackName,
                actor_username: null,
            });
        } catch (error) {
            console.error('[DriftLedger] Failed to record activity for %s:', sanitizeForLog(stackName), sanitizeForLog(getErrorMessage(error, 'unknown')));
        }
    }
}
