import path from 'path';
import { promises as fsPromises } from 'fs';
import axios, { AxiosError } from 'axios';
import {
    DatabaseService,
    type Blueprint,
    type BlueprintDeployment,
    type BlueprintDeploymentStatus,
    type Node,
} from './DatabaseService';
import { ComposeService } from './ComposeService';
import { StackOpLockService, stackOpSkipMessage, type StackOpAction } from './StackOpLockService';
import { DeployedStackDeletionService } from './DeployedStackDeletionService';
import { FileSystemService } from './FileSystemService';
import { NodeRegistry } from './NodeRegistry';
import { PROXY_TIER_HEADER, deployProvenanceHeaders } from './license-headers';
import { LicenseService } from './LicenseService';
import { assertPolicyGateAllows, buildSystemPolicyGateOptions, describePolicyBlock, triggerPostDeployScan } from '../helpers/policyGate';
import { prepareOutboundRegistryDeliveryBody } from '../helpers/registryDeliveryOutbound';
import { getRegistryDeliveryLockContext } from '../helpers/registryDeliveryContext';
import { enforcePolicyForImageRefs } from './PolicyEnforcement';
import { BlueprintAnalyzer } from './BlueprintAnalyzer';
import { sanitizeForLog } from '../utils/safeLog';
import { isPathWithinBase } from '../utils/validation';
import {
    BLUEPRINT_MARKER_FILENAME,
    parseBlueprintMarker,
    type BlueprintMarker,
} from '../helpers/blueprintMarker';
import {
    commitBlueprintDeploymentCause,
    commitBlueprintDeploymentRemoved,
    type BlueprintDeploymentCause,
} from './gitops/blueprintDeploymentProducers';
/** On-disk compose name for Blueprint applies. Must match createStack scaffold and Sencho discovery priority. */
const COMPOSE_FILENAME = 'compose.yaml';
const REMOTE_HTTP_TIMEOUT_MS = 30_000;

function isDeveloperModeEnabled(): boolean {
    try {
        return DatabaseService.getInstance().getGlobalSettings().developer_mode === '1';
    } catch {
        return false;
    }
}

function diagnosticLog(message: string, fields: Record<string, string | number | boolean | null | undefined>): void {
    if (!isDeveloperModeEnabled()) return;
    const safeFields = Object.fromEntries(
        Object.entries(fields).map(([key, value]) => [key, typeof value === 'string' ? sanitizeForLog(value) : value]),
    );
    console.info(`[BlueprintService:diag] ${message}`, safeFields);
}

export type { BlueprintMarker };

export class BlueprintNameConflictError extends Error {
    readonly code = 'name_conflict' as const;
    constructor(message: string) {
        super(message);
        this.name = 'BlueprintNameConflictError';
    }
}

/** Thrown when a remote node lacks the atomic apply/withdraw endpoints. */
export class BlueprintRemoteUpgradeRequiredError extends Error {
    readonly code = 'remote_upgrade_required' as const;
    constructor(message: string) {
        super(message);
        this.name = 'BlueprintRemoteUpgradeRequiredError';
    }
}

/** Thrown when ownership cannot be verified (non-ENOENT I/O or remote probe failure). */
export class BlueprintOwnershipProbeError extends Error {
    readonly code = 'ownership_probe_failed' as const;
    constructor(message: string) {
        super(message);
        this.name = 'BlueprintOwnershipProbeError';
    }
}

export interface DeployOutcome {
    status: BlueprintDeploymentStatus;
    error?: string;
}

type LocalMarkerRead =
    | { kind: 'missing' }
    | { kind: 'present'; marker: BlueprintMarker }
    | { kind: 'failed'; error: string };

/**
 * BlueprintService is the orchestration layer between the reconciler and the
 * concrete deploy/withdraw primitives. It owns:
 *   - per-target marker-file management (writes, reads, validates ownership)
 *   - name-conflict guard (refuses apply/withdraw when the directory lacks a matching
 *     `.blueprint.json` for this blueprint ID)
 *   - local deploy via ComposeService + FileSystemService
 *   - remote deploy via direct HTTP calls to the remote Sencho instance
 *   - per-(blueprint,node) concurrency lock so overlapping ticks don't collide
 *
 * The reconciler decides *what* needs to happen; this service performs it.
 */
