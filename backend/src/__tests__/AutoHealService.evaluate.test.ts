import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';

let tmpDir: string;
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;
let AutoHealService: typeof import('../services/AutoHealService').AutoHealService;
let DockerController: typeof import('../services/DockerController').default;
let DockerEventManager: typeof import('../services/DockerEventManager').DockerEventManager;
let LicenseService: typeof import('../services/LicenseService').LicenseService;
let NotificationService: typeof import('../services/NotificationService').NotificationService;

function makePolicy(
    db: import('../services/DatabaseService').DatabaseService,
    overrides: Partial<import('../services/DatabaseService').AutoHealPolicy> = {},
) {
    const nodeId = db.getDefaultNode()?.id ?? 1;
    const now = Date.now();
    return db.addAutoHealPolicy({
        node_id: nodeId,
        proxy_entitled_until: 0,
        stack_name: 'heal-stack',
        service_name: null,
        unhealthy_duration_mins: 1,
        cooldown_mins: 5,
        max_restarts_per_hour: 3,
        auto_disable_after_failures: 2,
        enabled: 1,
        consecutive_failures: 0,
        last_fired_at: 0,
        created_at: now,
        updated_at: now,
        ...overrides,
    });
}

function resetAutoHealSingleton() {
    (AutoHealService as unknown as { instance?: unknown }).instance = undefined;
    return AutoHealService.getInstance();
}

beforeAll(async () => {
    tmpDir = await setupTestDb();
    ({ DatabaseService } = await import('../services/DatabaseService'));
    ({ AutoHealService } = await import('../services/AutoHealService'));
    ({ default: DockerController } = await import('../services/DockerController'));
    ({ DockerEventManager } = await import('../services/DockerEventManager'));
    ({ LicenseService } = await import('../services/LicenseService'));
    ({ NotificationService } = await import('../services/NotificationService'));
});

beforeEach(() => {
    vi.restoreAllMocks();
    const db = DatabaseService.getInstance();
    db.getDb().prepare('DELETE FROM auto_heal_history').run();
    db.getDb().prepare('DELETE FROM auto_heal_policies').run();
    vi.spyOn(NotificationService.getInstance(), 'dispatchAlert').mockResolvedValue();
});

afterAll(() => {
    vi.restoreAllMocks();
    cleanupTestDb(tmpDir);
});

