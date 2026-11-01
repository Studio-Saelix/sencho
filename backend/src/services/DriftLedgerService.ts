import { DatabaseService } from './DatabaseService';
import type { StackDriftFindingRow } from './DatabaseService';
import { FileSystemService } from './FileSystemService';
import { parseComposeDependencies } from '../helpers/composeDependencyParse';
import type { DeclaredCompose } from '../helpers/composeDependencyParse';
import { sha256Hex } from '../utils/hashing';
import { sanitizeForLog } from '../utils/safeLog';
import { getErrorMessage } from '../utils/errors';
import { buildStackDriftReport } from './DriftDetectionService';
import type { StackDriftReport, StackDriftFinding } from './DriftDetectionService';
import { holdRank } from './findingDismissals/FindingDismissalStore';
import type { DismissalTiming } from './findingDismissals/types';
import { driftFindingFacts, toDriftDismissal } from './driftDismissals';
import type { DriftDismissal, ParsedDriftKey } from './driftDismissals';

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

/** Record one live finding as a new open ledger row and return its id. */
function insertFindingRow(db: DatabaseService, nodeId: number, stackName: string, f: StackDriftFinding, detectedAt: number): number {
    return db.insertDriftFinding({
        node_id: nodeId,
        stack_name: stackName,
        service: f.service,
        finding_type: f.kind,
        severity: 'warning',
        message: f.detail,
        expected_json: f.expected !== undefined ? JSON.stringify(f.expected) : null,
        actual_json: f.actual !== undefined ? JSON.stringify(f.actual) : null,
        detected_at: detectedAt,
    });
}

export type DriftDismissRequest = DismissalTiming & {
    createdBy: string;
    now: number;
};

export type DriftDismissOutcome =
    | { ok: true; dismissal: DriftDismissal; kept: boolean }
    | { ok: false; code: 'FINDING_GONE' | 'FINDING_CHANGED' | 'EVIDENCE_UNAVAILABLE' };

/** Stable identity for a finding across checks: same service + kind is the same finding. */
function findingKey(service: string, kind: string): string {
    return JSON.stringify([service, kind]);
}

const SPATIAL_FINDING_KINDS = new Set([
    'service-missing',
    'service-undeclared',
    'image-mismatch',
    'ports-mismatch',
    'network-undeclared',
    'network-missing',
]);

const GIT_MANAGED_PATH_KIND = 'managed-path-conflict';

