import { useEffect, useState } from 'react';
import { toast } from '@/components/ui/toast-store';
import type { BindingPreview } from '@/lib/blueprintsApi';

export function useBindingPreview(
    open: boolean,
    blueprintId: number,
    fetchPreview: (blueprintId: number) => Promise<BindingPreview>,
    previewErrorMessage: string,
): { preview: BindingPreview | null; loading: boolean; loadError: boolean } {
    const [preview, setPreview] = useState<BindingPreview | null>(null);
    const [loading, setLoading] = useState(false);
    const [loadError, setLoadError] = useState(false);

    useEffect(() => {
        if (!open) return;
        let cancelled = false;
        setPreview(null);
        setLoadError(false);
        setLoading(true);
        void fetchPreview(blueprintId)
            .then((next) => {
                if (!cancelled) setPreview(next);
            })
            .catch((err: unknown) => {
                if (cancelled) return;
                setLoadError(true);
                toast.error(err instanceof Error ? err.message : previewErrorMessage);
            })
            .finally(() => { if (!cancelled) setLoading(false); });
        return () => { cancelled = true; };
    }, [open, blueprintId, fetchPreview, previewErrorMessage]);

    return { preview, loading, loadError };
}