describe('AutoHealService.evaluate', () => {
    it('does not evaluate existing policies on Community tier', async () => {
        const db = DatabaseService.getInstance();
        makePolicy(db);
        vi.spyOn(LicenseService.getInstance(), 'getTier').mockReturnValue('community');
        const dockerSpy = vi.spyOn(DockerController, 'getInstance');

        await resetAutoHealSingleton().evaluate();

        expect(dockerSpy).not.toHaveBeenCalled();
    });

    it('evaluates trusted proxy-entitled policies on a Community runtime node', async () => {
        const db = DatabaseService.getInstance();
        makePolicy(db, { proxy_entitled_until: Date.now() + 60_000 });
        vi.spyOn(LicenseService.getInstance(), 'getTier').mockReturnValue('community');
        const getRunningContainers = vi.fn().mockResolvedValue([]);
        const getInstance = vi.spyOn(DockerController, 'getInstance').mockReturnValue({
            getRunningContainers,
        } as unknown as ReturnType<typeof DockerController.getInstance>);

        await resetAutoHealSingleton().evaluate();

        expect(getInstance).toHaveBeenCalled();
    });

    it('heals a currently unhealthy container after the observed threshold elapses without event state', async () => {
        const db = DatabaseService.getInstance();
        const policy = makePolicy(db);
        vi.spyOn(LicenseService.getInstance(), 'getTier').mockReturnValue('paid');
        const restartContainer = vi.fn().mockResolvedValue(undefined);
        vi.spyOn(DockerController, 'getInstance').mockReturnValue({
            getRunningContainers: vi.fn().mockResolvedValue([{
                Id: 'container-1',
                Names: ['/heal-stack-web-1'],
                Labels: {
                    'com.docker.compose.project': 'heal-stack',
                    'com.docker.compose.service': 'web',
                },
                State: 'running',
                Status: 'Up 5 minutes (unhealthy)',
            }]),
            restartContainer,
        } as unknown as ReturnType<typeof DockerController.getInstance>);
        vi.spyOn(DockerEventManager.getInstance(), 'getService').mockReturnValue({
            getContainerState: () => undefined,
        } as unknown as ReturnType<ReturnType<typeof DockerEventManager.getInstance>['getService']>);

        const service = resetAutoHealSingleton();
        (service as unknown as { observedUnhealthySince: Map<string, number> }).observedUnhealthySince
            .set(`1:container-1`, Date.now() - 2 * 60_000);

        await service.evaluate();

        expect(restartContainer).toHaveBeenCalledWith('container-1');
        const history = db.getAutoHealHistory(policy.id!);
        expect(history[0]).toMatchObject({ action: 'restarted', success: 1 });
    });

    it('records Docker unavailable history once per throttle window when listing containers fails', async () => {
        const db = DatabaseService.getInstance();
        const policy = makePolicy(db);
        vi.spyOn(LicenseService.getInstance(), 'getTier').mockReturnValue('paid');
        vi.spyOn(DockerController, 'getInstance').mockReturnValue({
            getRunningContainers: vi.fn().mockRejectedValue(new Error('permission denied')),
        } as unknown as ReturnType<typeof DockerController.getInstance>);

        const service = resetAutoHealSingleton();
        await service.evaluate();
        await service.evaluate();

        const history = db.getAutoHealHistory(policy.id!);
        expect(history).toHaveLength(1);
        expect(history[0]).toMatchObject({
            action: 'docker_unavailable',
            success: 0,
            error: 'permission denied',
        });
    });

    it('evaluates only policies scoped to each local node', async () => {
        const db = DatabaseService.getInstance();
        const secondNodeId = db.addNode({
            name: 'second-local',
            type: 'local',
            compose_dir: process.env.COMPOSE_DIR ?? '',
            is_default: false,
            api_url: '',
            api_token: '',
        });
        makePolicy(db, { node_id: secondNodeId, stack_name: 'second-stack' });
        vi.spyOn(LicenseService.getInstance(), 'getTier').mockReturnValue('paid');
        const getRunningContainers = vi.fn().mockResolvedValue([]);
        const getInstance = vi.spyOn(DockerController, 'getInstance').mockReturnValue({
            getRunningContainers,
        } as unknown as ReturnType<typeof DockerController.getInstance>);

        await resetAutoHealSingleton().evaluate();

        expect(getInstance).toHaveBeenCalledTimes(1);
        expect(getInstance).toHaveBeenCalledWith(secondNodeId);
    });

    it('keeps restart rate-limit state isolated by node while pruning', async () => {
        const db = DatabaseService.getInstance();
        const secondNodeId = db.addNode({
            name: 'rate-limit-second-local',
            type: 'local',
            compose_dir: process.env.COMPOSE_DIR ?? '',
            is_default: false,
            api_url: '',
            api_token: '',
        });
        const policy = makePolicy(db, { node_id: secondNodeId, stack_name: 'second-rate-stack' });
        vi.spyOn(DockerController, 'getInstance').mockReturnValue({
            getRunningContainers: vi.fn().mockResolvedValue([]),
        } as unknown as ReturnType<typeof DockerController.getInstance>);

        const service = resetAutoHealSingleton();
        const restartTimestamps = (service as unknown as { restartTimestamps: Map<string, number[]> }).restartTimestamps;
        const nodeOneKey = '1:node-one-container';
        restartTimestamps.set(nodeOneKey, [Date.now()]);

        await (service as unknown as {
            evaluateForNode: (nodeId: number, policies: import('../services/DatabaseService').AutoHealPolicy[]) => Promise<void>;
        }).evaluateForNode(secondNodeId, [policy]);

        expect(restartTimestamps.has(nodeOneKey)).toBe(true);
    });

    it('prunes observed health and history throttle entries for removed containers and deleted policies', async () => {
        const db = DatabaseService.getInstance();
        const policy = makePolicy(db, { stack_name: 'cleanup-stack' });
        vi.spyOn(DockerController, 'getInstance').mockReturnValue({
            getRunningContainers: vi.fn().mockResolvedValue([]),
        } as unknown as ReturnType<typeof DockerController.getInstance>);

        const service = resetAutoHealSingleton();
        const internals = service as unknown as {
            observedUnhealthySince: Map<string, number>;
            historyTimestamps: Map<string, number>;
            evaluateForNode: (nodeId: number, policies: import('../services/DatabaseService').AutoHealPolicy[]) => Promise<void>;
        };
        internals.observedUnhealthySince.set('1:removed-container', Date.now());
        internals.historyTimestamps.set(`1:${policy.id}:removed-container:skipped_cooldown`, Date.now());
        db.deleteAutoHealPolicy(policy.id!);

        await internals.evaluateForNode(1, []);

        expect(internals.observedUnhealthySince.has('1:removed-container')).toBe(false);
        expect(internals.historyTimestamps.size).toBe(0);
    });

    it('does not create duplicate timers when start is called twice', () => {
        vi.useFakeTimers();
        try {
            const service = resetAutoHealSingleton();
            const setTimeoutSpy = vi.spyOn(global, 'setTimeout');
            const setIntervalSpy = vi.spyOn(global, 'setInterval');

            service.start();
            service.start();

            expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
            vi.advanceTimersByTime(10_000);
            expect(setIntervalSpy).toHaveBeenCalledTimes(1);
            service.stop();
        } finally {
            vi.useRealTimers();
        }
    });
});
