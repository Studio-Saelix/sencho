import path from 'path';
import YAML from 'yaml';
import DockerController from './DockerController';
import { DatabaseService } from './DatabaseService';
import { FileSystemService } from './FileSystemService';
import { RegistryService } from './RegistryService';
import { NodeRegistry } from './NodeRegistry';
import { NotificationService } from './NotificationService';
import { sanitizeNotificationMessage } from '../utils/notificationMessage';
import { parseImageRef, getRemoteDigest } from './registry-api';
import { isDebugEnabled } from '../utils/debug';
import { getErrorMessage } from '../utils/errors';
import { sanitizeForLog } from '../utils/safeLog';

const BACKFILL_KEY = 'image_update_notifications_backfilled';

export interface ImageCheckResult {
    hasUpdate: boolean;
    error?: string;
}

// ─── Compose file helpers ────────────────────────────────────────────────────

export function loadDotEnv(content: string): Record<string, string> {
    const vars: Record<string, string> = {};
    for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx < 1) continue;
        const key = trimmed.slice(0, eqIdx).trim();
        let val = trimmed.slice(eqIdx + 1).trim();
        if ((val.startsWith('"') && val.endsWith('"')) ||
            (val.startsWith("'") && val.endsWith("'"))) {
            val = val.slice(1, -1);
        }
        vars[key] = val;
    }
    return vars;
}

export interface ComposeServiceImage {
    service: string;
    image: string;
}

export function extractServiceImagesFromCompose(
    yamlContent: string,
    envVars: Record<string, string>,
): ComposeServiceImage[] {
    let parsed: Record<string, unknown>;
    try {
        parsed = YAML.parse(yamlContent) as Record<string, unknown>;
    } catch {
        return [];
    }
    if (!parsed?.services || typeof parsed.services !== 'object') return [];

    const out: ComposeServiceImage[] = [];
    for (const [service, svc] of Object.entries(parsed.services as Record<string, unknown>)) {
        if (!svc || typeof svc !== 'object') continue;
        const raw = (svc as Record<string, unknown>).image;
        if (!raw || typeof raw !== 'string') continue;

        let ref = raw.replace(
            /\$\{([^}]+)\}/g,
            (_: string, expr: string) => {
                const defaultMatch = expr.match(/^([^:-]+)(?::?-)(.+)$/);
                if (defaultMatch) {
                    return envVars[defaultMatch[1]] ?? defaultMatch[2];
                }
                return envVars[expr] ?? '';
            }
        );

        ref = ref.trim();
        if (!ref || ref.includes('${') || ref.startsWith('sha256:')) continue;
        out.push({ service, image: ref });
    }
    return out;
}

export function extractImagesFromCompose(
    yamlContent: string,
    envVars: Record<string, string>,
): string[] {
    return extractServiceImagesFromCompose(yamlContent, envVars).map(e => e.image);
}

// ─── Service ──────────────────────────────────────────────────────────────────

export class ImageUpdateService {
    private static instance: ImageUpdateService;
    private intervalId: NodeJS.Timeout | null = null;
    private startupTimeoutId: NodeJS.Timeout | null = null;
    private isRunning = false;
    private lastManualRefreshAt = 0;

    private static readonly INTERVAL_MS = 6 * 60 * 60 * 1000;    // 6 hours
    private static readonly STARTUP_DELAY_MS = 2 * 60 * 1000;    // 2 min after boot
    private static readonly MANUAL_COOLDOWN_MS = 2 * 60 * 1000;  // 2 min between manual triggers
    private static readonly INTER_IMAGE_DELAY_MS = 300;           // be polite to registries
    private static readonly CHECK_TIMEOUT_MS = 5 * 60 * 1000;     // 5 min overall cap per scan

    public static get manualCooldownMinutes(): number {
        return ImageUpdateService.MANUAL_COOLDOWN_MS / (60 * 1000);
    }

    private constructor() { }

    public static getInstance(): ImageUpdateService {
        if (!ImageUpdateService.instance) {
            ImageUpdateService.instance = new ImageUpdateService();
        }
        return ImageUpdateService.instance;
    }

    public start() {
        if (this.intervalId) return;
        this.startupTimeoutId = setTimeout(() => this.check(), ImageUpdateService.STARTUP_DELAY_MS);
        this.intervalId = setInterval(() => this.check(), ImageUpdateService.INTERVAL_MS);
    }

    public stop() {
        if (this.startupTimeoutId) {
            clearTimeout(this.startupTimeoutId);
            this.startupTimeoutId = null;
        }
        if (this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = null;
        }
    }

    /**
     * Triggers a check immediately, unless one is already running or the
     * manual cooldown (MANUAL_COOLDOWN_MS) has not elapsed.
     * Returns false if rate-limited, true if a check was started.
     */
    public triggerManualRefresh(): boolean {
        const now = Date.now();
        if (now - this.lastManualRefreshAt < ImageUpdateService.MANUAL_COOLDOWN_MS) {
            return false;
        }
        this.lastManualRefreshAt = now;
        this.check().catch(e => console.error('[ImageUpdateService] Manual refresh error:', e));
        return true;
    }