export class BlueprintService {
    private static instance: BlueprintService | null = null;
    private readonly inflight = new Set<string>();

    static getInstance(): BlueprintService {
        if (!BlueprintService.instance) {
            BlueprintService.instance = new BlueprintService();
        }
        return BlueprintService.instance;
    }

    private constructor() { /* singleton */ }

    private lockKey(blueprintId: number, nodeId: number): string {
        return `${blueprintId}:${nodeId}`;
    }

    private acquireLock(blueprintId: number, nodeId: number): boolean {
        const key = this.lockKey(blueprintId, nodeId);
        if (this.inflight.has(key)) return false;
        this.inflight.add(key);
        return true;
    }

    private releaseLock(blueprintId: number, nodeId: number): void {
        this.inflight.delete(this.lockKey(blueprintId, nodeId));
    }

    private buildMarker(blueprint: Blueprint): BlueprintMarker {
        return {
            blueprintId: blueprint.id,
            revision: blueprint.revision,
            lastApplied: Date.now(),
        };
    }

    /**
     * Write the deployment row, recording what caused the move.
     *
     * The cause is explicit because it cannot be recovered from the status: a
     * deploy that failed and a withdraw that failed both land on `failed`, and
     * they mean opposite things about whether the deployment is still there.
     */
    private setStatus(
        blueprintId: number,
        nodeId: number,
        status: BlueprintDeploymentStatus,
        cause: BlueprintDeploymentCause,
        extras: Partial<{
            applied_revision: number | null;
            last_deployed_at: number | null;
            last_drift_at: number | null;
            drift_summary: string | null;
            last_error: string | null;
        }> = {},
    ): BlueprintDeployment {
        return commitBlueprintDeploymentCause(cause, blueprintId, nodeId, {
            status,
            last_checked_at: Date.now(),
            ...extras,
        }, null);
    }

    /**
     * Read the marker file from a target node. Returns null when missing,
     * malformed, or unreadable. The reconciler treats null as "we do not
     * own this directory" and refuses to touch it.
     */
    async readMarker(blueprintName: string, node: Node): Promise<BlueprintMarker | null> {
        try {
            if (node.type === 'local') {
                const markerRead = await this.readLocalMarkerFromDisk(node.id, blueprintName);
                return markerRead.kind === 'present' ? markerRead.marker : null;
            }
            const target = NodeRegistry.getInstance().getProxyTarget(node.id);
            if (!target) return null;
            const url = `${target.apiUrl.replace(/\/$/, '')}/api/stacks/${encodeURIComponent(blueprintName)}/files/content?path=${encodeURIComponent(BLUEPRINT_MARKER_FILENAME)}`;
            const res = await axios.get(url, {
                headers: this.remoteHeaders(target.apiToken),
                timeout: REMOTE_HTTP_TIMEOUT_MS,
                validateStatus: () => true,
            });
            if (res.status !== 200) return null;
            const body = res.data;
            const content = typeof body === 'string' ? body : (typeof body?.content === 'string' ? body.content : null);
            if (content == null) return null;
            return parseBlueprintMarker(content);
        } catch {
            return null;
        }
    }

