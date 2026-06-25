import { CronExpressionParser } from 'cron-parser';
import { DatabaseService } from './DatabaseService';
import type { ScheduledTask } from './DatabaseService';
import { LicenseService } from './LicenseService';
import { PROXY_TIER_HEADER } from './license-headers';
import DockerController from './DockerController';
import { ComposeService } from './ComposeService';
import { StackOpLockService, stackOpSkipMessage as skipMessage } from './StackOpLockService';
import { FileSystemService } from './FileSystemService';
import { HealthGateService } from './HealthGateService';
import { ImageUpdateService } from './ImageUpdateService';
import type { ImageCheckResult } from './ImageUpdateService';
import { isDebugEnabled } from '../utils/debug';
import { getErrorMessage } from '../utils/errors';
import { sanitizeForLog } from '../utils/safeLog';
import { captureLocalNodeFiles, captureRemoteNodeFiles, buildSnapshotDocumentation, type SnapshotNodeData } from '../utils/snapshot-capture';
import { NodeRegistry } from './NodeRegistry';
import { NotificationService } from './NotificationService';
import TrivyService from './TrivyService';
import type { ScanAllNodeImagesResult } from './TrivyService';
import TrivyInstaller from './TrivyInstaller';
import { CloudBackupService } from './CloudBackupService';
import { buildSystemPolicyGateOptions } from '../helpers/policyGate';
import { enforcePolicyPreDeploy } from './PolicyEnforcement';

const TRIVY_UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const TRIVY_UPDATE_CHECK_STARTUP_DELAY_MS = 5 * 60 * 1000;

const TRIVY_REDETECT_INTERVAL_MS = 10 * 60 * 1000;
const STALE_SCAN_THRESHOLD_MS = 15 * 60 * 1000;

export class SchedulerService {
    private static instance: SchedulerService;
    private intervalId: ReturnType<typeof setInterval> | null = null;
    private trivyUpdateIntervalId: ReturnType<typeof setInterval> | null = null;
    private trivyUpdateStartupTimer: ReturnType<typeof setTimeout> | null = null;
    private isProcessing = false;
    private isCheckingTrivyUpdate = false;
    private runningTasks = new Set<number>();
    private lastTrivyRedetect = 0;

    private constructor() {}

    public static getInstance(): SchedulerService {
        if (!SchedulerService.instance) {
            SchedulerService.instance = new SchedulerService();
        }
        return SchedulerService.instance;
    }

    public start(): void {
        if (this.intervalId) return;
        this.cleanupStaleRuns();
        this.intervalId = setInterval(() => this.tick(), 60_000);
        setTimeout(() => this.tick(), 10_000);
        this.trivyUpdateStartupTimer = setTimeout(() => this.runTrivyUpdateCheck(), TRIVY_UPDATE_CHECK_STARTUP_DELAY_MS);
        this.trivyUpdateIntervalId = setInterval(() => this.runTrivyUpdateCheck(), TRIVY_UPDATE_CHECK_INTERVAL_MS);
        console.log('[SchedulerService] Started');
    }

    public stop(): void {
        if (this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = null;
        }
        if (this.trivyUpdateIntervalId) {
            clearInterval(this.trivyUpdateIntervalId);
            this.trivyUpdateIntervalId = null;
        }
        if (this.trivyUpdateStartupTimer) {
            clearTimeout(this.trivyUpdateStartupTimer);
            this.trivyUpdateStartupTimer = null;
        }
        console.log('[SchedulerService] Stopped');
    }

    private async runTrivyUpdateCheck(): Promise<void> {
        if (this.isCheckingTrivyUpdate) return;
        this.isCheckingTrivyUpdate = true;
        try {
            const trivy = TrivyService.getInstance();
            if (!trivy.isTrivyAvailable() || trivy.getSource() !== 'managed') return;
            const db = DatabaseService.getInstance();
            const settings = db.getGlobalSettings();
            const autoUpdate = settings.trivy_auto_update === '1';
            const installer = TrivyInstaller.getInstance();
            if (installer.isBusy()) return;
            const check = await installer.checkForUpdate(trivy.getVersion(), 'managed');
            if (!check.updateAvailable) return;

            if (autoUpdate) {
                const previous = trivy.getVersion() ?? 'unknown';
                console.log(`[SchedulerService] Auto-updating Trivy from ${previous} to ${check.latest}`);
                try {
                    await installer.update();
                    await trivy.detectTrivy();
                    this.safeDispatch(
                        'info',
                        'system',
                        `Trivy updated from v${previous} to v${check.latest}`,
                    );
                    db.updateGlobalSetting('trivy_last_notified_version', check.latest);
                } catch (err) {
                    console.error('[SchedulerService] Trivy auto-update failed:', getErrorMessage(err, 'unknown error'));
                }
            } else {
                const lastNotified = settings.trivy_last_notified_version || '';
                if (lastNotified === check.latest) return;
                this.safeDispatch(
                    'info',
                    'system',
                    `Trivy update available: v${check.latest} (currently v${check.current ?? 'unknown'})`,
                );
                db.updateGlobalSetting('trivy_last_notified_version', check.latest);
            }
        } catch (err) {
            console.warn('[SchedulerService] Trivy update check failed:', getErrorMessage(err, 'unknown error'));
        } finally {
            this.isCheckingTrivyUpdate = false;
        }
    }

