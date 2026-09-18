/**
 * RecoverySection's "Reset interface preferences" is the both-domains reset on
 * top of the shared per-domain reset handler. These tests cover the
 * both-domains reset wiring: both domains go through the shared per-domain
 * reset handler, and the success toast + reload wait until both domain DELETEs
 * settle (a partial reset never claims full success).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }));
vi.mock('@/components/ui/toast-store', () => ({
    toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn(), loading: vi.fn(), dismiss: vi.fn() },
}));

import { apiFetch } from '@/lib/api';
import { toast } from '@/components/ui/toast-store';
import { RecoverySection } from '../RecoverySection';
import { setCurrentSyncUser } from '@/lib/preferences/syncBus';
import { resetPreferenceSync } from '@/lib/preferences/preferenceEvents';

const mockedFetch = apiFetch as unknown as ReturnType<typeof vi.fn>;

function jsonResponse(status: number, body: unknown): Response {
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: new Headers(),
        json: async () => body,
        clone() { return this as Response; },
    } as unknown as Response;
}

async function renderReadySection(): Promise<void> {
    mockedFetch.mockImplementation(async (path: string) => {
        if (String(path).includes('/diagnostics/environment')) {
            return jsonResponse(200, { checks: [] });
        }
        return jsonResponse(200, {
            version: '1.0.0',
            database: { ok: true, integrity: 'ok', path: '', missingTables: [] },
            encryptionKey: { present: true, valid: true },
            docker: { reachable: true },
            auth: { adminCount: 1, userCount: 1, mfaEnrolledCount: 0, ssoProviders: [] },
            config: {},
        });
    });
    render(<RecoverySection />);
    await screen.findByText('Safe actions');
}

describe('RecoverySection: Reset interface preferences (both-domains reset)', () => {
    beforeEach(() => {
        mockedFetch.mockReset();
        localStorage.clear();
        setCurrentSyncUser(7);
        // The toast mock is module-level and shared by both tests in this
        // file; clear it so one test's calls cannot leak into the other's
        // assertion.
        vi.mocked(toast.success).mockClear();
        vi.mocked(toast.error).mockClear();
        resetPreferenceSync();
        vi.useFakeTimers({ shouldAdvanceTime: true });
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('resets both preference domains and reloads after both settle', async () => {
        const reload = vi.fn();
        Object.defineProperty(window, 'location', { value: { ...window.location, reload }, writable: true });

        await renderReadySection();

        // Both DELETEs succeed: no unsaved episode ever appears, so the
        // settle listener fires when the queue drains. The reset's DELETE
        // first GETs a baseline (no known revision in this bare-bus test);
        // the reset enqueues only the DELETE, the tombstone stands until a
        // post-reset user edit stages its own PUT behind it.
        mockedFetch.mockImplementation(async (path: string, opts?: RequestInit) => {
            if (String(path).includes('/diagnostics/environment')) return jsonResponse(200, { checks: [] });
            if (String(path) === '/user-preferences' && (opts?.method ?? 'GET') === 'GET') {
                return jsonResponse(200, {
                    preferences: {
                        appearance: { schemaVersion: 1, revision: 1, updatedAt: 1, data: {} },
                        navigation: { schemaVersion: 1, revision: 1, updatedAt: 1, data: {} },
                    },
                });
            }
            if (opts?.method === 'DELETE') return jsonResponse(200, { domain: 'x', schemaVersion: 0, revision: 2, updatedAt: 1 });
            return jsonResponse(200, { domain: 'x', schemaVersion: 1, revision: 2, updatedAt: 1 });
        });

        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: 'Reset interface preferences' }));
            // Drain the bus's async pumps (two DELETEs) inside act.
            await Promise.resolve();
            await Promise.resolve();
            await Promise.resolve();
            await Promise.resolve();
        });

        // Pure successes emit no unsaved-episode transition, so the success
        // path is the 4s fallback (it settles when no failure appeared).
        await act(async () => {
            vi.advanceTimersByTime(4200);
        });

        await waitFor(() => {
            expect(toast.success).toHaveBeenCalledWith('Interface preferences reset to defaults. Reloading...');
        });
        await waitFor(() => {
            expect(reload).toHaveBeenCalled();
        });
    });

    it('does not claim success while a domain still has unsaved writes', async () => {
        const reload = vi.fn();
        Object.defineProperty(window, 'location', { value: { ...window.location, reload }, writable: true });

        await renderReadySection();

        // No DELETE mock succeeds (requests fail) so an unsaved episode appears.
        mockedFetch.mockImplementation(async (path: string) => {
            if (String(path).includes('/diagnostics/environment')) return jsonResponse(200, { checks: [] });
            return jsonResponse(500, { error: 'unavailable' });
        });

        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: 'Reset interface preferences' }));
            await Promise.resolve();
            await Promise.resolve();
            await Promise.resolve();
            await Promise.resolve();
        });

        // Let the settle poller and the grace-period timer run out: the
        // failure path owns the error surface, so the success toast and the
        // reload must never fire.
        await act(async () => {
            vi.advanceTimersByTime(4200);
        });

        expect(toast.success).not.toHaveBeenCalled();
        expect(reload).not.toHaveBeenCalled();
        // Clear any episode the failure path left so other suites are unaffected.
        resetPreferenceSync();
    });
});