    /**
     * Returns true when a stack directory by this name exists on the target
     * node and the on-disk marker is missing, malformed, or references a
     * different blueprint ID. Throws BlueprintOwnershipProbeError when the
     * directory or marker cannot be probed (non-ENOENT I/O or remote list failure).
     */
    async hasNameConflict(blueprintName: string, node: Node, blueprintId: number): Promise<boolean> {
        if (node.type === 'local') {
            const baseDir = NodeRegistry.getInstance().getComposeDir(node.id);
            const stackDir = path.resolve(baseDir, blueprintName);
            if (!isPathWithinBase(stackDir, baseDir)) return true;
            try {
                const stat = await fsPromises.stat(stackDir);
                if (!stat.isDirectory()) return false;
            } catch (err) {
                const code = (err as NodeJS.ErrnoException).code;
                if (code === 'ENOENT') return false;
                throw BlueprintService.ownershipProbeError(blueprintName, BlueprintService.formatError(err));
            }
            const markerRead = await this.readLocalMarkerFromDisk(node.id, blueprintName);
            if (markerRead.kind === 'failed') {
                throw BlueprintService.ownershipProbeError(blueprintName, markerRead.error);
            }
            return markerRead.kind === 'missing' || markerRead.marker.blueprintId !== blueprintId;
        }
        const target = NodeRegistry.getInstance().getProxyTarget(node.id);
        if (!target) {
            throw new BlueprintOwnershipProbeError(
                `Cannot verify stack ownership on remote node "${node.name}": no proxy target configured`,
            );
        }
        const baseUrl = target.apiUrl.replace(/\/$/, '');
        let listRes;
        try {
            listRes = await axios.get(`${baseUrl}/api/stacks`, {
                headers: this.remoteHeaders(target.apiToken),
                timeout: REMOTE_HTTP_TIMEOUT_MS,
                validateStatus: () => true,
            });
        } catch (err) {
            throw new BlueprintOwnershipProbeError(
                `Cannot verify stack ownership on remote node "${node.name}": ${BlueprintService.formatError(err)}`,
            );
        }
        if (listRes.status !== 200) {
            throw new BlueprintOwnershipProbeError(
                `Cannot verify stack ownership on remote node "${node.name}" (HTTP ${listRes.status})`,
            );
        }
        const stacks = Array.isArray(listRes.data) ? listRes.data as Array<{ name?: string }> : [];
        const exists = stacks.some(s => s?.name === blueprintName);
        if (!exists) return false;
        const marker = await this.readMarker(blueprintName, node);
        return marker == null || marker.blueprintId !== blueprintId;
    }

    /** Read and parse a local on-disk marker without going through the remote HTTP path. */
    private async readLocalMarkerFromDisk(nodeId: number, stackName: string): Promise<LocalMarkerRead> {
        try {
            // Canonical js/path-injection barrier inline with the read sink.
            const baseResolved = path.resolve(NodeRegistry.getInstance().getComposeDir(nodeId));
            const safePath = path.resolve(baseResolved, stackName, BLUEPRINT_MARKER_FILENAME);
            if (!safePath.startsWith(baseResolved + path.sep)) {
                return { kind: 'failed', error: 'Invalid stack path for blueprint marker' };
            }
            const content = await fsPromises.readFile(safePath, 'utf-8');
            const marker = parseBlueprintMarker(content);
            if (!marker) return { kind: 'missing' };
            return { kind: 'present', marker };
        } catch (err) {
            const code = (err as NodeJS.ErrnoException).code;
            if (code === 'ENOENT') return { kind: 'missing' };
            return { kind: 'failed', error: BlueprintService.formatError(err) };
        }
    }