    private cleanupStaleRuns(): void {
        try {
            const count = DatabaseService.getInstance().markStaleRunsAsFailed();
            if (count > 0) {
                console.log(`[SchedulerService] Cleaned up ${count} stale run record(s)`);
            }
        } catch (error) {
            console.error('[SchedulerService] Failed to clean up stale runs:', error);
        }
    }

    private async maybeRedetectTrivy(): Promise<void> {
        const now = Date.now();
        if (now - this.lastTrivyRedetect < TRIVY_REDETECT_INTERVAL_MS) return;
        this.lastTrivyRedetect = now;
        try {
            await TrivyService.getInstance().detectTrivy();
        } catch (error) {
            if (isDebugEnabled()) {
                console.warn('[SchedulerService:debug] Trivy re-detect failed:', error);
            }
        }
    }

    public calculateNextRun(cronExpression: string): number {
        const expr = CronExpressionParser.parse(cronExpression);
        return expr.next().toDate().getTime();
    }

    public calculateRunsWithin(cronExpression: string, fromMs: number, toMs: number, limit = 16): number[] {
        try {
            const expr = CronExpressionParser.parse(cronExpression, { currentDate: new Date(fromMs) });
            const runs: number[] = [];
            while (runs.length < limit) {
                const next = expr.next().toDate().getTime();
                if (next > toMs) break;
                runs.push(next);
            }
            return runs;
        } catch {
            return [];
        }
    }

    /**
     * Fire a notification without awaiting completion, catching any promise
     * rejection so the scheduler never crashes on a failed dispatch.
     */
    private safeDispatch(level: 'info' | 'warning' | 'error', category: import('./NotificationService').NotificationCategory, message: string, stackName?: string): void {
        NotificationService.getInstance()
            .dispatchAlert(level, category, message, { stackName, actor: 'system:scheduler' })
            .catch(err => console.error('[SchedulerService] Notification dispatch failed:', getErrorMessage(err, 'unknown error')));
    }

    /**
     * Run the pre-deploy scan-policy gate for a scheduler-driven action. On a
     * block, dispatch the documented `scan_finding` warning naming the policy
     * and the offending images, then throw so the caller records the outcome:
     * the auto-update loop catches per stack and continues the rest of the run,
     * while a single-stack auto-start surfaces as a task failure. The gate
     * fails open when Trivy is missing and is evaluation-only when the node's
     * local tier is unpaid.
     */
    private async enforceSchedulerPolicyGate(
        stackName: string,
        nodeId: number,
        action: 'Auto-start' | 'Auto-update',
        auditPath: string,
    ): Promise<void> {
        const actor = action === 'Auto-start' ? 'scheduler:auto-start' : 'scheduler:auto-update';
        const gate = await enforcePolicyPreDeploy(
            stackName,
            nodeId,
            buildSystemPolicyGateOptions(actor, { auditPath }),
        );
        if (gate.ok) return;
        const images = gate.violations.map((v) => v.imageRef).join(', ');
        this.safeDispatch(
            'warning',
            'scan_finding',
            `${action} blocked for "${stackName}" by policy "${gate.policy?.name}": ${gate.violations.length} image(s) exceed ${gate.policy?.max_severity}${images ? ` (${images})` : ''}`,
            stackName,
        );
        throw new Error(
            `${action} blocked by policy "${gate.policy?.name}": ${gate.violations.length} image(s) exceed ${gate.policy?.max_severity}`,
        );
    }

    private async tick(): Promise<void> {
        if (this.isProcessing) {
            console.warn('[SchedulerService] Tick skipped: previous tick still processing');
            return;
        }
        this.isProcessing = true;
        try {
            const db = DatabaseService.getInstance();

            // Sweep stale vulnerability scans and re-detect Trivy on every tick.
            try {
                const staleScans = db.markStaleScansAsFailed(STALE_SCAN_THRESHOLD_MS);
                if (staleScans > 0) {
                    console.log(
                        `[SchedulerService] Marked ${staleScans} stale vulnerability scan(s) as failed`,
                    );
                }
            } catch (error) {
                console.error('[SchedulerService] Stale scan sweep failed:', error);
            }
            await this.maybeRedetectTrivy();

            const now = Date.now();
            const dueTasks = db.getDueScheduledTasks(now);

            if (dueTasks.length > 0) {
                console.log(`[SchedulerService] Found ${dueTasks.length} due task(s)`);
            }

            // Clean up old runs periodically (piggyback on tick)
            db.cleanupOldTaskRuns(30);
            db.deleteOldScans(90 * 24 * 60 * 60 * 1000);

            for (const task of dueTasks) {
                if (this.runningTasks.has(task.id)) {
                    if (isDebugEnabled()) console.log(`[SchedulerService] Task ${task.id} skipped: already running`);
                    continue;
                }
                this.runningTasks.add(task.id);
                if (isDebugEnabled()) console.log(`[SchedulerService] Executing task ${task.id} ("${task.name}")`);
                this.executeTask(task).finally(() => this.runningTasks.delete(task.id));
            }
        } catch (error) {
            console.error('[SchedulerService] Tick error:', error);
        } finally {
            this.isProcessing = false;
        }
    }

