import crypto from 'crypto';
import { ComposeService } from './ComposeService';
import { DatabaseService } from './DatabaseService';
import { FileSystemService } from './FileSystemService';
import { GitSourceService } from './GitSourceService';
import { LicenseService } from './LicenseService';
import { PROXY_TIER_HEADER, PROXY_VARIANT_HEADER } from './license-headers';
import { NodeRegistry } from './NodeRegistry';
import { getErrorMessage } from '../utils/errors';
import { isValidStackName } from '../utils/validation';
import { assertPolicyGateAllows, buildSystemPolicyGateOptions } from '../helpers/policyGate';

type ExecutionResult = { success: boolean; error?: string; duration_ms: number };
type ExecutionStatus = 'success' | 'failure';

const REMOTE_WEBHOOK_REQUEST_TIMEOUT_MS = 30_000;

export class WebhookService {
    private static instance: WebhookService;

    public static getInstance(): WebhookService {
        if (!WebhookService.instance) {
            WebhookService.instance = new WebhookService();
        }
        return WebhookService.instance;
    }

    public generateSecret(): string {
        return crypto.randomBytes(32).toString('hex');
    }

    public validateSignature(payload: string, secret: string, signature: string): boolean {
        const parts = signature.split('=');
        if (parts.length !== 2 || parts[0] !== 'sha256') return false;

        const expected = crypto
            .createHmac('sha256', secret)
            .update(payload)
            .digest('hex');

        try {
            return crypto.timingSafeEqual(
                Buffer.from(expected, 'hex'),
                Buffer.from(parts[1], 'hex'),
            );
        } catch {
            return false;
        }
    }

    public async gitSourceExists(stackName: string, nodeId: number): Promise<boolean> {
        const node = NodeRegistry.getInstance().getNode(nodeId);
        if (!node) return false;
        if (node.type !== 'remote') return GitSourceService.getInstance().get(stackName) !== undefined;

        const response = await this.remoteStackRequest(nodeId, stackName, 'git-source', 'GET');
        return response.ok;
    }

    public async execute(
        webhookId: number,
        action: string,
        triggerSource: string | null,
        atomic?: boolean,
    ): Promise<ExecutionResult> {
        const webhook = DatabaseService.getInstance().getWebhook(webhookId);
        if (!webhook) throw new Error('Webhook not found');

        const nodeId = webhook.node_id || NodeRegistry.getInstance().getDefaultNodeId();
        const node = NodeRegistry.getInstance().getNode(nodeId);
        if (!node) {
            const error = `Node for webhook "${webhook.name}" was not found`;
            this.recordExecution(webhookId, action, 'failure', triggerSource, 0, error);
            return { success: false, error, duration_ms: 0 };
        }

        if (node.type === 'remote') {
            return this.executeRemote(webhookId, nodeId, webhook.stack_name, action, triggerSource, atomic);
        }

        return this.executeLocal(webhookId, nodeId, webhook.stack_name, action, triggerSource, atomic);
    }

    public maskSecret(secret: string): string {
        if (secret.length <= 8) return '********';
        return '********' + secret.slice(-4);
    }

    private async executeLocal(
        webhookId: number,
        nodeId: number,
        stackName: string,
        action: string,
        triggerSource: string | null,
        atomic?: boolean,
    ): Promise<ExecutionResult> {
        const stacks = await FileSystemService.getInstance(nodeId).getStacks();
        if (!stacks.includes(stackName)) {
            const error = `Stack "${stackName}" not found`;
            this.recordExecution(webhookId, action, 'failure', triggerSource, 0, error);
            return { success: false, error, duration_ms: 0 };
        }

        const startTime = Date.now();
        try {
            const compose = ComposeService.getInstance(nodeId);
            switch (action) {
                case 'deploy':
                    await assertPolicyGateAllows(
                        stackName,
                        nodeId,
                        buildSystemPolicyGateOptions('webhook', { auditPath: `/api/webhooks/${webhookId}/execute` }),
                    );
                    await compose.deployStack(stackName, undefined, atomic);
                    break;
                case 'restart':
                    await compose.runCommand(stackName, 'restart');
                    break;
                case 'stop':
                    await compose.runCommand(stackName, 'stop');
                    break;
                case 'start':
                    await compose.runCommand(stackName, 'start');
                    break;
                case 'pull':
                    await assertPolicyGateAllows(
                        stackName,
                        nodeId,
                        buildSystemPolicyGateOptions('webhook', { auditPath: `/api/webhooks/${webhookId}/execute` }),
                    );
                    await compose.updateStack(stackName, undefined, atomic);
                    break;
                case 'git-pull':
                    return this.executeLocalGitPull(webhookId, stackName, action, triggerSource, startTime);
                default:
                    throw new Error(`Unknown action: ${action}`);
            }

            const durationMs = Date.now() - startTime;
            this.recordExecution(webhookId, action, 'success', triggerSource, durationMs, null);
            return { success: true, duration_ms: durationMs };
        } catch (err) {
            const durationMs = Date.now() - startTime;
            const error = getErrorMessage(err, 'Unknown error');
            this.recordExecution(webhookId, action, 'failure', triggerSource, durationMs, error);
            return { success: false, error, duration_ms: durationMs };
        }
    }

