import type { ActiveView } from './hooks/useViewNavigationState';

// The top-level mobile surface when no stack detail is open. Kept distinct from
// `activeView` so `dashboard` still maps to HomeDashboard rather than being
// overloaded to mean "the stack list".
export type MobileView = 'list' | 'content';

// The single surface the mobile shell renders at a time.
export type MobileSurface = 'list' | 'content' | 'detail';

export interface MobileSurfaceInput {
    activeView: ActiveView;
    selectedFile: string | null;
    mobileView: MobileView;
    /** Set the instant a row is tapped, before loadFile resolves selectedFile. */
    pendingDetailStack: string | null;
}

export interface MobileSurfaceState {
    surface: MobileSurface;
    /** The real EditorView can mount (a stack is selected and editor is active). */
    detailReady: boolean;
    /** Detail surface should show, including the optimistic pre-fetch window. */
    detailOpen: boolean;
}

/**
 * Pure derivation of which mobile surface to show. Extracted so the state
 * machine can be unit-tested independently of the context-heavy EditorLayout.
 */
export function deriveMobileSurface({
    activeView,
    selectedFile,
    mobileView,
    pendingDetailStack,
}: MobileSurfaceInput): MobileSurfaceState {
    const detailReady = activeView === 'editor' && !!selectedFile;
    const detailOpen = detailReady || !!pendingDetailStack;
    let surface: MobileSurface;
    if (detailOpen) surface = 'detail';
    else if (mobileView === 'list') surface = 'list';
    else surface = 'content';
    return { surface, detailReady, detailOpen };
}