    /**
     * Deploy this blueprint to the given target node. Caller must have already
     * resolved that the target should receive this blueprint (selector match
     * passed, no state-review pending, etc.). This method handles the
     * name-conflict guard and the local/remote dispatch.
     */
    async deployToNode(blueprint: Blueprint, node: Node): Promise<DeployOutcome> {
        if (!this.acquireLock(blueprint.id, node.id)) {
            return { status: 'pending' };
        }
        const started = Date.now();
        console.info('[BlueprintService] deploy start blueprint=%s node=%s type=%s revision=%s',
            sanitizeForLog(blueprint.name), node.id, node.type, blueprint.revision);
        diagnosticLog('deploy inputs', {
            blueprintId: blueprint.id,
            blueprintName: blueprint.name,
            nodeId: node.id,
            nodeType: node.type,
            revision: blueprint.revision,
            classification: blueprint.classification,
            driftMode: blueprint.drift_mode,
        });
        try {
            this.setStatus(blueprint.id, node.id, 'deploying', 'deploy_start');
            if (await this.hasNameConflict(blueprint.name, node, blueprint.id)) {
                this.setStatus(blueprint.id, node.id, 'name_conflict', 'name_conflict', {
                    last_error: `A stack named "${blueprint.name}" already exists on this node and is not managed by Sencho.`,
                });
                console.warn('[BlueprintService] deploy name conflict blueprint=%s node=%s durationMs=%s',
                    sanitizeForLog(blueprint.name), node.id, Date.now() - started);
                return { status: 'name_conflict', error: 'name_conflict' };
            }
            const marker = this.buildMarker(blueprint);
            if (node.type === 'local') {
                diagnosticLog('deploy branch', { blueprintId: blueprint.id, nodeId: node.id, target: 'local' });
                await this.deployLocal(blueprint, node, marker);
            } else {
                diagnosticLog('deploy branch', { blueprintId: blueprint.id, nodeId: node.id, target: 'remote' });
                await this.deployRemote(blueprint, node, marker);
            }
            this.setStatus(blueprint.id, node.id, 'active', 'deploy_ack', {
                applied_revision: blueprint.revision,
                last_deployed_at: Date.now(),
                last_drift_at: null,
                drift_summary: null,
                last_error: null,
            });
            console.info('[BlueprintService] deploy complete blueprint=%s node=%s durationMs=%s',
                sanitizeForLog(blueprint.name), node.id, Date.now() - started);
            return { status: 'active' };
        } catch (err) {
            if (err instanceof BlueprintNameConflictError) {
                this.setStatus(blueprint.id, node.id, 'name_conflict', 'name_conflict', { last_error: err.message });
                console.warn('[BlueprintService] deploy name conflict blueprint=%s node=%s durationMs=%s',
                    sanitizeForLog(blueprint.name), node.id, Date.now() - started);
                return { status: 'name_conflict', error: 'name_conflict' };
            }
            const message = BlueprintService.formatError(err);
            this.setStatus(blueprint.id, node.id, 'failed', 'deploy_fail', { last_error: message });
            console.error('[BlueprintService] deploy failed blueprint=%s node=%s durationMs=%s error=%s',
                sanitizeForLog(blueprint.name), node.id, Date.now() - started, sanitizeForLog(message));
            return { status: 'failed', error: message };
        } finally {
            this.releaseLock(blueprint.id, node.id);
        }
    }

    /**
     * Withdraw a blueprint from the target node: docker compose down, delete
     * the directory. Caller must have already cleared the eviction guard
     * (stateful blueprints require explicit operator confirmation).
     */
    async withdrawFromNode(blueprint: Blueprint, node: Node): Promise<DeployOutcome> {
        if (!this.acquireLock(blueprint.id, node.id)) {
            return { status: 'pending' };
        }
        const started = Date.now();
        console.info('[BlueprintService] withdraw start blueprint=%s node=%s type=%s',
            sanitizeForLog(blueprint.name), node.id, node.type);
        diagnosticLog('withdraw inputs', {
            blueprintId: blueprint.id,
            blueprintName: blueprint.name,
            nodeId: node.id,
            nodeType: node.type,
            classification: blueprint.classification,
        });
        try {
            this.setStatus(blueprint.id, node.id, 'withdrawing', 'withdraw_start');
            // Ownership is validated on the node that owns the stack, inside the delete lock.
            if (node.type === 'local') {
                diagnosticLog('withdraw branch', { blueprintId: blueprint.id, nodeId: node.id, target: 'local' });
                const localOutcome = await this.withdrawLocal(blueprint, node);
                if (localOutcome.status !== 'withdrawn') return localOutcome;
            } else {
                diagnosticLog('withdraw branch', { blueprintId: blueprint.id, nodeId: node.id, target: 'remote' });
                const remoteOutcome = await this.withdrawRemote(blueprint, node);
                if (remoteOutcome.status !== 'withdrawn') return remoteOutcome;
            }
            commitBlueprintDeploymentRemoved(blueprint.id, node.id, null);
            console.info('[BlueprintService] withdraw complete blueprint=%s node=%s durationMs=%s',
                sanitizeForLog(blueprint.name), node.id, Date.now() - started);
            return { status: 'withdrawn' };
        } catch (err) {
            const message = BlueprintService.formatError(err);
            this.setStatus(blueprint.id, node.id, 'failed', 'withdraw_fail', { last_error: `withdraw failed: ${message}` });
            console.error('[BlueprintService] withdraw failed blueprint=%s node=%s durationMs=%s error=%s',
                sanitizeForLog(blueprint.name), node.id, Date.now() - started, sanitizeForLog(message));
            return { status: 'failed', error: message };
        } finally {
            this.releaseLock(blueprint.id, node.id);
        }
    }