    private async executeLocalGitPull(
        webhookId: number,
        stackName: string,
        action: string,
        triggerSource: string | null,
        startTime: number,
    ): Promise<ExecutionResult> {
        const result = await GitSourceService.getInstance().handleWebhookPull(stackName);
        const durationMs = Date.now() - startTime;
        if (result.status === 'error') {
            this.recordExecution(webhookId, action, 'failure', triggerSource, durationMs, result.message);
            return { success: false, error: result.message, duration_ms: durationMs };
        }

        const skipped = result.status === 'skipped';
        this.recordExecution(
            webhookId,
            action,
            skipped ? 'failure' : 'success',
            triggerSource,
            durationMs,
            skipped ? result.message : null,
        );
        return { success: !skipped, error: skipped ? result.message : undefined, duration_ms: durationMs };
    }

    private async executeRemote(
        webhookId: number,
        nodeId: number,
        stackName: string,
        action: string,
        triggerSource: string | null,
        atomic?: boolean,
    ): Promise<ExecutionResult> {
        const startTime = Date.now();
        try {
            const endpoint = action === 'git-pull'
                ? 'git-source/webhook-pull'
                : action === 'pull'
                    ? 'update'
                    : action;
            const body = atomic === undefined ? undefined : { atomic };
            const response = await this.remoteStackRequest(nodeId, stackName, endpoint, 'POST', body);
            const durationMs = Date.now() - startTime;
            const payload = await response.json().catch(() => ({})) as { error?: string; message?: string; status?: string };

            if (!response.ok || payload.status === 'error' || payload.status === 'skipped') {
                const error = payload.error || payload.message || `Remote ${action} failed with status ${response.status}`;
                this.recordExecution(webhookId, action, 'failure', triggerSource, durationMs, error);
                return { success: false, error, duration_ms: durationMs };
            }

            this.recordExecution(webhookId, action, 'success', triggerSource, durationMs, null);
            return { success: true, duration_ms: durationMs };
        } catch (err) {
            const durationMs = Date.now() - startTime;
            const error = getErrorMessage(err, 'Remote node operation failed');
            this.recordExecution(webhookId, action, 'failure', triggerSource, durationMs, error);
            return { success: false, error, duration_ms: durationMs };
        }
    }

    private async remoteStackRequest(
        nodeId: number,
        stackName: string,
        endpoint: string,
        method: 'GET' | 'POST',
        body?: unknown,
    ): Promise<Response> {
        const target = NodeRegistry.getInstance().getProxyTarget(nodeId);
        if (!target) throw new Error('Remote node is unreachable or not configured');

        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (target.apiToken) headers.Authorization = `Bearer ${target.apiToken}`;

        const licenseHeaders = LicenseService.getInstance().getProxyHeaders();
        headers[PROXY_TIER_HEADER] = licenseHeaders.tier;
        headers[PROXY_VARIANT_HEADER] = licenseHeaders.variant || '';

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), REMOTE_WEBHOOK_REQUEST_TIMEOUT_MS);
        try {
            // nodeId selects a server-controlled entry from the registry
            // (CodeQL GOOD pattern: user input maps to known values, not concatenated into the URL).
            const targetBase = new URL(target.apiUrl);
            const protocol = targetBase.protocol;
            const host = targetBase.host;
            const hostname = targetBase.hostname;

            // Verify the hostname is in the configured-node allow-list.
            const allowedHosts = DatabaseService.getInstance().getNodes()
                .filter(n => n.api_url)
                .map(n => new URL(n.api_url!).hostname);
            if (!allowedHosts.includes(hostname)) {
                throw new Error('Remote node hostname is not a configured node');
            }

            // Restrict protocol to http/https (prevents file://, ftp://, etc.).
            if (protocol !== 'http:' && protocol !== 'https:') {
                throw new Error('Remote node URL must use http:// or https://');
            }

            // Validate path components to prevent traversal.
            if (!isValidStackName(stackName)) {
                throw new Error('Invalid stack name');
            }
            if (!/^[a-z][a-z0-9\/-]*$/.test(endpoint) || endpoint.includes('..')) {
                throw new Error('Invalid endpoint');
            }

            // Build URL from validated, server-controlled components.
            const url = `${protocol}//${host}/api/stacks/${encodeURIComponent(stackName)}/${endpoint}`;
            return await fetch(url, {
                method,
                headers,
                body: method === 'GET' || body === undefined ? undefined : JSON.stringify(body),
                signal: controller.signal,
            });
        } catch (err) {
            if (controller.signal.aborted) {
                throw new Error('Remote node request timed out', { cause: err });
            }
            throw err;
        } finally {
            clearTimeout(timer);
        }
    }

    private recordExecution(
        webhookId: number,
        action: string,
        status: ExecutionStatus,
        triggerSource: string | null,
        durationMs: number,
        error: string | null,
    ): void {
        DatabaseService.getInstance().addWebhookExecution({
            webhook_id: webhookId,
            action,
            status,
            trigger_source: triggerSource,
            duration_ms: durationMs,
            error,
            executed_at: Date.now(),
        });
    }
}
