import crypto from 'crypto';
import { DatabaseService } from './DatabaseService';
import { ComposeService } from './ComposeService';
import { FileSystemService } from './FileSystemService';
import { GitSourceService } from './GitSourceService';
import { NodeRegistry } from './NodeRegistry';
import { assertPolicyGateAllows, buildSystemPolicyGateOptions } from '../helpers/policyGate';

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
        // Expect format: sha256=<hex>
        const parts = signature.split('=');
        if (parts.length !== 2 || parts[0] !== 'sha256') return false;

        const expected = crypto
            .createHmac('sha256', secret)
            .update(payload)
            .digest('hex');

        return crypto.timingSafeEqual(
            Buffer.from(expected, 'hex'),
            Buffer.from(parts[1], 'hex')
        );
    }

    public async execute(webhookId: number, action: string, triggerSource: string | null, atomic?: boolean): Promise<{ success: boolean; error?: string; duration_ms: number }> {
        const db = DatabaseService.getInstance();
        const webhook = db.getWebhook(webhookId);
        if (!webhook) throw new Error('Webhook not found');

        const defaultNodeId = NodeRegistry.getInstance().getDefaultNodeId();

        // Validate the stack still exists
        const stacks = await FileSystemService.getInstance(defaultNodeId).getStacks();
        if (!stacks.includes(webhook.stack_name)) {
            const error = `Stack "${webhook.stack_name}" not found`;
            db.addWebhookExecution({
                webhook_id: webhookId,
                action,
                status: 'failure',
                trigger_source: triggerSource,
                duration_ms: 0,
                error,
                executed_at: Date.now(),
            });
            return { success: false, error, duration_ms: 0 };
        }

        const startTime = Date.now();
        try {
            const compose = ComposeService.getInstance(defaultNodeId);
            switch (action) {
                case 'deploy':
                    await assertPolicyGateAllows(
                        webhook.stack_name,
                        defaultNodeId,
                        buildSystemPolicyGateOptions('webhook', { auditPath: `/api/webhooks/${webhookId}/execute` }),
                    );
                    await compose.deployStack(webhook.stack_name, undefined, atomic);
                    break;
                case 'restart':
                    await compose.runCommand(webhook.stack_name, 'restart');
                    break;
                case 'stop':
                    await compose.runCommand(webhook.stack_name, 'stop');
                    break;
                case 'start':
                    await compose.runCommand(webhook.stack_name, 'start');
                    break;
                case 'pull':
                    await assertPolicyGateAllows(
                        webhook.stack_name,
                        defaultNodeId,
                        buildSystemPolicyGateOptions('webhook', { auditPath: `/api/webhooks/${webhookId}/execute` }),
                    );
                    await compose.updateStack(webhook.stack_name, undefined, atomic);
                    break;
                case 'git-pull': {
                    const result = await GitSourceService.getInstance().handleWebhookPull(webhook.stack_name);
                    const duration_ms = Date.now() - startTime;
                    if (result.status === 'error') {
                        db.addWebhookExecution({
                            webhook_id: webhookId,
                            action,
                            status: 'failure',
                            trigger_source: triggerSource,
                            duration_ms,
                            error: result.message,
                            executed_at: Date.now(),
                        });
                        return { success: false, error: result.message, duration_ms };
                    }
                    db.addWebhookExecution({
                        webhook_id: webhookId,
                        action,
                        status: result.status === 'skipped' ? 'failure' : 'success',
                        trigger_source: triggerSource,
                        duration_ms,
                        error: result.status === 'skipped' ? result.message : null,
                        executed_at: Date.now(),
                    });
                    return { success: result.status === 'success', error: result.status === 'skipped' ? result.message : undefined, duration_ms };
                }
                default:
                    throw new Error(`Unknown action: ${action}`);
            }

            const duration_ms = Date.now() - startTime;
            db.addWebhookExecution({
                webhook_id: webhookId,
                action,
                status: 'success',
                trigger_source: triggerSource,
                duration_ms,
                error: null,
                executed_at: Date.now(),
            });
            return { success: true, duration_ms };
        } catch (err) {
            const duration_ms = Date.now() - startTime;
            const error = (err as Error).message || 'Unknown error';
            db.addWebhookExecution({
                webhook_id: webhookId,
                action,
                status: 'failure',
                trigger_source: triggerSource,
                duration_ms,
                error,
                executed_at: Date.now(),
            });
            return { success: false, error, duration_ms };
        }
    }

    public maskSecret(secret: string): string {
        if (secret.length <= 8) return '••••••••';
        return '••••••••' + secret.slice(-4);
    }
}
