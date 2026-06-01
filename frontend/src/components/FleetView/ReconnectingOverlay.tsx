import { useState, useEffect } from 'react';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface ReconnectingOverlayProps {
    /** Gateway boot timestamp captured pre-update. Null falls back to offline-then-online detection. */
    preUpdateStartedAt: number | null;
}

// Mirrors the backend UPDATE_TIMEOUT_MS (5 minutes) in routes/fleet.ts. Past
// this point we stop asserting the update is in flight and hand control back to
// the operator, but we do not claim failure: a large image pull can legitimately
// run longer than the auto-reload budget.
const RECONNECT_TIMEOUT_SECONDS = 5 * 60;

export function ReconnectingOverlay({ preUpdateStartedAt }: ReconnectingOverlayProps) {
    const [elapsed, setElapsed] = useState(0);
    const timedOut = elapsed >= RECONNECT_TIMEOUT_SECONDS;

    useEffect(() => {
        const timer = setInterval(() => setElapsed(s => s + 1), 1000);
        return () => clearInterval(timer);
    }, []);

    useEffect(() => {
        if (timedOut) return;
        let sawOffline = false;
        const poll = setInterval(async () => {
            try {
                const res = await fetch('/api/health');
                if (!res.ok) {
                    sawOffline = true;
                    return;
                }
                const data = await res.json().catch(() => null) as { startedAt?: number } | null;
                const currentStartedAt = typeof data?.startedAt === 'number' ? data.startedAt : null;

                if (preUpdateStartedAt !== null && currentStartedAt !== null) {
                    if (currentStartedAt !== preUpdateStartedAt) {
                        window.location.reload();
                    }
                    return;
                }

                // Fallback when we don't know the original startedAt: require an offline
                // response first so we don't reload while the old process is still mid-pull.
                if (sawOffline) {
                    window.location.reload();
                }
            } catch {
                sawOffline = true;
            }
        }, 3000);
        return () => clearInterval(poll);
    }, [timedOut, preUpdateStartedAt]);

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-[10px] backdrop-saturate-[1.15]">
            <div className="text-center space-y-4">
                {timedOut ? (
                    <>
                        <AlertTriangle className="w-10 h-10 text-warning mx-auto" strokeWidth={1.5} />
                        <h2 className="text-lg font-medium">Taking longer than expected</h2>
                        <p className="text-sm text-muted-foreground max-w-sm">
                            Sencho has not come back online yet. A large image pull can take a while, so the update may still be finishing. Reload to check, or inspect the Docker host if it persists.
                        </p>
                        <Button variant="outline" size="sm" onClick={() => window.location.reload()}>
                            Reload to check
                        </Button>
                    </>
                ) : (
                    <>
                        <Loader2 className="w-10 h-10 text-muted-foreground animate-spin mx-auto" strokeWidth={1.5} />
                        <h2 className="text-lg font-medium">Updating Sencho...</h2>
                        <p className="text-sm text-muted-foreground max-w-sm">
                            The server is pulling the latest image and restarting. This page will reload automatically.
                        </p>
                        <p className="text-xs text-muted-foreground tabular-nums">{elapsed}s elapsed</p>
                    </>
                )}
            </div>
        </div>
    );
}