    /**
     * Inspect the actual state of a deployment on its node and report
     * whether it has drifted from the desired state. The reconciler decides
     * what to do with the result based on drift_mode.
     */
    async checkForDrift(blueprint: Blueprint, node: Node): Promise<{ drifted: boolean; reason?: string }> {
        try {
            const marker = await this.readMarker(blueprint.name, node);
            if (!marker) {
                return { drifted: true, reason: 'marker file missing on node' };
            }
            if (marker.blueprintId !== blueprint.id) {
                return { drifted: true, reason: 'marker references a different blueprint' };
            }
            if (marker.revision !== blueprint.revision) {
                return { drifted: true, reason: `revision drift (node has ${marker.revision}, blueprint is ${blueprint.revision})` };
            }
            // Check container state
            const containerState = await this.containerHealth(blueprint.name, node);
            if (!containerState.allRunning) {
                return { drifted: true, reason: containerState.detail };
            }
            return { drifted: false };
        } catch (err) {
            return { drifted: true, reason: BlueprintService.formatError(err) };
        }
    }

    private async containerHealth(blueprintName: string, node: Node): Promise<{ allRunning: boolean; detail: string }> {
        try {
            // Docker Compose normalizes the project name to lowercase. Match the same canonical form.
            const projectName = blueprintName.toLowerCase();
            if (node.type === 'local') {
                const docker = NodeRegistry.getInstance().getDocker(node.id);
                const containers = await docker.listContainers({
                    all: true,
                    filters: { label: [`com.docker.compose.project=${projectName}`] },
                });
                if (containers.length === 0) return { allRunning: false, detail: 'no containers running for this blueprint' };
                const notRunning = containers.filter(c => c.State !== 'running');
                if (notRunning.length > 0) {
                    const first = notRunning[0];
                    return { allRunning: false, detail: `container "${first.Names[0] ?? first.Id.slice(0, 12)}" is ${first.State}` };
                }
                return { allRunning: true, detail: '' };
            }
            const target = NodeRegistry.getInstance().getProxyTarget(node.id);
            if (!target) return { allRunning: false, detail: 'remote node not reachable (no proxy target)' };
            const url = `${target.apiUrl.replace(/\/$/, '')}/api/stacks/${encodeURIComponent(blueprintName)}/containers`;
            const res = await axios.get(url, {
                headers: this.remoteHeaders(target.apiToken),
                timeout: REMOTE_HTTP_TIMEOUT_MS,
                validateStatus: () => true,
            });
            if (res.status !== 200) {
                return { allRunning: false, detail: `remote stack lookup returned HTTP ${res.status}` };
            }
            const list = Array.isArray(res.data) ? res.data as Array<{ State?: string; Names?: string[]; Id?: string }> : [];
            if (list.length === 0) return { allRunning: false, detail: 'remote stack has no containers' };
            const notRunning = list.filter(c => (c.State ?? '') !== 'running');
            if (notRunning.length > 0) {
                const first = notRunning[0];
                return { allRunning: false, detail: `remote container "${first.Names?.[0] ?? first.Id?.slice(0, 12)}" is ${first.State}` };
            }
            return { allRunning: true, detail: '' };
        } catch (err) {
            return { allRunning: false, detail: BlueprintService.formatError(err) };
        }
    }

    // ---- local primitives ----

    /** Returns whether the stack directory exists. Throws on non-ENOENT I/O. */
    private async stackDirExists(nodeId: number, blueprintName: string): Promise<boolean> {
        // Inline containment barrier at the stat sink. The scanner does not
        // credit the wrapped isPathWithinBase helper, so the check has to sit
        // with the call it protects.
        const baseResolved = path.resolve(NodeRegistry.getInstance().getComposeDir(nodeId));
        const stackDir = path.resolve(baseResolved, blueprintName);
        if (!stackDir.startsWith(baseResolved + path.sep)) {
            throw new BlueprintOwnershipProbeError(`Invalid stack path for "${blueprintName}"`);
        }
        try {
            const stat = await fsPromises.stat(stackDir);
            return stat.isDirectory();
        } catch (err) {
            const code = (err as NodeJS.ErrnoException).code;
            if (code === 'ENOENT') return false;
            throw new BlueprintOwnershipProbeError(
                `Cannot access stack directory "${blueprintName}": ${BlueprintService.formatError(err)}`,
            );
        }
    }

