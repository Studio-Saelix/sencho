import { Loader2 } from 'lucide-react';
import type { BindingPreview } from '@/lib/blueprintsApi';
import { BindingPreviewPanel } from './BindingPreviewPanel';

interface BindingPreviewDialogBodyProps {
    loading: boolean;
    loadError: boolean;
    preview: BindingPreview | null;
    loadErrorMessage: string;
}

export function BindingPreviewDialogBody({
    loading, loadError, preview, loadErrorMessage,
}: BindingPreviewDialogBodyProps) {
    if (loading) {
        return (
            <div className="flex items-center gap-2 text-sm text-stat-subtitle">
                <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={1.5} />
                Loading preview…
            </div>
        );
    }
    if (loadError) {
        return <p className="text-sm text-stat-subtitle">{loadErrorMessage}</p>;
    }
    if (preview) {
        return <BindingPreviewPanel preview={preview} />;
    }
    return null;
}
