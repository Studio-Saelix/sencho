/**
 * A local Blueprint apply evaluates the policy gate twice: once on the
 * Blueprint's authored content, then again on the stack as written to disk under
 * the stack lock. Both go through the engine, which writes an allowed-evidence
 * row for a decision made on incomplete evidence, so unless the first opts out
 * one apply is counted twice, under two actors and two paths.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';

const enforcePolicyForImageRefs = vi.fn();
vi.mock('../services/PolicyEnforcement', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../services/PolicyEnforcement')>()),
    enforcePolicyForImageRefs: (...args: unknown[]) => enforcePolicyForImageRefs(...args),
}));

let tmpDir: string;

beforeAll(async () => {
    tmpDir = await setupTestDb();
});
afterAll(() => {
    vi.restoreAllMocks();
    cleanupTestDb(tmpDir);
});

describe('BlueprintService.deployLocal gate', () => {
    it('does not write its own allowed-evidence row, because the apply that follows audits the decision', async () => {
        enforcePolicyForImageRefs.mockResolvedValue({ ok: true, bypassed: false, violations: [] });
        const { BlueprintService } = await import('../services/BlueprintService');
        const svc = BlueprintService.getInstance();
        const apply = vi.spyOn(svc as unknown as { applyLocalUnderLock: () => Promise<{ ran: boolean }> }, 'applyLocalUnderLock')
            .mockResolvedValue({ ran: true });
        vi.spyOn(console, 'error').mockImplementation(() => undefined);

        const blueprint = { id: 5, name: 'bp-web', compose_content: 'services:\n  web:\n    image: nginx:1.27\n' };
        await (svc as unknown as {
            deployLocal: (b: unknown, n: unknown, m: unknown) => Promise<void>;
        }).deployLocal(blueprint, { id: 1 }, {}).catch(() => undefined);

        expect(enforcePolicyForImageRefs).toHaveBeenCalledTimes(1);
        const options = enforcePolicyForImageRefs.mock.calls[0][3] as { recordAllowedEvidence?: boolean };
        expect(options.recordAllowedEvidence).toBe(false);
        expect(apply).toHaveBeenCalled();
    });
});