    public isTaskRunning(taskId: number): boolean {
        return this.runningTasks.has(taskId);
    }

    // Intentionally allows triggering disabled tasks, useful for testing before enabling a schedule.
    // Manual triggers are attributed as 'manual' in the run record (see triggered_by column).
    public async triggerTask(taskId: number): Promise<void> {
        const db = DatabaseService.getInstance();
        const task = db.getScheduledTask(taskId);
        if (!task) throw new Error('Task not found');
        if (this.runningTasks.has(task.id)) throw new Error('Task is already running');
        console.log(`[SchedulerService] Manual trigger: task "${task.name}" (id=${task.id})`);
        this.runningTasks.add(task.id);
        try {
            await this.executeTask(task, 'manual');
        } finally {
            this.runningTasks.delete(task.id);
        }
    }

    private async executeTask(task: ScheduledTask, triggeredBy: 'scheduler' | 'manual' = 'scheduler'): Promise<void> {
        const db = DatabaseService.getInstance();
        const runId = db.createScheduledTaskRun({
            task_id: task.id,
            started_at: Date.now(),
            completed_at: null,
            status: 'running',
            output: null,
            error: null,
            triggered_by: triggeredBy,
        });

        try {
            // Pre-check: ensure target node exists and is reachable
            if (task.node_id != null && task.action !== 'snapshot') {
                const node = db.getNode(task.node_id);
                if (!node) throw new Error(`Target node (id=${task.node_id}) no longer exists`);
                if (node.status === 'offline') throw new Error(`Target node "${node.name}" is offline`);
            }

            if (isDebugEnabled()) console.log(`[SchedulerService:debug] Task ${task.id} pre-checks passed, executing ${task.action}`);
            const actionStart = Date.now();
            let output = '';
            let scanFailedCount = 0;
            switch (task.action) {
                case 'restart':
                    output = await this.executeRestart(task);
                    break;
                case 'snapshot':
                    output = await this.executeSnapshot(task);
                    break;
                case 'prune':
                    output = await this.executePrune(task);
                    break;
                case 'update':
                    output = await this.executeUpdate(task);
                    break;
                case 'scan': {
                    const result = await this.executeScan(task);
                    output = result.output;
                    scanFailedCount = result.failed;
                    break;
                }
                case 'auto_backup':
                    output = await this.executeAutoBackup(task);
                    break;
                case 'auto_stop':
                    output = await this.executeAutoStop(task);
                    break;
                case 'auto_down':
                    output = await this.executeAutoDown(task);
                    break;
                case 'auto_start':
                    output = await this.executeAutoStart(task);
                    break;
                default: {
                    const unhandledAction: never = task.action;
                    throw new Error(`Unsupported scheduled action: ${unhandledAction}`);
                }
            }

            if (isDebugEnabled()) console.log(`[SchedulerService:debug] Task ${task.id} action completed in ${Date.now() - actionStart}ms`);

            db.updateScheduledTaskRun(runId, {
                completed_at: Date.now(),
                status: 'success',
                output,
            });
            console.log(`[SchedulerService] Task "${task.name}" (id=${task.id}) completed successfully`);

            if (task.delete_after_run === 1) {
                console.log(`[SchedulerService] Task "${task.name}" (id=${task.id}) self-deleting after successful one-shot run`);
                db.deleteScheduledTask(task.id);
                return;
            }

            const nextRun = this.calculateNextRun(task.cron_expression);
            db.updateScheduledTask(task.id, {
                last_run_at: Date.now(),
                next_run_at: nextRun,
                last_status: 'success',
                last_error: null,
                updated_at: Date.now(),
            });

            if (task.action === 'scan') {
                const scanLevel: 'info' | 'warning' = scanFailedCount > 0 ? 'warning' : 'info';
                if (isDebugEnabled()) {
                    console.log(
                        `[SchedulerService:debug] Dispatching scan completion notification (level=${scanLevel}, stackContext=${task.target_id ?? 'none'})`,
                    );
                }
                this.safeDispatch(
                    scanLevel,
                    'scan_finding',
                    `Scheduled scan "${task.name}" completed: ${output}`,
                    task.target_id ?? undefined
                );
            } else if (task.last_status === 'failure') {
                this.safeDispatch(
                    'info',
                    'system',
                    `Scheduled task "${task.name}" (${task.action}) recovered successfully`,
                    task.target_id ?? undefined
                );
            }
        } catch (error: unknown) {
            const errMsg = error instanceof Error ? error.message : String(error);
            let nextRun: number | null = null;
            let cronInvalid = false;
            try {
                nextRun = this.calculateNextRun(task.cron_expression);
            } catch {
                cronInvalid = true;
            }
            const updates: Partial<Omit<ScheduledTask, 'id'>> = {
                last_run_at: Date.now(),
                next_run_at: nextRun,
                last_status: 'failure',
                last_error: cronInvalid
                    ? `${errMsg}. Cron expression "${task.cron_expression}" is no longer valid; task has been disabled.`
                    : errMsg,
                updated_at: Date.now(),
            };
            if (cronInvalid) {
                updates.enabled = 0;
                console.warn(`[SchedulerService] Task "${task.name}" (id=${task.id}) auto-disabled: cron expression invalid`);
            }
            db.updateScheduledTask(task.id, updates);
            db.updateScheduledTaskRun(runId, {
                completed_at: Date.now(),
                status: 'failure',
                error: errMsg,
            });
            console.error(`[SchedulerService] Task "${task.name}" (id=${task.id}) failed:`, errMsg);
            this.safeDispatch(
                'error',
                'system',
                `Scheduled task "${task.name}" (${task.action}) failed: ${errMsg}`,
                task.target_id ?? undefined
            );
        }
    }