    public isChecking(): boolean {
        return this.isRunning;
    }

    // ─── Core check ──────────────────────────────────────────────────────────

    private async check() {
        if (this.isRunning) return;
        this.isRunning = true;
        console.log('[ImageUpdateService] Starting image update check...');

        const checkTimeout = setTimeout(() => {
            console.warn('[ImageUpdateService] Check timed out after ' +
                `${ImageUpdateService.CHECK_TIMEOUT_MS / 60_000} minutes; releasing lock`);
            this.isRunning = false;
        }, ImageUpdateService.CHECK_TIMEOUT_MS);

        try {
            const db = DatabaseService.getInstance();
            // Only check local nodes - remote nodes run their own instance
            for (const node of db.getNodes()) {
                if (node.type !== 'local' || !node.id) continue;
                try {
                    await this.checkNode(node.id, node.name, db);
                } catch (e) {
                    console.error(`[ImageUpdateService] Error on node ${node.name}:`, e);
                }
            }
            console.log('[ImageUpdateService] Image update check complete.');
        } catch (e) {
            console.error('[ImageUpdateService] Check failed:', e);
        } finally {
            clearTimeout(checkTimeout);
            this.isRunning = false;
        }
    }

    private async checkNode(nodeId: number, nodeName: string, db: DatabaseService) {
        const docker = DockerController.getInstance(nodeId);
        const fs = FileSystemService.getInstance(nodeId);
        const composeDir = path.resolve(NodeRegistry.getInstance().getComposeDir(nodeId));

        // Phase 1: Filesystem discovery (all stacks with compose files)
        const stacks = await fs.getStacks();
        const stackImages = new Map<string, Set<string>>();
        for (const name of stacks) stackImages.set(name, new Set());

        if (isDebugEnabled()) {
            console.log(`[ImageUpdateService:debug] Node ${nodeId}: Phase 1 complete - ${stacks.length} stack(s) found`);
        }

        // Phase 2: Parse compose files for image refs
        for (const stackName of stacks) {
            try {
                const content = await fs.getStackContent(stackName);

                // Load .env for variable resolution (best-effort)
                let envVars: Record<string, string> = {};
                try {
                    const hasEnv = await fs.envExists(stackName);
                    if (hasEnv) {
                        const envContent = await fs.getEnvContent(stackName);
                        envVars = loadDotEnv(envContent);
                    }
                } catch {
                    // .env file exists but unreadable; continue with process.env only
                }
                // Docker Compose precedence: host env overrides .env
                const merged: Record<string, string> = { ...envVars };
                for (const [k, v] of Object.entries(process.env)) {
                    if (v !== undefined) merged[k] = v;
                }

                for (const img of extractImagesFromCompose(content, merged)) {
                    stackImages.get(stackName)?.add(img);
                }
            } catch (e) {
                console.warn(`[ImageUpdateService] Could not parse compose for "${stackName}":`, e);
            }
        }

        if (isDebugEnabled()) {
            const composeImageCount = [...stackImages.values()].reduce((sum, s) => sum + s.size, 0);
            console.log(`[ImageUpdateService:debug] Node ${nodeId}: Phase 2 complete - ${composeImageCount} image(s) extracted from compose files`);
        }

        // Phase 3: Container augmentation (captures actual deployed image tags)
        try {
            const containers = await docker.getAllContainers();
            for (const c of containers) {
                const workingDir: string | undefined = c.Labels?.['com.docker.compose.project.working_dir'];
                if (!workingDir) continue;

                const resolved = path.resolve(workingDir);
                if (resolved !== composeDir && !resolved.startsWith(composeDir + path.sep)) continue;

                const stackName = path.basename(resolved);
                const imageRef: string = c.Image ?? '';
                if (!imageRef || imageRef.startsWith('sha256:')) continue;

                // Only augment stacks found on the filesystem
                if (stackImages.has(stackName)) {
                    stackImages.get(stackName)?.add(imageRef);
                }
            }
        } catch (e) {
            console.warn('[ImageUpdateService] Container augmentation failed:', e);
        }

        if (isDebugEnabled()) {
            const totalBeforeDedup = [...stackImages.values()].reduce((sum, s) => sum + s.size, 0);
            console.log(`[ImageUpdateService:debug] Node ${nodeId}: Phase 3 complete - ${totalBeforeDedup} image(s) across all stacks (pre-dedup)`);
        }

        // Phase 4: Deduplicate and check all unique images
        const allImages = new Set<string>();
        for (const imgs of stackImages.values()) for (const img of imgs) allImages.add(img);

        const imageUpdateMap = new Map<string, ImageCheckResult>();

        for (const imageRef of allImages) {
            try {
                imageUpdateMap.set(imageRef, await this.checkImage(docker, imageRef));
            } catch (e) {
                console.error(`[ImageUpdateService] Error checking ${sanitizeForLog(imageRef)}:`, sanitizeForLog((e as Error)?.message ?? String(e)));
                imageUpdateMap.set(imageRef, { hasUpdate: false, error: String(e) });
            }
            await sleep(ImageUpdateService.INTER_IMAGE_DELAY_MS);
        }

        // Read previous state to detect new updates for notifications
        const previousState = db.getStackUpdateStatus(nodeId);

        // One-time backfill: pre-existing has_update rows predate the notification pipeline;
        // treat them as unnotified on first run so users get a catch-up entry per affected stack.
        const isBackfilled = db.getSystemState(BACKFILL_KEY) === '1';

        // Write status for ALL stacks (including those with no pullable images)
        const now = Date.now();
        let updatesFound = 0;
        const newlyUpdated: string[] = [];
        for (const [stackName, images] of stackImages) {
            const hasUpdate = Array.from(images).some(img => imageUpdateMap.get(img)?.hasUpdate === true);
            if (hasUpdate) {
                updatesFound++;
                // Notify only on state transition: was false/absent, now true
                if (!isBackfilled || !previousState[stackName]) {
                    newlyUpdated.push(stackName);
                }
            }
            db.upsertStackUpdateStatus(nodeId, stackName, hasUpdate, now);
        }

        // Dispatch notifications for stacks that newly have updates
        if (newlyUpdated.length > 0) {
            const notifier = NotificationService.getInstance();
            for (const stackName of newlyUpdated) {
                try {
                    await notifier.dispatchAlert(
                        'info',
                        'image_update_available',
                        `[Node: ${nodeName}] Stack "${stackName}" has image updates available.`,
                        { stackName, actor: 'system:image-update' },
                    );
                } catch (e) {
                    console.error(`[ImageUpdateService] Failed to dispatch update notification for "${stackName}":`, e);
                    // Direct DB write to avoid recursing through dispatchAlert if it is what failed.
                    // Key on the local default: the iterated `nodeId` may be a remote's id in the
                    // control plane's DB, and the UI never queries that row (it proxies instead).
                    try {
                        db.addNotificationHistory(NodeRegistry.getInstance().getDefaultNodeId(), {
                            level: 'error',
                            category: 'system',
                            message: sanitizeNotificationMessage(
                                `[Node: ${nodeName}] Failed to notify about image updates for stack "${stackName}": ${getErrorMessage(e, String(e))}`,
                                { composeDir: process.env.COMPOSE_DIR },
                            ),
                            timestamp: Date.now(),
                            actor_username: 'system:image-update',
                        });
                    } catch (dbErr) {
                        console.error('[ImageUpdateService] Failed to record dispatch error:', dbErr);
                    }
                }
            }
        }

        // Mark the backfill flag after the first run so future checks use strict transitions.
        if (!isBackfilled) {
            db.setSystemState(BACKFILL_KEY, '1');
        }

        console.log(`[ImageUpdateService] Node ${nodeId}: checked ${allImages.size} image(s), ${updatesFound} stack(s) with updates`);

        // Prune stale entries for stacks no longer on disk (reuse previousState to avoid extra DB read)
        for (const staleStack of Object.keys(previousState)) {
            if (!stackImages.has(staleStack)) {
                db.clearStackUpdateStatus(nodeId, staleStack);
            }
        }
    }

