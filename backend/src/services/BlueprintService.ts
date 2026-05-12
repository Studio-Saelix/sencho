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
import { FileSystemService } from './FileSystemService';
import { NodeRegistry } from './NodeRegistry';
import { PROXY_TIER_HEADER, PROXY_VARIANT_HEADER } from './license-headers';
import { LicenseService } from './LicenseService';
import { assertPolicyGateAllows, buildSystemPolicyGateOptions, triggerPostDeployScan } from '../helpers/policyGate';
import { enforcePolicyForImageRefs } from './PolicyEnforcement';
import { BlueprintAnalyzer } from './BlueprintAnalyzer';
import { sanitizeForLog } from '../utils/safeLog';

const MARKER_FILENAME = '.blueprint.json';
const COMPOSE_FILENAME = 'docker-compose.yml';
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

export interface BlueprintMarker {
    blueprintId: number;
    revision: number;
    lastApplied: number;
}

export interface DeployOutcome {
    status: BlueprintDeploymentStatus;
    error?: string;
}

/**
 * BlueprintService is the orchestration layer between the reconciler and the
 * concrete deploy/withdraw primitives. It owns:
 *   - per-target marker-file management (writes, reads, validates ownership)
 *   - name-conflict guard (refuses to touch a stack directory missing the marker)
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

    private setStatus(
        blueprintId: number,
        nodeId: number,
        status: BlueprintDeploymentStatus,
        extras: Partial<{
            applied_revision: number | null;
            last_deployed_at: number | null;
            last_drift_at: number | null;
            drift_summary: string | null;
            last_error: string | null;
        }> = {},
    ): BlueprintDeployment {
        return DatabaseService.getInstance().upsertDeployment({
            blueprint_id: blueprintId,
            node_id: nodeId,
            status,
            last_checked_at: Date.now(),
            ...extras,
        });
    }

    /**
     * Read the marker file from a target node. Returns null when missing,
     * malformed, or unreadable. The reconciler treats null as "we do not
     * own this directory" and refuses to touch it.
     */
    async readMarker(blueprintName: string, node: Node): Promise<BlueprintMarker | null> {
        try {
            if (node.type === 'local') {
                const baseDir = NodeRegistry.getInstance().getComposeDir(node.id);
                const markerPath = path.resolve(baseDir, blueprintName, MARKER_FILENAME);
                if (!markerPath.startsWith(path.resolve(baseDir))) return null;
                const content = await fsPromises.readFile(markerPath, 'utf-8');
                return BlueprintService.parseMarker(content);
            }
            const target = NodeRegistry.getInstance().getProxyTarget(node.id);
            if (!target) return null;
            const url = `${target.apiUrl.replace(/\/$/, '')}/api/stacks/${encodeURIComponent(blueprintName)}/files/content?path=${encodeURIComponent(MARKER_FILENAME)}`;
            const res = await axios.get(url, {
                headers: this.remoteHeaders(target.apiToken),
                timeout: REMOTE_HTTP_TIMEOUT_MS,
                validateStatus: () => true,
            });
            if (res.status !== 200) return null;
            const body = res.data;
            const content = typeof body === 'string' ? body : (typeof body?.content === 'string' ? body.content : null);
            if (content == null) return null;
            return BlueprintService.parseMarker(content);
        } catch {
            return null;
        }
    }

    /**
     * Returns true when a stack directory by this name exists on the target
     * node but does not carry our marker file. The reconciler must not
     * deploy in that case: there is a real user-authored stack with the
     * same name and we must not overwrite it.
     */
    async hasNameConflict(blueprintName: string, node: Node): Promise<boolean> {
        try {
            if (node.type === 'local') {
                const baseDir = NodeRegistry.getInstance().getComposeDir(node.id);
                const stackDir = path.resolve(baseDir, blueprintName);
                if (!stackDir.startsWith(path.resolve(baseDir))) return true;
                try {
                    const stat = await fsPromises.stat(stackDir);
                    if (!stat.isDirectory()) return false;
                } catch {
                    return false; // directory doesn't exist → no conflict
                }
                const markerPath = path.join(stackDir, MARKER_FILENAME);
                try {
                    await fsPromises.stat(markerPath);
                    return false; // marker present → ours
                } catch {
                    return true; // directory exists but no marker → conflict
                }
            }
            const target = NodeRegistry.getInstance().getProxyTarget(node.id);
            if (!target) return false;
            const baseUrl = target.apiUrl.replace(/\/$/, '');
            const listUrl = `${baseUrl}/api/stacks`;
            const listRes = await axios.get(listUrl, {
                headers: this.remoteHeaders(target.apiToken),
                timeout: REMOTE_HTTP_TIMEOUT_MS,
                validateStatus: () => true,
            });
            if (listRes.status !== 200) return false;
            const stacks = Array.isArray(listRes.data) ? listRes.data as Array<{ name?: string }> : [];
            const exists = stacks.some(s => s?.name === blueprintName);
            if (!exists) return false;
            const marker = await this.readMarker(blueprintName, node);
            return marker == null;
        } catch {
            return false;
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
            this.setStatus(blueprint.id, node.id, 'deploying');
            if (await this.hasNameConflict(blueprint.name, node)) {
                this.setStatus(blueprint.id, node.id, 'name_conflict', {
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
            this.setStatus(blueprint.id, node.id, 'active', {
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
            const message = BlueprintService.formatError(err);
            this.setStatus(blueprint.id, node.id, 'failed', { last_error: message });
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
            this.setStatus(blueprint.id, node.id, 'withdrawing');
            // Refuse to withdraw a directory we do not own
            const marker = await this.readMarker(blueprint.name, node);
            if (marker && marker.blueprintId !== blueprint.id) {
                this.setStatus(blueprint.id, node.id, 'name_conflict', {
                    last_error: `Marker on this node points to a different blueprint (id=${marker.blueprintId}); refusing to withdraw.`,
                });
                return { status: 'name_conflict' };
            }
            if (node.type === 'local') {
                diagnosticLog('withdraw branch', { blueprintId: blueprint.id, nodeId: node.id, target: 'local' });
                await this.withdrawLocal(blueprint, node);
            } else {
                diagnosticLog('withdraw branch', { blueprintId: blueprint.id, nodeId: node.id, target: 'remote' });
                await this.withdrawRemote(blueprint, node);
            }
            DatabaseService.getInstance().deleteDeployment(blueprint.id, node.id);
            console.info('[BlueprintService] withdraw complete blueprint=%s node=%s durationMs=%s',
                sanitizeForLog(blueprint.name), node.id, Date.now() - started);
            return { status: 'withdrawn' };
        } catch (err) {
            const message = BlueprintService.formatError(err);
            this.setStatus(blueprint.id, node.id, 'failed', { last_error: `withdraw failed: ${message}` });
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

    private async stackDirExists(node: Node, blueprintName: string): Promise<boolean> {
        const baseDir = NodeRegistry.getInstance().getComposeDir(node.id);
        const stackDir = path.resolve(baseDir, blueprintName);
        if (!stackDir.startsWith(path.resolve(baseDir))) return false;
        try {
            const stat = await fsPromises.stat(stackDir);
            return stat.isDirectory();
        } catch {
            return false;
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
            throw new Error(`Policy "${gate.policy?.name}" blocked deploy: ${gate.violations.length} image(s) exceed ${gate.policy?.max_severity}`);
        }

        const fs = FileSystemService.getInstance(node.id);
        if (!(await this.stackDirExists(node, blueprint.name))) {
            await fs.createStack(blueprint.name);
        }
        await fs.writeStackFile(blueprint.name, COMPOSE_FILENAME, blueprint.compose_content);
        await fs.writeStackFile(blueprint.name, MARKER_FILENAME, JSON.stringify(marker, null, 2));
        await assertPolicyGateAllows(
            blueprint.name,
            node.id,
            buildSystemPolicyGateOptions('blueprint', {
                auditPath: `/api/blueprints/${blueprint.id}/deployments/${node.id}`,
            }),
        );
        await ComposeService.getInstance(node.id).deployStack(blueprint.name, undefined, false);
        triggerPostDeployScan(blueprint.name, node.id).catch(err => {
            console.error('[BlueprintService] post-deploy scan failed for "%s" on node %s: %s',
                sanitizeForLog(blueprint.name), node.id, sanitizeForLog(BlueprintService.formatError(err)));
        });
    }

    private async withdrawLocal(blueprint: Blueprint, node: Node): Promise<void> {
        try {
            await ComposeService.getInstance(node.id).downStack(blueprint.name);
        } catch (err) {
            // best-effort: continue to delete the directory even if down fails
            console.warn(`[BlueprintService] downStack failed for "${blueprint.name}" on node ${node.id}: ${BlueprintService.formatError(err)}`);
        }
        if (await this.stackDirExists(node, blueprint.name)) {
            await FileSystemService.getInstance(node.id).deleteStack(blueprint.name);
        }
    }

    // ---- remote primitives ----

    private remoteHeaders(apiToken: string): Record<string, string> {
        const proxy = LicenseService.getInstance().getProxyHeaders();
        return {
            Authorization: `Bearer ${apiToken}`,
            [PROXY_TIER_HEADER]: proxy.tier,
            [PROXY_VARIANT_HEADER]: proxy.variant ?? '',
            'Content-Type': 'application/json',
        };
    }

    private async deployRemote(blueprint: Blueprint, node: Node, marker: BlueprintMarker): Promise<void> {
        const target = NodeRegistry.getInstance().getProxyTarget(node.id);
        if (!target) throw new Error(`Remote node "${node.name}" has no proxy target configured`);
        const baseUrl = target.apiUrl.replace(/\/$/, '');
        const headers = this.remoteHeaders(target.apiToken);

        // 1. Ensure stack exists. POST returns 409 when already exists; we treat that as success.
        const createRes = await axios.post(`${baseUrl}/api/stacks`,
            { stackName: blueprint.name },
            { headers, timeout: REMOTE_HTTP_TIMEOUT_MS, validateStatus: () => true },
        );
        if (createRes.status >= 400 && createRes.status !== 409) {
            throw new Error(`create stack: HTTP ${createRes.status} ${BlueprintService.extractApiError(createRes.data)}`);
        }

        // 2. Write the compose file
        await this.remotePutFile(baseUrl, headers, blueprint.name, COMPOSE_FILENAME, blueprint.compose_content);

        // 3. Write the marker (last so a partial failure leaves us in name_conflict-recoverable state)
        await this.remotePutFile(baseUrl, headers, blueprint.name, MARKER_FILENAME, JSON.stringify(marker, null, 2));

        // 4. Deploy
        const deployRes = await axios.post(
            `${baseUrl}/api/stacks/${encodeURIComponent(blueprint.name)}/deploy`,
            {},
            { headers, timeout: REMOTE_HTTP_TIMEOUT_MS, validateStatus: () => true },
        );
        if (deployRes.status >= 400) {
            throw new Error(`deploy: HTTP ${deployRes.status} ${BlueprintService.extractApiError(deployRes.data)}`);
        }
    }

    private async withdrawRemote(blueprint: Blueprint, node: Node): Promise<void> {
        const target = NodeRegistry.getInstance().getProxyTarget(node.id);
        if (!target) throw new Error(`Remote node "${node.name}" has no proxy target configured`);
        const baseUrl = target.apiUrl.replace(/\/$/, '');
        const headers = this.remoteHeaders(target.apiToken);

        // down (best-effort)
        try {
            await axios.post(
                `${baseUrl}/api/stacks/${encodeURIComponent(blueprint.name)}/down`,
                {},
                { headers, timeout: REMOTE_HTTP_TIMEOUT_MS, validateStatus: () => true },
            );
        } catch (err) {
            console.warn(`[BlueprintService] remote down failed for "${blueprint.name}" on node ${node.id}: ${BlueprintService.formatError(err)}`);
        }

        // delete the stack directory entirely
        const delRes = await axios.delete(
            `${baseUrl}/api/stacks/${encodeURIComponent(blueprint.name)}`,
            { headers, timeout: REMOTE_HTTP_TIMEOUT_MS, validateStatus: () => true },
        );
        if (delRes.status >= 400 && delRes.status !== 404) {
            throw new Error(`remote delete: HTTP ${delRes.status} ${BlueprintService.extractApiError(delRes.data)}`);
        }
    }

    private async remotePutFile(
        baseUrl: string,
        headers: Record<string, string>,
        stackName: string,
        relPath: string,
        content: string,
    ): Promise<void> {
        const url = `${baseUrl}/api/stacks/${encodeURIComponent(stackName)}/files/content?path=${encodeURIComponent(relPath)}`;
        const res = await axios.put(url,
            { content },
            { headers, timeout: REMOTE_HTTP_TIMEOUT_MS, validateStatus: () => true },
        );
        if (res.status >= 400) {
            throw new Error(`PUT ${relPath}: HTTP ${res.status} ${BlueprintService.extractApiError(res.data)}`);
        }
    }

    static parseMarker(content: string): BlueprintMarker | null {
        try {
            const parsed = JSON.parse(content);
            if (parsed && typeof parsed === 'object'
                && typeof parsed.blueprintId === 'number'
                && typeof parsed.revision === 'number') {
                return {
                    blueprintId: parsed.blueprintId,
                    revision: parsed.revision,
                    lastApplied: typeof parsed.lastApplied === 'number' ? parsed.lastApplied : 0,
                };
            }
        } catch {
            // fall through
        }
        return null;
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