    private async executeRestart(task: ScheduledTask): Promise<string> {
        if (!task.target_id || task.node_id == null) {
            throw new Error('Stack restart requires target_id and node_id');
        }
        if (this.isRemoteNode(task.node_id)) {
            return this.executeRestartRemote(task.node_id, task.target_id, task.target_services);
        }
        const docker = DockerController.getInstance(task.node_id);
        const containers = await docker.getContainersByStack(task.target_id);
        if (!containers || containers.length === 0) {
            throw new Error(`No containers found for stack "${task.target_id}"`);
        }

        let filtered = containers;
        if (task.target_services) {
            const serviceNames: string[] = JSON.parse(task.target_services);
            filtered = containers.filter(c => c.Service && serviceNames.includes(c.Service));
            if (filtered.length === 0) {
                throw new Error(`No containers found matching services [${serviceNames.join(', ')}] in stack "${task.target_id}"`);
            }
        }

        await Promise.all(filtered.map(c => docker.restartContainer(c.Id)));
        const servicesSuffix = task.target_services
            ? ` (services: ${(JSON.parse(task.target_services) as string[]).join(', ')})`
            : '';
        return `Restarted ${filtered.length} container(s) in stack "${task.target_id}"${servicesSuffix}`;
    }

    /**
     * Remote restart. The remote bulk-restart endpoint restarts every container
     * in the stack, so when the task targets specific services we fan out to the
     * per-service restart route to preserve the filter.
     */
    private async executeRestartRemote(nodeId: number, stackName: string, targetServices: string | null): Promise<string> {
        const stackSeg = encodeURIComponent(stackName);
        if (targetServices) {
            const serviceNames: string[] = JSON.parse(targetServices);
            // Fail fast, but name the services already restarted so a mid-loop failure
            // records the partial state of the remote stack in run history.
            const restarted: string[] = [];
            for (const svc of serviceNames) {
                try {
                    await this.postToRemoteStack(nodeId, `${stackSeg}/services/${encodeURIComponent(svc)}/restart`);
                    restarted.push(svc);
                } catch (e) {
                    const done = restarted.length ? ` (already restarted: ${restarted.join(', ')})` : '';
                    throw new Error(`Restart of service "${svc}" failed${done}: ${getErrorMessage(e, String(e))}`);
                }
            }
            return `Restarted services [${serviceNames.join(', ')}] in stack "${stackName}" on remote node`;
        }
        await this.postToRemoteStack(nodeId, `${stackSeg}/restart`);
        return `Restarted stack "${stackName}" on remote node`;
    }

    private assertStackTarget(task: ScheduledTask, label: string): asserts task is ScheduledTask & { target_id: string; node_id: number } {
        if (!task.target_id || task.node_id == null) {
            throw new Error(`${label} requires target_id and node_id`);
        }
    }

    private isRemoteNode(nodeId: number): boolean {
        return NodeRegistry.getInstance().getNode(nodeId)?.type === 'remote';
    }

    private async executeAutoBackup(task: ScheduledTask): Promise<string> {
        this.assertStackTarget(task, 'Auto-backup');
        if (this.isRemoteNode(task.node_id)) {
            await this.postToRemoteStack(task.node_id, `${encodeURIComponent(task.target_id)}/backup`);
            return `Backed up stack "${task.target_id}" files on remote node`;
        }
        const localNodeId = task.node_id ?? NodeRegistry.getInstance().getDefaultNodeId();
        const lock = await StackOpLockService.getInstance().runExclusive(
            localNodeId, task.target_id, 'backup', 'system',
            () => FileSystemService.getInstance(localNodeId).backupStackFiles(task.target_id),
        );
        // Throw (not return) so the skip records as a failed run instead of a
        // silent success; the next scheduled tick retries once the lock frees.
        if (!lock.ran) throw new Error(skipMessage(task.target_id, lock.existing.action));
        return `Backed up stack "${task.target_id}" files`;
    }