    public async checkImage(docker: DockerController, imageRef: string): Promise<ImageCheckResult> {
        const parsed = parseImageRef(imageRef);
        if (!parsed) return { hasUpdate: false };

        if (isDebugEnabled()) {
            console.log(`[ImageUpdateService] Checking ${imageRef}: registry=${parsed.registry} repo=${parsed.repo} tag=${parsed.tag}`);
        }

        // Look up stored credentials for this registry
        const credentials = await RegistryService.getInstance().getAuthForRegistry(parsed.registry);
        if (isDebugEnabled()) {
            console.log(`[ImageUpdateService] ${imageRef}: credentials ${credentials ? 'found' : 'none'}`);
        }

        // Get local digest from RepoDigests
        let localDigest: string | null = null;
        try {
            const inspect = await docker.getDocker().getImage(imageRef).inspect();
            const repoDigests: string[] = inspect.RepoDigests ?? [];

            for (const rd of repoDigests) {
                if (!rd.includes('@sha256:')) continue;
                const [, digest] = rd.split('@');

                if (rd.includes(parsed.repo) || rd.includes(parsed.registry) || repoDigests.length === 1) {
                    localDigest = digest;
                    break;
                }
            }
        } catch {
            return { hasUpdate: false, error: `Failed to inspect local image "${imageRef}"` };
        }

        if (!localDigest) return { hasUpdate: false };

        const remoteDigest = await getRemoteDigest(parsed.registry, parsed.repo, parsed.tag, credentials);
        if (!remoteDigest) {
            return { hasUpdate: false, error: `Registry unreachable for ${parsed.registry}/${parsed.repo}:${parsed.tag}` };
        }

        const hasUpdate = localDigest !== remoteDigest;
        console.log(
            `[ImageUpdateService] ${imageRef}: ` +
            `local=${localDigest.slice(0, 27)}... remote=${remoteDigest.slice(0, 27)}... update=${hasUpdate}`
        );
        return { hasUpdate };
    }
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}
