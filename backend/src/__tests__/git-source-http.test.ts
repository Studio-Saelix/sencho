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
import { GitSourceError } from '../services/GitSourceService';

describe('gitSourceStatus', () => {
    it('maps AUTH_FAILED to 400, never 401', () => {
        expect(gitSourceStatus('AUTH_FAILED')).toBe(400);
    });

    it('maps resource-missing codes to 404', () => {
        expect(gitSourceStatus('REPO_NOT_FOUND')).toBe(404);
        expect(gitSourceStatus('BRANCH_NOT_FOUND')).toBe(404);
        expect(gitSourceStatus('FILE_NOT_FOUND')).toBe(404);
    });

    it('maps NETWORK_TIMEOUT to 504', () => {
        expect(gitSourceStatus('NETWORK_TIMEOUT')).toBe(504);
    });

    it('maps unknown codes to 400', () => {
        expect(gitSourceStatus('GIT_ERROR')).toBe(400);
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
});