    private async deployLocal(blueprint: Blueprint, node: Node, marker: BlueprintMarker): Promise<void> {
        const imageRefs = BlueprintAnalyzer.extractImageRefs(blueprint.compose_content);
        const gate = await enforcePolicyForImageRefs(blueprint.name, node.id, imageRefs, {
            bypass: false,
            actor: 'blueprint-reconciler',
            auditMethod: 'POST',
            auditPath: `/api/blueprints/${blueprint.id}/apply`,
        }, undefined, true);
        if (!gate.ok) {
            throw new Error(describePolicyBlock(gate.policy, gate.violations));
        }

        const outcome = await this.applyLocalUnderLock(
            node.id,
            blueprint.name,
            blueprint.compose_content,
            JSON.stringify(marker, null, 2),
            `/api/blueprints/${blueprint.id}/deployments/${node.id}`,
        );
        if (!outcome.ran) {
            throw new Error(stackOpSkipMessage(blueprint.name, outcome.existingAction));
        }
        triggerPostDeployScan(blueprint.name, node.id).catch(err => {
            console.error('[BlueprintService] post-deploy scan failed for "%s" on node %s: %s',
                sanitizeForLog(blueprint.name), node.id, sanitizeForLog(BlueprintService.formatError(err)));
        });
    }

    /**
     * Create the stack if needed, write the compose file, run the deploy policy
     * gate and deploy, then write the marker, all under the per-stack operation
     * lock. The marker is written only after a successful deploy so a failed
     * apply cannot claim an applied revision that never ran. Runs on the node
     * that owns the stack: deployLocal calls it for the hub's own node, and the
     * /api/blueprints/apply-local route calls it on a remote node receiving a
     * blueprint apply from its hub. On lock conflict nothing is written and
     * { ran: false } is returned.
     */
    async applyLocalUnderLock(
        nodeId: number,
        stackName: string,
        composeContent: string,
        markerContent: string,
        auditPath: string,
    ): Promise<{ ran: true } | { ran: false; existingAction: StackOpAction }> {
        const expected = parseBlueprintMarker(markerContent);
        if (!expected) {
            throw new Error('Invalid blueprint marker');
        }
        const fs = FileSystemService.getInstance(nodeId);
        const lock = await StackOpLockService.getInstance().runExclusive(
            nodeId, stackName, 'deploy', 'system',
            async () => {
                let createdStack = false;
                if (await this.stackDirExists(nodeId, stackName)) {
                    const existing = await this.readLocalMarkerFromDisk(nodeId, stackName);
                    if (existing.kind === 'failed') {
                        throw new BlueprintOwnershipProbeError(
                            `Cannot verify ownership of stack "${stackName}": ${existing.error}`,
                        );
                    }
                    if (existing.kind === 'missing' || existing.marker.blueprintId !== expected.blueprintId) {
                        throw new BlueprintNameConflictError(
                            `A stack named "${stackName}" already exists on this node and is not managed by this blueprint.`,
                        );
                    }
                } else {
                    await fs.createStack(stackName);
                    createdStack = true;
                }
                let previousComposeContent: string | null = null;
                if (!createdStack) {
                    const prior = await fs.readStackFile(stackName, COMPOSE_FILENAME);
                    if (prior.oversized || prior.binary || prior.content === undefined) {
                        throw new Error(
                            `Cannot snapshot existing compose for blueprint apply on "${stackName}"`,
                        );
                    }
                    previousComposeContent = prior.content;
                }
                await fs.writeStackFile(stackName, COMPOSE_FILENAME, composeContent);
                // Clear lower-priority compose siblings so discovery cannot shadow compose.yaml.
                await fs.removeAlternateRootComposeFiles(stackName);
                try {
                    await assertPolicyGateAllows(
                        stackName,
                        nodeId,
                        buildSystemPolicyGateOptions('blueprint', { auditPath }),
                    );
                    await ComposeService.getInstance(nodeId).deployStack(
                        stackName,
                        undefined,
                        false,
                        { source: 'blueprint', actor: 'system:blueprint' },
                    );
                    await fs.writeStackFile(stackName, BLUEPRINT_MARKER_FILENAME, markerContent);
                } catch (err) {
                    if (createdStack) {
                        try {
                            await fs.deleteStack(stackName);
                        } catch (cleanupErr) {
                            console.warn(
                                '[BlueprintService] Failed to roll back newly created stack "%s" after apply error: %s',
                                sanitizeForLog(stackName),
                                sanitizeForLog(BlueprintService.formatError(cleanupErr)),
                            );
                        }
                    } else if (previousComposeContent !== null) {
                        try {
                            await fs.writeStackFile(stackName, COMPOSE_FILENAME, previousComposeContent);
                        } catch (restoreErr) {
                            console.warn(
                                '[BlueprintService] Failed to restore prior compose for "%s" after apply error: %s',
                                sanitizeForLog(stackName),
                                sanitizeForLog(BlueprintService.formatError(restoreErr)),
                            );
                        }
                    }
                    throw err;
                }
            },
            getRegistryDeliveryLockContext(),
        );
        return lock.ran ? { ran: true } : { ran: false, existingAction: lock.existing.action };
    }