/**
 * Order-independent serialization of the parsed model so two compose files that
 * differ only in comments, whitespace, or key order hash equal, while a real
 * change to images, services, networks, volumes, or a fixed published port
 * changes the hash. A port Docker assigns records its interface and protocol,
 * not a number. Returns null
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
            // A port Docker assigns has no number, but adding one or widening its interface is a change.
            ports: s.ports.map(p => `${p.hostIp}:${p.dynamic ? 'auto' : p.publishedPort}/${p.protocol}`).sort(),
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
            if (!SPATIAL_FINDING_KINDS.has(row.finding_type)) continue;
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
                insertFindingRow(db, nodeId, stackName, f, now);
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
     * Service-scoped counterpart to `reconcile`: only inserts/resolves findings
     * for `serviceName`, leaving every other service's (and the empty/`null`
     * service, i.e. network-level) open findings untouched. Used by the service
     * update orchestrator so a service-scoped update never resolves drift it
     * did not touch. Never pass a report already filtered to one service into
     * the stack-wide `reconcile`; that would falsely resolve every other
     * service's open findings.
     */
    reconcileService(nodeId: number, stackName: string, serviceName: string, report: StackDriftReport): DriftReconcileResult {
        if (report.status === 'unreachable' || report.parseError) {
            return { detected: 0, resolved: 0 };
        }
        const db = DatabaseService.getInstance();
        const now = Date.now();
        const openForService = db.getOpenDriftFindings(nodeId, stackName).filter(r => r.service === serviceName);
        const openByKey = new Map(openForService.map(r => [findingKey(r.service, r.finding_type), r]));
        const currentForService = report.findings.filter(f => f.service === serviceName);
        const currentByKey = new Map(currentForService.map(f => [findingKey(f.service, f.kind), f]));

        const toInsert: StackDriftFinding[] = [];
        for (const [key, f] of currentByKey) {
            if (!openByKey.has(key)) toInsert.push(f);
        }
        const toResolve: StackDriftFindingRow[] = [];
        for (const [key, row] of openByKey) {
            if (!SPATIAL_FINDING_KINDS.has(row.finding_type)) continue;
            if (!currentByKey.has(key)) toResolve.push(row);
        }
        db.getDb().transaction(() => {
            db.setStackDossierDriftCheck(nodeId, stackName, now);
            for (const f of toInsert) {
                insertFindingRow(db, nodeId, stackName, f, now);
            }
            for (const row of toResolve) {
                db.resolveDriftFinding(row.id, now);
            }
        })();

        if (toInsert.length > 0) {
            this.recordActivity(nodeId, stackName, 'drift_detected', 'warning',
                `Drift detected on ${stackName} (${serviceName}): ${toInsert.length} new finding${toInsert.length === 1 ? '' : 's'}`, now);
        }
        if (toResolve.length > 0) {
            this.recordActivity(nodeId, stackName, 'drift_resolved', 'info',
                `Drift resolved on ${stackName} (${serviceName}): ${toResolve.length} finding${toResolve.length === 1 ? '' : 's'} cleared`, now);
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
     * Build the spatial report for one stack and reconcile only `serviceName`'s
     * findings into the ledger. Used by the service update orchestrator's
     * success path. Best-effort: a build or reconcile failure is logged and
     * swallowed so it never fails the update that triggered it.
     */
    async reconcileServiceForStack(nodeId: number, stackName: string, serviceName: string): Promise<DriftReconcileResult> {
        try {
            const report = await buildStackDriftReport(nodeId, stackName);
            return this.reconcileService(nodeId, stackName, serviceName, report);
        } catch (error) {
            console.error('[DriftLedger] reconcileServiceForStack failed for %s/%s:', sanitizeForLog(stackName), sanitizeForLog(serviceName), sanitizeForLog(getErrorMessage(error, 'unknown')));
            return { detected: 0, resolved: 0 };
        }
    }

    /**
     * Insert or refresh Git managed-path findings. Never resolves. An existing
     * open row keeps its original detected_at; only the redacted message updates.
     */
    upsertManagedPathConflicts(
        nodeId: number,
        stackName: string,
        conflicts: Array<{ path: string; op: string; role: string; sensitivity: 'high' | 'medium' | 'low' }>,
    ): void {
        const db = DatabaseService.getInstance();
        const now = Date.now();
        const open = db.getOpenDriftFindings(nodeId, stackName)
            .filter((r) => r.finding_type === GIT_MANAGED_PATH_KIND);
        const openByKey = new Map(open.map((r) => [r.service, r]));
        db.getDb().transaction(() => {
            for (const conflict of conflicts) {
                const key = sha256Hex(`${stackName}\0${conflict.path}`);
                const message = conflict.sensitivity === 'high'
                    ? `secret-bearing managed path (${conflict.op})`
                    : `${conflict.role} ${conflict.op}`;
                const existing = openByKey.get(key);
                if (existing) {
                    db.updateDriftFindingMessage(existing.id, message);
                    openByKey.delete(key);
                    continue;
                }
                db.insertDriftFinding({
                    node_id: nodeId,
                    stack_name: stackName,
                    service: key,
                    finding_type: GIT_MANAGED_PATH_KIND,
                    severity: 'warning',
                    message,
                    expected_json: null,
                    actual_json: null,
                    detected_at: now,
                });
            }
        })();
    }

    /**
     * Resolve every open managed-path-conflict for this stack. Call only after
     * a clean promotion; a clean pull must not close an existing Git finding.
     */
    resolveManagedPathConflicts(nodeId: number, stackName: string): void {
        const db = DatabaseService.getInstance();
        const now = Date.now();
        const open = db.getOpenDriftFindings(nodeId, stackName)
            .filter((r) => r.finding_type === GIT_MANAGED_PATH_KIND);
        if (open.length === 0) return;
        db.getDb().transaction(() => {
            for (const row of open) {
                db.resolveDriftFinding(row.id, now);
            }
        })();
    }

    /** The team dismissals on a stack's open findings, as the wire shape. */
    getOpenDismissals(nodeId: number, stackName: string): DriftDismissal[] {
        return DatabaseService.getInstance().getOpenDriftFindings(nodeId, stackName)
            .map(toDriftDismissal)
            .filter((d): d is DriftDismissal => d !== null);
    }

    /**
     * Dismiss one live finding. `report` is a fresh read taken for this call: the
     * finding must be in it, and it must still be the state the operator saw
     * (`seen`), so a finding that changed after the click is never hidden unseen.
     * A live finding no check has recorded yet gets its own open row to carry the
     * dismissal; no other finding on the stack is read or changed. A stronger
     * dismissal that still covers the finding is kept, not weakened by a second
     * click.
     */
    dismissFinding(
        nodeId: number,
        stackName: string,
        report: StackDriftReport,
        key: ParsedDriftKey,
        seen: { fingerprint: string; count: number },
        request: DriftDismissRequest,
    ): DriftDismissOutcome {
        // Without an authoritative read there is no way to say the finding exists.
        if (report.status === 'unreachable' || report.parseError) {
            return { ok: false, code: 'EVIDENCE_UNAVAILABLE' };
        }
        const live = report.findings.find(f => f.kind === key.kind && f.service === key.service);
        if (!live) return { ok: false, code: 'FINDING_GONE' };
        const facts = driftFindingFacts(live);
        if (facts.fingerprint !== seen.fingerprint || facts.count !== seen.count) {
            return { ok: false, code: 'FINDING_CHANGED' };
        }

        const db = DatabaseService.getInstance();
        let recorded = false;
        const outcome = db.getDb().transaction((): DriftDismissOutcome => {
            // Only this finding's own row is touched. The snapshot may already be
            // behind a concurrent check, so it must never resolve or insert siblings.
            let row = db.getOpenDriftFindingByKey(nodeId, stackName, key.service, key.kind);
            if (!row) {
                const id = insertFindingRow(db, nodeId, stackName, live, request.now);
                row = db.getDriftFinding(id);
                recorded = true;
            }
            if (!row) return { ok: false, code: 'FINDING_GONE' };
            const existing = toDriftDismissal(row);
            if (
                existing
                && existing.fingerprint === facts.fingerprint
                && existing.count >= facts.count
                && holdRank(existing.mode, existing.expiresAt, request.now) > holdRank(request.mode, request.expiresAt, request.now)
            ) {
                return { ok: true, dismissal: existing, kept: true };
            }
            db.setDriftFindingDismissal(row.id, {
                by: request.createdBy,
                at: request.now,
                fingerprint: facts.fingerprint,
                mode: request.mode,
                expiresAt: request.expiresAt,
                count: facts.count,
            });
            const written = db.getDriftFinding(row.id);
            const dismissal = written ? toDriftDismissal(written) : null;
            if (!dismissal) throw new Error('A dismissal was written but could not be read back');
            return { ok: true, dismissal, kept: false };
        })();
        if (recorded) {
            this.recordActivity(nodeId, stackName, 'drift_detected', 'warning',
                `Drift detected on ${stackName}: 1 new finding`, request.now);
        }
        return outcome;
    }

    /**
     * Clear a dismissal. False when the row is not one of this stack's, so one
     * stack's permission can never restore another's finding; true when it is
     * clear afterwards (including when it already was).
     */
    restoreDismissal(nodeId: number, stackName: string, id: number): boolean {
        const db = DatabaseService.getInstance();
        const row = db.getDriftFinding(id);
        if (!row || row.node_id !== nodeId || row.stack_name !== stackName) return false;
        db.clearDriftFindingDismissal(id);
        return true;
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