    private async executeAutoStop(task: ScheduledTask): Promise<string> {
        this.assertStackTarget(task, 'Auto-stop');
        if (this.isRemoteNode(task.node_id)) {
            await this.postToRemoteStack(task.node_id, `${encodeURIComponent(task.target_id)}/stop`);
            return `Stopped stack "${task.target_id}" (containers preserved) on remote node`;
        }
        const localNodeId = task.node_id ?? NodeRegistry.getInstance().getDefaultNodeId();
        const lock = await StackOpLockService.getInstance().runExclusive(
            localNodeId, task.target_id, 'stop', 'system',
            () => ComposeService.getInstance(localNodeId).runCommand(task.target_id, 'stop'),
        );
        if (!lock.ran) throw new Error(skipMessage(task.target_id, lock.existing.action));
        return `Stopped stack "${task.target_id}" (containers preserved)`;
    }

    private async executeAutoDown(task: ScheduledTask): Promise<string> {
        this.assertStackTarget(task, 'Auto-down');
        if (this.isRemoteNode(task.node_id)) {
            await this.postToRemoteStack(task.node_id, `${encodeURIComponent(task.target_id)}/down`);
            return `Took down stack "${task.target_id}" (containers removed) on remote node`;
        }
        const localNodeId = task.node_id ?? NodeRegistry.getInstance().getDefaultNodeId();
        const lock = await StackOpLockService.getInstance().runExclusive(
            localNodeId, task.target_id, 'down', 'system',
            () => ComposeService.getInstance(localNodeId).runCommand(task.target_id, 'down'),
        );
        if (!lock.ran) throw new Error(skipMessage(task.target_id, lock.existing.action));
        return `Took down stack "${task.target_id}" (containers removed)`;
    }

    private async executeAutoStart(task: ScheduledTask): Promise<string> {
        this.assertStackTarget(task, 'Auto-start');
        // Remote auto-start proxies to the remote's own deploy route, which runs
        // that node's scan-policy gate against the images it actually holds. The
        // hub-side enforceSchedulerPolicyGate below is for local nodes only.
        if (this.isRemoteNode(task.node_id)) {
            await this.postToRemoteStack(task.node_id, `${encodeURIComponent(task.target_id)}/deploy`);
            return `Started stack "${task.target_id}" on remote node`;
        }
        await this.enforceSchedulerPolicyGate(
            task.target_id,
            task.node_id,
            'Auto-start',
            `/api/scheduled-tasks/${task.id}/run`,
        );
        const localNodeId = task.node_id ?? NodeRegistry.getInstance().getDefaultNodeId();
        const lock = await StackOpLockService.getInstance().runExclusive(
            localNodeId, task.target_id, 'deploy', 'system',
            () => ComposeService.getInstance(localNodeId).deployStack(task.target_id),
        );
        if (!lock.ran) throw new Error(skipMessage(task.target_id, lock.existing.action));
        return `Started stack "${task.target_id}"`;
    }

    private async executeSnapshot(task: ScheduledTask): Promise<string> {
        const db = DatabaseService.getInstance();
        const nodes = db.getNodes();
        const captureDocs = db.getGlobalSettings().snapshot_documentation === '1';

        const results = await Promise.allSettled(
            nodes.map(async (node) => {
                if (node.type === 'remote') {
                    return captureRemoteNodeFiles(node, captureDocs);
                }
                return captureLocalNodeFiles(node, captureDocs);
            })
        );

        const capturedNodes: SnapshotNodeData[] = [];
        const skippedNodes: Array<{ nodeId: number; nodeName: string; reason: string }> = [];

        results.forEach((result, i) => {
            if (result.status === 'fulfilled') {
                capturedNodes.push(result.value);
            } else {
                skippedNodes.push({
                    nodeId: nodes[i].id,
                    nodeName: nodes[i].name,
                    reason: result.reason instanceof Error ? result.reason.message : 'Unknown error',
                });
            }
        });

        let totalStacks = 0;
        const allFiles: Array<{ nodeId: number; nodeName: string; stackName: string; filename: string; content: string }> = [];
        const skippedStacks: Array<{ nodeId: number; nodeName: string; stackName: string; reason: string }> = [];

        for (const nodeData of capturedNodes) {
            totalStacks += nodeData.stacks.length;
            for (const stack of nodeData.stacks) {
                for (const file of stack.files) {
                    allFiles.push({
                        nodeId: nodeData.nodeId,
                        nodeName: nodeData.nodeName,
                        stackName: stack.stackName,
                        filename: file.filename,
                        content: file.content,
                    });
                }
            }
            for (const warning of nodeData.warnings) {
                skippedStacks.push({
                    nodeId: nodeData.nodeId,
                    nodeName: nodeData.nodeName,
                    stackName: warning.stackName,
                    reason: warning.reason,
                });
            }
        }

        const documentation = captureDocs
            ? buildSnapshotDocumentation(capturedNodes, new Date().toISOString())
            : null;

        const description = `Scheduled snapshot: ${task.name}`;
        const snapshotId = db.createSnapshot(
            description,
            task.created_by,
            capturedNodes.length,
            totalStacks,
            JSON.stringify(skippedNodes),
            JSON.stringify(skippedStacks),
            documentation ? JSON.stringify(documentation) : '',
        );

        if (allFiles.length > 0) {
            db.insertSnapshotFiles(snapshotId, allFiles);
        }

        let cloudUploadNote = '';
        const cloudSvc = CloudBackupService.getInstance();
        if (cloudSvc.isEnabled() && cloudSvc.isAutoUploadOn()) {
            try {
                await cloudSvc.uploadSnapshot(snapshotId);
                cloudUploadNote = ', cloud upload OK';
            } catch (err) {
                const message = getErrorMessage(err, 'Cloud upload failed');
                console.error('[SchedulerService] Cloud upload failed:', message);
                this.safeDispatch('warning', 'system', `Cloud backup failed for scheduled snapshot ${snapshotId}: ${message}`);
                cloudUploadNote = ', cloud upload FAILED';
            }
        }

        if (skippedNodes.length > 0 || skippedStacks.length > 0) {
            console.warn(`[SchedulerService] Snapshot task ${task.id} partial: skipped ${skippedNodes.length} node(s), ${skippedStacks.length} stack(s)`);
        }
        if (isDebugEnabled()) {
            console.debug(`[SchedulerService:debug] Snapshot task ${task.id}: captured ${capturedNodes.length} node(s), ${totalStacks} stack(s), ${allFiles.length} file(s), skipped ${skippedNodes.length} node(s)/${skippedStacks.length} stack(s)${cloudUploadNote}`);
        }

        const skippedNote = [
            skippedNodes.length > 0 ? `${skippedNodes.length} node(s)` : '',
            skippedStacks.length > 0 ? `${skippedStacks.length} stack(s)` : '',
        ].filter(Boolean).join(', ');
        return `Fleet snapshot created (id=${snapshotId}, ${capturedNodes.length} node(s), ${totalStacks} stack(s)${skippedNote ? `, skipped ${skippedNote}` : ''}${cloudUploadNote})`;
    }