    private async withdrawLocal(blueprint: Blueprint, node: Node): Promise<DeployOutcome> {
        const result = await DeployedStackDeletionService.getInstance().deleteDeployedStack({
            nodeId: node.id,
            stackName: blueprint.name,
            pruneVolumes: false,
            actor: 'system:blueprint',
            requireBlueprintId: blueprint.id,
        });
        if (result.ok) {
            return { status: 'withdrawn' };
        }
        if (result.code === 'name_conflict') {
            this.setStatus(blueprint.id, node.id, 'name_conflict', 'withdraw_name_conflict', { last_error: result.error });
            return { status: 'name_conflict' };
        }
        this.setStatus(blueprint.id, node.id, 'failed', 'withdraw_fail', { last_error: result.error });
        return { status: 'failed', error: result.error };
    }

    // ---- remote primitives ----

    private remoteHeaders(apiToken: string): Record<string, string> {
        const proxy = LicenseService.getInstance().getProxyHeaders();
        return {
            Authorization: `Bearer ${apiToken}`,
            [PROXY_TIER_HEADER]: proxy.tier,
            'Content-Type': 'application/json',
            ...deployProvenanceHeaders('blueprint', 'system:blueprint'),
        };
    }

    private async deployRemote(blueprint: Blueprint, node: Node, marker: BlueprintMarker): Promise<void> {
        const target = NodeRegistry.getInstance().getProxyTarget(node.id);
        if (!target) throw new Error(`Remote node "${node.name}" has no proxy target configured`);
        const baseUrl = target.apiUrl.replace(/\/$/, '');
        const headers = this.remoteHeaders(target.apiToken);

        const applyBody = {
            stackName: blueprint.name,
            composeContent: blueprint.compose_content,
            markerContent: JSON.stringify(marker, null, 2),
        };
        const augmented = await prepareOutboundRegistryDeliveryBody({
            method: 'POST',
            apiPath: '/api/blueprints/apply-local',
            nodeId: node.id,
            body: applyBody,
        });
        if (!augmented.ok) {
            throw new Error(augmented.error);
        }

        // Atomic apply: the remote validates ownership and writes under its stack lock.
        const res = await axios.post(
            `${baseUrl}/api/blueprints/apply-local`,
            augmented.body,
            { headers, timeout: REMOTE_HTTP_TIMEOUT_MS, validateStatus: () => true },
        );
        if (res.status === 404) {
            throw new BlueprintRemoteUpgradeRequiredError(
                `Remote node "${node.name}" does not support atomic blueprint apply (/api/blueprints/apply-local). Upgrade that Sencho instance, then retry.`,
            );
        }
        if (res.status === 409) {
            if (BlueprintService.extractApiCode(res.data) === 'name_conflict') {
                throw new BlueprintNameConflictError(
                    BlueprintService.extractApiError(res.data)
                    || `A stack named "${blueprint.name}" already exists on this node and is not managed by this blueprint.`,
                );
            }
            throw new Error(`blueprint apply skipped: ${BlueprintService.extractApiError(res.data) || 'another operation is already in progress'}`);
        }
        if (res.status >= 400) {
            throw new Error(`blueprint apply: HTTP ${res.status} ${BlueprintService.extractApiError(res.data)}`);
        }
    }

