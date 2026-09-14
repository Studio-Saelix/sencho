import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import type { ReactNode } from 'react';
import { BuildInfoProvider } from './BuildInfoProvider';
import { useBuildInfo } from '@/hooks/useBuildInfo';

const { currentUserRef } = vi.hoisted(() => ({
    currentUserRef: { value: null as { username: string; role: string } | null },
}));

vi.mock('./AuthContext', () => ({
    useAuth: () => ({ user: currentUserRef.value }),
}));

vi.mock('@/lib/api', () => ({
    apiFetch: vi.fn(),
}));
import { apiFetch } from '@/lib/api';

const restrictedViewer = {
    version: '0.97.1',
    channel: 'stable',
    imageChannel: 'hardened',
    imageRef: null,
    imageId: 'b'.repeat(64),
    revision: null,
    restricted: true,
};

const adminCommunity = {
    version: '0.97.1',
    channel: 'dev',
    imageChannel: 'community',
    imageRef: 'ghcr.io/studio-saelix/sencho-dev:dev',
    imageId: 'a'.repeat(64),
    revision: null,
    restricted: false,
};

function json(data: unknown, status = 200): Response {
    return new Response(JSON.stringify(data), { status });
}

function Harness() {
    const { buildInfo, status } = useBuildInfo();
    return <div data-testid="s">{status}:{buildInfo?.imageRef ?? 'none'}</div>;
}

function wrapper({ children }: { children: ReactNode }) {
    return <BuildInfoProvider>{children}</BuildInfoProvider>;
}

async function flush() {
    await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
    });
}

describe('BuildInfoProvider', () => {
    beforeEach(() => {
        currentUserRef.value = null;
        vi.mocked(apiFetch).mockReset();
    });

    it('clears permission-filtered state and refetches when the auth identity changes', async () => {
        currentUserRef.value = { username: 'admin', role: 'admin' };
        vi.mocked(apiFetch).mockResolvedValue(json(adminCommunity));
        const { rerender } = render(<Harness />, { wrapper });
        await flush();
        expect(screen.getByTestId('s').textContent).toContain('ready');
        expect(screen.getByTestId('s').textContent).toContain('ghcr.io/studio-saelix/sencho-dev:dev');

        // A viewer session must never see the admin-cached ref: the provider
        // clears immediately and rejects the stale in-flight completion.
        currentUserRef.value = { username: 'viewer', role: 'viewer' };
        vi.mocked(apiFetch).mockResolvedValue(json(restrictedViewer));
        rerender(<Harness />);
        // Cleared synchronously on the identity change, before the refetch lands.
        expect(screen.getByTestId('s').textContent).toBe('loading:none');
        await flush();
        expect(screen.getByTestId('s').textContent).toBe('ready:none');
    });

    it('rejects a stale in-flight completion from a prior identity', async () => {
        currentUserRef.value = { username: 'admin', role: 'admin' };
        let resolveAdmin!: (r: Response) => void;
        vi.mocked(apiFetch).mockReturnValue(new Promise((res) => { resolveAdmin = res; }));
        const { rerender } = render(<Harness />, { wrapper });

        currentUserRef.value = { username: 'viewer', role: 'viewer' };
        vi.mocked(apiFetch).mockResolvedValue(json(restrictedViewer));
        rerender(<Harness />);
        await flush();
        expect(screen.getByTestId('s').textContent).toBe('ready:none');

        // The old admin request resolving later must not surface its ref.
        await act(async () => { resolveAdmin(json(adminCommunity)); });
        expect(screen.getByTestId('s').textContent).toBe('ready:none');
    });

    it('shares one fetch across two consumers', async () => {
        currentUserRef.value = { username: 'admin', role: 'admin' };
        vi.mocked(apiFetch).mockResolvedValue(json(adminCommunity));
        render(
            <BuildInfoProvider>
                <Harness />
                <Harness />
            </BuildInfoProvider>,
        );
        await flush();
        expect(apiFetch).toHaveBeenCalledTimes(1);
        expect(apiFetch).toHaveBeenCalledWith('/build-info', expect.objectContaining({ localOnly: true }));
        expect(screen.getAllByTestId('s')).toHaveLength(2);
        for (const el of screen.getAllByTestId('s')) {
            expect(el.textContent).toContain('ghcr.io/studio-saelix/sencho-dev:dev');
        }
    });

    it('surfaces error as Unknown and retries on focus', async () => {
        currentUserRef.value = { username: 'admin', role: 'admin' };
        vi.mocked(apiFetch).mockRejectedValue(new Error('down'));
        render(<Harness />, { wrapper });
        await flush();
        expect(screen.getByTestId('s').textContent).toBe('error:none');

        vi.mocked(apiFetch).mockResolvedValue(json(adminCommunity));
        await act(async () => {
            window.dispatchEvent(new Event('focus'));
            await Promise.resolve();
            await Promise.resolve();
        });
        expect(screen.getByTestId('s').textContent).toBe('ready:ghcr.io/studio-saelix/sencho-dev:dev');
    });
});