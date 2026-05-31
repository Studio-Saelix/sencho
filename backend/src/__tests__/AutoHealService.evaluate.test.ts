import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';

let tmpDir: string;
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;
let AutoHealService: typeof import('../services/AutoHealService').AutoHealService;
let DockerController: typeof import('../services/DockerController').default;
let DockerEventManager: typeof import('../services/DockerEventManager').DockerEventManager;
let LicenseService: typeof import('../services/LicenseService').LicenseService;
let NotificationService: typeof import('../services/NotificationService').NotificationService;
let NodeRegistry: typeof import('../services/NodeRegistry').NodeRegistry;

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
    ({ NodeRegistry } = await import('../services/NodeRegistry'));
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
        const getAllContainers = vi.fn().mockResolvedValue([]);
        const getInstance = vi.spyOn(DockerController, 'getInstance').mockReturnValue({
            getAllContainers,
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
            getAllContainers: vi.fn().mockResolvedValue([{
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
        expect(history[0].reason).toContain('unhealthy');
    });

    it('heals a crashed container that stayed down past the threshold', async () => {
        const db = DatabaseService.getInstance();
        const policy = makePolicy(db);
        vi.spyOn(LicenseService.getInstance(), 'getTier').mockReturnValue('paid');
        const restartContainer = vi.fn().mockResolvedValue(undefined);
        vi.spyOn(DockerController, 'getInstance').mockReturnValue({
            getAllContainers: vi.fn().mockResolvedValue([{
                Id: 'crash-1',
                Names: ['/heal-stack-worker-1'],
                Labels: {
                    'com.docker.compose.project': 'heal-stack',
                    'com.docker.compose.service': 'worker',
                },
                State: 'exited',
                Status: 'Exited (1) 2 minutes ago',
            }]),
            restartContainer,
        } as unknown as ReturnType<typeof DockerController.getInstance>);
        vi.spyOn(DockerEventManager.getInstance(), 'getService').mockReturnValue({
            getContainerState: () => ({ id: 'crash-1', crashedAt: Date.now() - 2 * 60_000 }),
        } as unknown as ReturnType<ReturnType<typeof DockerEventManager.getInstance>['getService']>);

        await resetAutoHealSingleton().evaluate();

        expect(restartContainer).toHaveBeenCalledWith('crash-1');
        const history = db.getAutoHealHistory(policy.id!);
        expect(history[0]).toMatchObject({ action: 'restarted', success: 1 });
        expect(history[0].reason).toContain('crashed');
    });

    it('heals a container in the "dead" state when it crashed', async () => {
        const db = DatabaseService.getInstance();
        makePolicy(db);
        vi.spyOn(LicenseService.getInstance(), 'getTier').mockReturnValue('paid');
        const restartContainer = vi.fn().mockResolvedValue(undefined);
        vi.spyOn(DockerController, 'getInstance').mockReturnValue({
            getAllContainers: vi.fn().mockResolvedValue([{
                Id: 'dead-1',
                Names: ['/heal-stack-worker-1'],
                Labels: {
                    'com.docker.compose.project': 'heal-stack',
                    'com.docker.compose.service': 'worker',
                },
                State: 'dead',
                Status: 'Dead',
            }]),
            restartContainer,
        } as unknown as ReturnType<typeof DockerController.getInstance>);
        vi.spyOn(DockerEventManager.getInstance(), 'getService').mockReturnValue({
            getContainerState: () => ({ id: 'dead-1', crashedAt: Date.now() - 2 * 60_000 }),
        } as unknown as ReturnType<ReturnType<typeof DockerEventManager.getInstance>['getService']>);

        await resetAutoHealSingleton().evaluate();

        expect(restartContainer).toHaveBeenCalledWith('dead-1');
    });

    it('does not heal a recovered container that still carries a stale crash signal', async () => {
        // Container crashed earlier (crashedAt set) but is running again now; the
        // live running state must win so we do not restart a healthy container.
        const db = DatabaseService.getInstance();
        makePolicy(db);
        vi.spyOn(LicenseService.getInstance(), 'getTier').mockReturnValue('paid');
        const restartContainer = vi.fn().mockResolvedValue(undefined);
        vi.spyOn(DockerController, 'getInstance').mockReturnValue({
            getAllContainers: vi.fn().mockResolvedValue([{
                Id: 'recovered-1',
                Names: ['/heal-stack-worker-1'],
                Labels: {
                    'com.docker.compose.project': 'heal-stack',
                    'com.docker.compose.service': 'worker',
                },
                State: 'running',
                Status: 'Up 30 seconds',
            }]),
            restartContainer,
        } as unknown as ReturnType<typeof DockerController.getInstance>);
        vi.spyOn(DockerEventManager.getInstance(), 'getService').mockReturnValue({
            getContainerState: () => ({ id: 'recovered-1', crashedAt: Date.now() - 5 * 60_000 }),
        } as unknown as ReturnType<ReturnType<typeof DockerEventManager.getInstance>['getService']>);

        await resetAutoHealSingleton().evaluate();

        expect(restartContainer).not.toHaveBeenCalled();
    });

    it('does not heal an exited container with no crash signal (operator stop / clean exit)', async () => {
        const db = DatabaseService.getInstance();
        makePolicy(db);
        vi.spyOn(LicenseService.getInstance(), 'getTier').mockReturnValue('paid');
        const restartContainer = vi.fn().mockResolvedValue(undefined);
        vi.spyOn(DockerController, 'getInstance').mockReturnValue({
            getAllContainers: vi.fn().mockResolvedValue([{
                Id: 'stopped-1',
                Names: ['/heal-stack-worker-1'],
                Labels: {
                    'com.docker.compose.project': 'heal-stack',
                    'com.docker.compose.service': 'worker',
                },
                State: 'exited',
                Status: 'Exited (0) 2 minutes ago',
            }]),
            restartContainer,
        } as unknown as ReturnType<typeof DockerController.getInstance>);
        vi.spyOn(DockerEventManager.getInstance(), 'getService').mockReturnValue({
            getContainerState: () => ({ id: 'stopped-1' }), // no crashedAt: not a crash
        } as unknown as ReturnType<ReturnType<typeof DockerEventManager.getInstance>['getService']>);

        await resetAutoHealSingleton().evaluate();

        expect(restartContainer).not.toHaveBeenCalled();
    });

    it('restarts a container at most once per pass when policies overlap', async () => {
        const db = DatabaseService.getInstance();
        makePolicy(db); // all services
        makePolicy(db, { service_name: 'worker' }); // service-specific, same container
        vi.spyOn(LicenseService.getInstance(), 'getTier').mockReturnValue('paid');
        const restartContainer = vi.fn().mockResolvedValue(undefined);
        vi.spyOn(DockerController, 'getInstance').mockReturnValue({
            getAllContainers: vi.fn().mockResolvedValue([{
                Id: 'dup-1',
                Names: ['/heal-stack-worker-1'],
                Labels: {
                    'com.docker.compose.project': 'heal-stack',
                    'com.docker.compose.service': 'worker',
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
            .set('1:dup-1', Date.now() - 2 * 60_000);

        await service.evaluate();

        expect(restartContainer).toHaveBeenCalledTimes(1);
    });

    it('counts a failed restart toward cooldown and the hourly cap', async () => {
        const db = DatabaseService.getInstance();
        const policy = makePolicy(db);
        vi.spyOn(LicenseService.getInstance(), 'getTier').mockReturnValue('paid');
        const restartContainer = vi.fn().mockRejectedValue(new Error('no such container'));
        vi.spyOn(DockerController, 'getInstance').mockReturnValue({
            getAllContainers: vi.fn().mockResolvedValue([{
                Id: 'fail-1',
                Names: ['/heal-stack-web-1'],
                Labels: {
                    'com.docker.compose.project': 'heal-stack',
                    'com.docker.compose.service': 'web',
                },
                State: 'running',
                Status: 'Up 1 minute (unhealthy)',
            }]),
            restartContainer,
        } as unknown as ReturnType<typeof DockerController.getInstance>);
        vi.spyOn(DockerEventManager.getInstance(), 'getService').mockReturnValue({
            getContainerState: () => undefined,
        } as unknown as ReturnType<ReturnType<typeof DockerEventManager.getInstance>['getService']>);

        const service = resetAutoHealSingleton();
        (service as unknown as { observedUnhealthySince: Map<string, number> }).observedUnhealthySince
            .set('1:fail-1', Date.now() - 2 * 60_000);

        await service.evaluate();

        expect(restartContainer).toHaveBeenCalledTimes(1);
        const updated = db.getAutoHealPolicy(policy.id!);
        expect(updated!.last_fired_at).toBeGreaterThan(0);
        expect(updated!.consecutive_failures).toBe(1);
        const ts = (service as unknown as { restartTimestamps: Map<string, number[]> }).restartTimestamps.get('1:fail-1');
        expect(ts).toHaveLength(1);
        const history = db.getAutoHealHistory(policy.id!);
        expect(history[0]).toMatchObject({ action: 'failed', success: 0 });
    });

    it('records Docker unavailable history once per throttle window when listing containers fails', async () => {
        const db = DatabaseService.getInstance();
        const policy = makePolicy(db);
        vi.spyOn(LicenseService.getInstance(), 'getTier').mockReturnValue('paid');
        vi.spyOn(DockerController, 'getInstance').mockReturnValue({
            getAllContainers: vi.fn().mockRejectedValue(new Error('permission denied')),
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
        const getAllContainers = vi.fn().mockResolvedValue([]);
        const getInstance = vi.spyOn(DockerController, 'getInstance').mockReturnValue({
            getAllContainers,
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
            getAllContainers: vi.fn().mockResolvedValue([]),
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
            getAllContainers: vi.fn().mockResolvedValue([]),
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

    it('refreshes proxied remote leases from a paid controlling instance', async () => {
        const db = DatabaseService.getInstance();
        db.addNode({
            name: 'lease-remote',
            type: 'remote',
            compose_dir: '',
            is_default: false,
            api_url: 'http://remote:1852',
            api_token: 'tok',
        });
        vi.spyOn(LicenseService.getInstance(), 'getTier').mockReturnValue('paid');
        vi.spyOn(LicenseService.getInstance(), 'getProxyHeaders').mockReturnValue(
            { tier: 'paid', variant: 'admiral' } as ReturnType<ReturnType<typeof LicenseService.getInstance>['getProxyHeaders']>,
        );
        vi.spyOn(NodeRegistry.getInstance(), 'getProxyTarget').mockReturnValue({
            apiUrl: 'http://remote:1852',
            apiToken: 'tok',
        });
        const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue({ ok: true } as Response);

        const service = resetAutoHealSingleton();
        await (service as unknown as { refreshRemoteLeases: () => Promise<void> }).refreshRemoteLeases();

        expect(fetchSpy).toHaveBeenCalledTimes(1);
        const [url, opts] = fetchSpy.mock.calls[0];
        expect(String(url)).toContain('/api/auto-heal/policies');
        expect((opts as RequestInit).headers).toMatchObject({ 'x-sencho-tier': 'paid' });
    });

    it('does not refresh remote leases when the controlling instance is not paid', async () => {
        const db = DatabaseService.getInstance();
        db.addNode({
            name: 'lease-remote-community',
            type: 'remote',
            compose_dir: '',
            is_default: false,
            api_url: 'http://remote2:1852',
            api_token: 'tok2',
        });
        vi.spyOn(LicenseService.getInstance(), 'getTier').mockReturnValue('community');
        const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue({ ok: true } as Response);

        const service = resetAutoHealSingleton();
        await (service as unknown as { refreshRemoteLeases: () => Promise<void> }).refreshRemoteLeases();

        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('keeps refreshing other remotes when one node is unreachable', async () => {
        const db = DatabaseService.getInstance();
        db.addNode({
            name: 'good-remote',
            type: 'remote',
            compose_dir: '',
            is_default: false,
            api_url: 'http://good-host:1852',
            api_token: 'tok',
        });
        db.addNode({
            name: 'unreachable-remote',
            type: 'remote',
            compose_dir: '',
            is_default: false,
            api_url: 'http://bad-host:1852',
            api_token: 'tok',
        });
        vi.spyOn(LicenseService.getInstance(), 'getTier').mockReturnValue('paid');
        vi.spyOn(LicenseService.getInstance(), 'getProxyHeaders').mockReturnValue(
            { tier: 'paid', variant: 'admiral' } as ReturnType<ReturnType<typeof LicenseService.getInstance>['getProxyHeaders']>,
        );
        const fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(((input: unknown) => {
            const url = String(input);
            if (url.includes('bad-host')) return Promise.reject(new Error('ECONNREFUSED'));
            return Promise.resolve({ ok: true } as Response);
        }) as typeof fetch);

        const service = resetAutoHealSingleton();
        // One node rejecting must not throw or block the others.
        await expect(
            (service as unknown as { refreshRemoteLeases: () => Promise<void> }).refreshRemoteLeases(),
        ).resolves.toBeUndefined();

        const calledUrls = fetchSpy.mock.calls.map(c => String(c[0]));
        expect(calledUrls.some(u => u.includes('good-host'))).toBe(true);
        expect(calledUrls.some(u => u.includes('bad-host'))).toBe(true);
    });

    it('warns after repeated lease refreshes find no reachable proxy target', async () => {
        const db = DatabaseService.getInstance();
        db.addNode({
            name: 'no-target-remote',
            type: 'remote',
            compose_dir: '',
            is_default: false,
            api_url: '',
            api_token: '',
        });
        vi.spyOn(LicenseService.getInstance(), 'getTier').mockReturnValue('paid');
        vi.spyOn(LicenseService.getInstance(), 'getProxyHeaders').mockReturnValue(
            { tier: 'paid', variant: 'admiral' } as ReturnType<ReturnType<typeof LicenseService.getInstance>['getProxyHeaders']>,
        );
        vi.spyOn(NodeRegistry.getInstance(), 'getProxyTarget').mockReturnValue(null);
        const fetchSpy = vi.spyOn(global, 'fetch');
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

        const svc = resetAutoHealSingleton() as unknown as { refreshRemoteLeases: () => Promise<void> };
        await svc.refreshRemoteLeases();
        await svc.refreshRemoteLeases();
        expect(warnSpy).not.toHaveBeenCalled();
        await svc.refreshRemoteLeases(); // third consecutive failure crosses the threshold
        expect(warnSpy).toHaveBeenCalled();
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('does not create duplicate timers when start is called twice', () => {
        vi.useFakeTimers();
        try {
            const service = resetAutoHealSingleton();
            const setTimeoutSpy = vi.spyOn(global, 'setTimeout');
            const setIntervalSpy = vi.spyOn(global, 'setInterval');

            service.start();
            service.start();

            // One deferred-first-tick timeout, regardless of how many start() calls.
            expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
            // The lease-refresh interval is created immediately; the eval interval
            // only after the initial delay fires. Calling start() twice must not
            // duplicate either.
            expect(setIntervalSpy).toHaveBeenCalledTimes(1);
            vi.advanceTimersByTime(10_000);
            expect(setIntervalSpy).toHaveBeenCalledTimes(2);
            service.stop();
        } finally {
            vi.useRealTimers();
        }
    });
});