    private async withdrawRemote(blueprint: Blueprint, node: Node): Promise<DeployOutcome> {
        const target = NodeRegistry.getInstance().getProxyTarget(node.id);
        if (!target) throw new Error(`Remote node "${node.name}" has no proxy target configured`);
        const baseUrl = target.apiUrl.replace(/\/$/, '');
        const headers = this.remoteHeaders(target.apiToken);

        let res;
        try {
            res = await axios.post(
                `${baseUrl}/api/blueprints/withdraw-local`,
                { stackName: blueprint.name, blueprintId: blueprint.id },
                { headers, timeout: REMOTE_HTTP_TIMEOUT_MS, validateStatus: () => true },
            );
        } catch (err) {
            const message = BlueprintService.formatError(err);
            this.setStatus(blueprint.id, node.id, 'failed', 'withdraw_fail', { last_error: message });
            return { status: 'failed', error: message };
        }

        if (res.status === 404) {
            throw new BlueprintRemoteUpgradeRequiredError(
                `Remote node "${node.name}" does not support atomic blueprint withdraw (/api/blueprints/withdraw-local). Upgrade that Sencho instance, then retry.`,
            );
        }
        if (res.status === 200) {
            DatabaseService.getInstance().deleteRoleAssignmentsByStack(node.id, blueprint.name);
            return { status: 'withdrawn' };
        }
        if (res.status === 409) {
            const error = BlueprintService.extractApiError(res.data) || 'withdraw refused';
            if (BlueprintService.extractApiCode(res.data) === 'name_conflict') {
                this.setStatus(blueprint.id, node.id, 'name_conflict', 'withdraw_name_conflict', { last_error: error });
                return { status: 'name_conflict' };
            }
            // stack_op_in_progress and any other 409: match local withdraw lock-conflict → failed
            this.setStatus(blueprint.id, node.id, 'failed', 'withdraw_fail', { last_error: error });
            return { status: 'failed', error };
        }
        const message = `blueprint withdraw: HTTP ${res.status} ${BlueprintService.extractApiError(res.data)}`;
        this.setStatus(blueprint.id, node.id, 'failed', 'withdraw_fail', { last_error: message });
        return { status: 'failed', error: message };
    }

    static parseMarker(content: string): BlueprintMarker | null {
        return parseBlueprintMarker(content);
    }

    private static ownershipProbeError(blueprintName: string, detail: string): BlueprintOwnershipProbeError {
        return new BlueprintOwnershipProbeError(
            `Cannot verify stack ownership for "${blueprintName}": ${detail}`,
        );
    }

    static extractApiCode(body: unknown): string {
        if (!body || typeof body !== 'object') return '';
        const code = (body as Record<string, unknown>).code;
        return typeof code === 'string' ? code : '';
    }

    static formatError(err: unknown): string {
        if (axios.isAxiosError(err)) {
            const ax = err as AxiosError<{ error?: string; message?: string }>;
            if (ax.response?.data) {
                const body = ax.response.data;
                if (body && typeof body === 'object') {
                    if (typeof body.error === 'string') return body.error;
                    if (typeof body.message === 'string') return body.message;
                }
            }
            if (ax.code) return `${ax.code}: ${ax.message}`;
            return ax.message;
        }
        if (err instanceof Error) return err.message;
        return String(err);
    }

    static extractApiError(body: unknown): string {
        if (!body || typeof body !== 'object') return '';
        const obj = body as Record<string, unknown>;
        if (typeof obj.error === 'string') return obj.error;
        if (typeof obj.message === 'string') return obj.message;
        return '';
    }
}