    private async executePrune(task: ScheduledTask): Promise<string> {
        const nodeId = task.node_id ?? NodeRegistry.getInstance().getDefaultNodeId();
        if (task.node_id == null && isDebugEnabled()) {
            console.log(`[SchedulerService:debug] Prune task ${task.id}: no node_id specified, using default node ${nodeId}`);
        }
        if (this.isRemoteNode(nodeId)) {
            throw new Error('Scheduled prunes currently require a local node.');
        }
        const docker = DockerController.getInstance(nodeId);
        const allTargets = ['containers', 'images', 'networks', 'volumes'] as const;
        type PruneTarget = typeof allTargets[number];
        const targets: PruneTarget[] = task.prune_targets
            ? (JSON.parse(task.prune_targets) as string[]).filter((t): t is PruneTarget => allTargets.includes(t as PruneTarget))
            : [...allTargets];
        const labelFilter = task.prune_label_filter || undefined;
        const results: string[] = [];
        const failures: string[] = [];

        for (const target of targets) {
            try {
                const result = await docker.pruneSystem(target, labelFilter);
                results.push(`${target}: ${result.reclaimedBytes ?? 0} bytes reclaimed`);
            } catch (error: unknown) {
                const msg = error instanceof Error ? error.message : String(error);
                const failure = `${target}: failed (${msg})`;
                results.push(failure);
                failures.push(failure);
            }
        }

        const filterSuffix = labelFilter ? ` (label: ${labelFilter})` : '';
        if (failures.length > 0) {
            throw new Error(`System prune failed${filterSuffix}: ${results.join('; ')}`);
        }
        return `System prune completed${filterSuffix}: ${results.join('; ')}`;
    }

    private async executeUpdate(task: ScheduledTask): Promise<string> {
        if (task.node_id == null) {
            throw new Error('Auto-update requires node_id');
        }

        const isFleet = task.target_type === 'fleet';

        if (!isFleet && !task.target_id) {
            throw new Error('Auto-update requires target_id (stack name or "*")');
        }

        // For remote nodes, proxy the entire execution to the remote Sencho instance.
        // The remote /api/auto-update/execute endpoint already handles per-stack
        // auto-update policy, so passing '*' for fleet is sufficient.
        const node = NodeRegistry.getInstance().getNode(task.node_id);
        if (node?.type === 'remote') {
            return this.executeUpdateRemote(task.node_id, isFleet ? '*' : task.target_id!);
        }

        // Local node: execute directly
        const isWildcard = task.target_id === '*';
        let stackNames: string[];
        if (isFleet || isWildcard) {
            stackNames = await FileSystemService.getInstance(task.node_id).getStacks();
            if (stackNames.length === 0) {
                return 'No stacks found on node; skipped.';
            }
        } else {
            stackNames = [task.target_id!];
        }

        if (isDebugEnabled()) {
            console.log(`[SchedulerService] executeUpdate: ${stackNames.length} stack(s) to check, fleet=${isFleet}, wildcard=${isWildcard}`);
        }

        const db = DatabaseService.getInstance();
        const docker = DockerController.getInstance(task.node_id);
        const imageUpdateService = ImageUpdateService.getInstance();
        const compose = ComposeService.getInstance(task.node_id);
        const results: string[] = [];

        for (const stackName of stackNames) {
            try {
                const output = await this.executeUpdateForStack(stackName, task.node_id, docker, imageUpdateService, compose, db, isFleet || isWildcard);
                results.push(output);
            } catch (e) {
                const msg = getErrorMessage(e, String(e));
                results.push(`Stack "${stackName}" failed: ${msg}`);
                console.error(`[SchedulerService] Auto-update failed for stack "${stackName}":`, e);
            }
        }

        return results.join('\n');
    }

