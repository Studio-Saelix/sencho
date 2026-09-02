/**
 * Tests for the git-source HTTP status mapping.
 *
 * These tests codify the design rule that AUTH_FAILED must not map to 401:
 * the frontend's apiFetch treats 401 as a Sencho session expiry and fires a
 * global logout event. A bad upstream git-host token is a user-fixable input
 * error and must return 400 with `code: 'AUTH_FAILED'` in the body so the
 * caller can still branch on the specific cause.
 */
import { describe, it, expect, vi } from 'vitest';
import type { Response } from 'express';
import { gitSourceStatus, sendGitSourceError, webhookPullStatus } from '../utils/gitSourceHttp';
import { GitSourceError, type GitSourceErrorCode } from '../services/GitSourceService';

describe('gitSourceStatus', () => {
    it('maps AUTH_FAILED to 400, never 401', () => {
        expect(gitSourceStatus('AUTH_FAILED')).toBe(400);
    });

    it('maps resource-missing codes to 404', () => {
        expect(gitSourceStatus('REPO_NOT_FOUND')).toBe(404);
        expect(gitSourceStatus('REF_NOT_FOUND')).toBe(404);
        expect(gitSourceStatus('REF_DELETED')).toBe(404);
        expect(gitSourceStatus('FILE_NOT_FOUND')).toBe(404);
    });

    it('maps UNSUPPORTED_REF to 400', () => {
        expect(gitSourceStatus('UNSUPPORTED_REF')).toBe(400);
    });

    it('maps SSH_HOST_KEY_FAILED to 400', () => {
        expect(gitSourceStatus('SSH_HOST_KEY_FAILED')).toBe(400);
    });

    it('maps NETWORK_TIMEOUT to 504', () => {
        expect(gitSourceStatus('NETWORK_TIMEOUT')).toBe(504);
    });

    it('maps PLAN_FINGERPRINT_REQUIRED to 400', () => {
        expect(gitSourceStatus('PLAN_FINGERPRINT_REQUIRED')).toBe(400);
    });

    it('maps stale, blocked, legacy, and unavailable plans to 409', () => {
        expect(gitSourceStatus('STALE_PLAN')).toBe(409);
        expect(gitSourceStatus('PLAN_BLOCKED')).toBe(409);
        expect(gitSourceStatus('LEGACY_PENDING')).toBe(409);
        expect(gitSourceStatus('PLAN_UNAVAILABLE')).toBe(409);
    });

    it('maps GIT_ERROR to 400', () => {
        expect(gitSourceStatus('GIT_ERROR')).toBe(400);
    });

    it('maps OPERATION_IN_FLIGHT to 409', () => {
        expect(gitSourceStatus('OPERATION_IN_FLIGHT')).toBe(409);
    });

    it('has exactly one explicit mapping for every GitSourceErrorCode', () => {
        const codes: GitSourceErrorCode[] = [
            'REPO_NOT_FOUND', 'AUTH_FAILED', 'REF_NOT_FOUND', 'REF_DELETED', 'UNSUPPORTED_REF',
            'SSH_HOST_KEY_FAILED', 'FILE_NOT_FOUND', 'NETWORK_TIMEOUT', 'GIT_ERROR', 'STALE_PLAN',
            'PLAN_FINGERPRINT_REQUIRED', 'PLAN_BLOCKED', 'LEGACY_PENDING', 'PLAN_UNAVAILABLE',
            'OPERATION_IN_FLIGHT',
        ];
        for (const code of codes) {
            expect(typeof gitSourceStatus(code)).toBe('number');
        }
    });
});

describe('webhookPullStatus', () => {
    it('maps a successful pull/apply to 200', () => {
        expect(webhookPullStatus('success')).toBe(200);
    });

    it('maps a debounced (skipped) pull to 202', () => {
        expect(webhookPullStatus('skipped')).toBe(202);
    });

    it('maps a failed pull/apply to 422, never 200', () => {
        expect(webhookPullStatus('error')).toBe(422);
    });
});

describe('sendGitSourceError', () => {
    function mockRes() {
        const res = { status: vi.fn(), json: vi.fn() } as unknown as Response;
        (res.status as ReturnType<typeof vi.fn>).mockReturnValue(res);
        (res.json as ReturnType<typeof vi.fn>).mockReturnValue(res);
        return res;
    }

    it('sends 400 with code=AUTH_FAILED for upstream auth failures', () => {
        const res = mockRes();
        sendGitSourceError(res, new GitSourceError('AUTH_FAILED', 'Repository authentication failed.'));
        expect(res.status).toHaveBeenCalledWith(400);
        expect(res.json).toHaveBeenCalledWith({
            error: 'Repository authentication failed.',
            code: 'AUTH_FAILED',
        });
    });

    it('sends 500 for unexpected (non-GitSourceError) failures', () => {
        const res = mockRes();
        sendGitSourceError(res, new Error('unrelated crash'));
        expect(res.status).toHaveBeenCalledWith(500);
        expect(res.json).toHaveBeenCalledWith({ error: 'Git source operation failed' });
    });

    it('attaches plan extras on STALE_PLAN and PLAN_BLOCKED', () => {
        const plan = { blocked: true, counts: {}, operations: [], invocation: { candidateChanged: false, liveDiverged: false } };
        const stale = mockRes();
        sendGitSourceError(stale, new GitSourceError('STALE_PLAN', 'stale', { plan: plan as never, planFingerprint: 'fp-new' }));
        expect(stale.status).toHaveBeenCalledWith(409);
        expect(stale.json).toHaveBeenCalledWith({
            error: 'stale',
            code: 'STALE_PLAN',
            plan,
            planFingerprint: 'fp-new',
        });

        const blocked = mockRes();
        sendGitSourceError(blocked, new GitSourceError('PLAN_BLOCKED', 'blocked', { plan: plan as never, planFingerprint: 'fp-b' }));
        expect(blocked.status).toHaveBeenCalledWith(409);
        expect(blocked.json).toHaveBeenCalledWith({
            error: 'blocked',
            code: 'PLAN_BLOCKED',
            plan,
            planFingerprint: 'fp-b',
        });
    });

    it('maps LEGACY_PENDING and PLAN_UNAVAILABLE to 409 without extras', () => {
        const legacy = mockRes();
        sendGitSourceError(legacy, new GitSourceError('LEGACY_PENDING', 'legacy'));
        expect(legacy.status).toHaveBeenCalledWith(409);
        expect(legacy.json).toHaveBeenCalledWith({ error: 'legacy', code: 'LEGACY_PENDING' });

        const missing = mockRes();
        sendGitSourceError(missing, new GitSourceError('PLAN_UNAVAILABLE', 'unavailable'));
        expect(missing.status).toHaveBeenCalledWith(409);
        expect(missing.json).toHaveBeenCalledWith({ error: 'unavailable', code: 'PLAN_UNAVAILABLE' });
    });
});