    /**
     * Proxy auto-update execution to a remote Sencho instance.
     * The remote node runs the image checks and compose update locally.
     */
    private async executeUpdateRemote(nodeId: number, target: string): Promise<string> {
        const proxyTarget = NodeRegistry.getInstance().getProxyTarget(nodeId);
        if (!proxyTarget) {
            throw new Error('Remote node is not configured or missing API credentials');
        }

        const baseUrl = proxyTarget.apiUrl.replace(/\/$/, '');
        const proxyHeaders = LicenseService.getInstance().getProxyHeaders();
        if (isDebugEnabled()) {
            console.log(`[SchedulerService] executeUpdateRemote: node=${nodeId} target=${target}`);
        }
        const startTime = Date.now();
        const response = await fetch(`${baseUrl}/api/auto-update/execute`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${proxyTarget.apiToken}`,
                [PROXY_TIER_HEADER]: proxyHeaders.tier,
            },
            body: JSON.stringify({ target }),
            signal: AbortSignal.timeout(300_000), // 5 minute timeout for long updates
        });

        if (!response.ok) {
            const body = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
            throw new Error((body as { error?: string }).error || `Remote node returned ${response.status}`);
        }

        const body = await response.json() as { result?: string };
        if (isDebugEnabled()) {
            console.log(`[SchedulerService] executeUpdateRemote: completed in ${Date.now() - startTime}ms`);
        }
        return body.result || 'Remote auto-update completed (no details returned).';
    }

    /**
     * Proxy a stack lifecycle action to a remote Sencho instance. ComposeService,
     * DockerController, and FileSystemService are local-only, so for a remote node
     * we POST to the remote's own stack-operation endpoint with the node Bearer
     * token and the licence proxy headers, exactly as executeUpdateRemote does.
     * `routeSuffix` is the path under `/api/stacks/`; the caller URL-encodes each
     * segment.
     */
    private async postToRemoteStack(nodeId: number, routeSuffix: string): Promise<void> {
        const proxyTarget = NodeRegistry.getInstance().getProxyTarget(nodeId);
        if (!proxyTarget) {
            throw new Error('Remote node is not configured or missing API credentials');
        }
        const baseUrl = proxyTarget.apiUrl.replace(/\/$/, '');
        const proxyHeaders = LicenseService.getInstance().getProxyHeaders();
        if (isDebugEnabled()) {
            console.log(`[SchedulerService:debug] postToRemoteStack: node=${nodeId} route=${routeSuffix}`);
        }
        const response = await fetch(`${baseUrl}/api/stacks/${routeSuffix}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${proxyTarget.apiToken}`,
                [PROXY_TIER_HEADER]: proxyHeaders.tier,
            },
            signal: AbortSignal.timeout(300_000),
        });
        if (!response.ok) {
            const body = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
            throw new Error((body as { error?: string }).error || `Remote node returned ${response.status}`);
        }
    }

    private async executeUpdateForStack(
        stackName: string,
        nodeId: number,
        docker: DockerController,
        imageUpdateService: ImageUpdateService,
        compose: ComposeService,
        db: DatabaseService,
        isWildcard = false
    ): Promise<string> {
        const containers = await docker.getContainersByStack(stackName);
        if (!containers || containers.length === 0) {
            if (!isWildcard) {
                console.warn(`[SchedulerService] Stack "${stackName}": no containers found. The stack may have been removed or renamed.`);
                return `Stack "${stackName}": WARNING - no containers found. The stack may have been removed or renamed.`;
            }
            return `Stack "${stackName}": no containers found; skipped.`;
        }

        const imageRefs = [...new Set(
            containers
                .map((c: { Image?: string }) => c.Image)
                .filter((img): img is string => !!img && !img.startsWith('sha256:'))
        )];

        if (imageRefs.length === 0) {
            return `Stack "${stackName}": no pullable images; skipped.`;
        }

        if (isDebugEnabled()) {
            console.log(`[SchedulerService] Stack "${stackName}": checking ${imageRefs.length} image(s): ${imageRefs.join(', ')}`);
        }

        let hasUpdate = false;
        const updatedImages: string[] = [];
        const checkErrors: string[] = [];

        for (const imageRef of imageRefs) {
            try {
                const result: ImageCheckResult = await imageUpdateService.checkImage(docker, imageRef);
                if (result.error) {
                    checkErrors.push(result.error);
                } else if (result.hasUpdate) {
                    hasUpdate = true;
                    updatedImages.push(imageRef);
                }
            } catch (e) {
                const msg = getErrorMessage(e, String(e));
                checkErrors.push(msg);
                console.warn(`[SchedulerService] Failed to check image ${sanitizeForLog(imageRef)}:`, sanitizeForLog((e as Error)?.message ?? String(e)));
            }
        }

        if (!hasUpdate) {
            if (checkErrors.length > 0 && checkErrors.length === imageRefs.length) {
                return `Stack "${stackName}": WARNING - all image checks failed (${checkErrors.join('; ')}). Unable to determine update status.`;
            }
            if (checkErrors.length > 0) {
                return `Stack "${stackName}": all reachable images up to date (${checkErrors.length} check(s) failed).`;
            }
            return `Stack "${stackName}": all images up to date.`;
        }

        await this.enforceSchedulerPolicyGate(
            stackName,
            nodeId,
            'Auto-update',
            `/api/scheduled-tasks/auto-update/${stackName}`,
        );
        // Atomic backup/rollback is the default deploy mode: take a pre-op
        // backup and roll back on failure for every scheduled auto-update.
        const atomic = true;
        const lock = await StackOpLockService.getInstance().runExclusive(
            nodeId, stackName, 'update', 'system',
            () => compose.updateStack(stackName, undefined, atomic),
        );
        if (!lock.ran) return skipMessage(stackName, lock.existing.action);
        db.clearStackUpdateStatus(nodeId, stackName);
        HealthGateService.getInstance().begin(nodeId, stackName, 'update', 'system:scheduler');

        this.safeDispatch(
            'info',
            'image_update_applied',
            `Auto-update: stack "${stackName}" updated with new images`,
            stackName
        );

        return `Stack "${stackName}": updated (${updatedImages.join(', ')}).`;
    }

    private async executeScan(task: ScheduledTask): Promise<{ output: string; failed: number }> {
        const trivy = TrivyService.getInstance();
        if (!trivy.isTrivyAvailable()) {
            throw new Error('Trivy binary is not available on this node');
        }

        const nodeId = task.node_id ?? NodeRegistry.getInstance().getDefaultNodeId();
        if (task.node_id == null && isDebugEnabled()) {
            console.log(`[SchedulerService:debug] Scan task ${task.id}: no node_id specified, using default node ${nodeId}`);
        }
        const node = NodeRegistry.getInstance().getNode(nodeId);
        if (!node) {
            throw new Error('Scheduled vulnerability scans require an existing local node.');
        }
        if (node?.type === 'remote') {
            throw new Error('Scheduled vulnerability scans currently require a local node.');
        }

        const scanStart = Date.now();
        if (isDebugEnabled()) console.log(`[SchedulerService:debug] executeScan start: task=${task.id} node=${nodeId}`);

        const summary = await trivy.scanAllNodeImages(nodeId, 'scheduled');

        if (isDebugEnabled()) {
            console.log(
                `[SchedulerService:debug] executeScan summary: scanned=${summary.scanned} skipped=${summary.skipped} failed=${summary.failed} ` +
                `critical=${summary.severity.critical} high=${summary.severity.high} medium=${summary.severity.medium} ` +
                `low=${summary.severity.low} unknown=${summary.severity.unknown} violations=${summary.violations.length} durationMs=${Date.now() - scanStart}`,
            );
        }

        // Scheduled scans never auto-quarantine; violations surface as alerts
        // so an operator can review and remediate. One alert per violation so
        // the notification panel keeps per-image granularity.
        for (const v of summary.violations ?? []) {
            NotificationService.getInstance().dispatchAlert(
                'warning',
                'scan_finding',
                `Policy "${v.policyName}" violated by ${v.imageRef}: ${v.severity} exceeds ${v.maxSeverity}`,
                { actor: 'system:scheduler' },
            );
        }

        const output = formatScanOutput(summary);
        return { output, failed: summary.failed };
    }
}

/**
 * Build the human-readable completion message from a bulk scan summary.
 * Exported for unit tests.
 */
export function formatScanOutput(summary: ScanAllNodeImagesResult): string {
    const { scanned, skipped, failed, severity } = summary;

    let header: string;
    if (scanned === 0 && skipped === 0 && failed === 0) {
        header = 'No images to scan';
    } else if (scanned === 0 && skipped > 0 && failed === 0) {
        header = `All ${skipped} image(s) already scanned recently (cache hit)`;
    } else {
        const parts: string[] = [`Scanned ${scanned} image(s)`];
        if (skipped > 0) parts.push(`${skipped} skipped (cached)`);
        if (failed > 0) parts.push(`${failed} failed`);
        header = parts.join('; ');
    }

    if (summary.truncated) {
        const total = summary.totalImages ?? scanned + skipped + failed;
        const processed = summary.processedImages ?? scanned + skipped + failed;
        header += `. Scan limited after ${processed} of ${total} image(s)`;
        if (summary.limitReason) header += ` (${summary.limitReason})`;
    }

    const severityTiers: Array<[string, number]> = [
        ['critical', severity.critical],
        ['high', severity.high],
        ['medium', severity.medium],
    ];
    const nonZero = severityTiers.filter(([, n]) => n > 0);
    if (nonZero.length === 0) {
        if (scanned === 0 && skipped === 0 && failed === 0) {
            return header + '.';
        }
        return `${header}. No critical, high, or medium findings.`;
    }
    const findings = nonZero.map(([label, n]) => `${n} ${label}`).join(', ');
    return `${header}. Found ${findings}.`;
}
