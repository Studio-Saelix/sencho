import { describe, it, expect, vi } from 'vitest';
import { applyNavigateEvent, deriveMobileSurface, type MobileSurfaceInput } from './mobile-surface';

const base: MobileSurfaceInput = {
    activeView: 'dashboard',
    selectedFile: null,
    mobileView: 'list',
    pendingDetailStack: null,
};

describe('deriveMobileSurface', () => {
    it('shows the list when mobileView is list and no detail is open', () => {
        expect(deriveMobileSurface(base)).toEqual({ surface: 'list', detailReady: false, detailOpen: false });
    });

    it('shows content when mobileView is content', () => {
        expect(deriveMobileSurface({ ...base, mobileView: 'content', activeView: 'fleet' }).surface).toBe('content');
    });

    it('shows a ready detail when a stack is selected in editor view', () => {
        expect(deriveMobileSurface({ ...base, activeView: 'editor', selectedFile: 'web.yml' })).toEqual({
            surface: 'detail',
            detailReady: true,
            detailOpen: true,
        });
    });

    it('shows the detail optimistically while a tap is pending and not yet ready', () => {
        const r = deriveMobileSurface({ ...base, pendingDetailStack: 'web.yml' });
        expect(r.surface).toBe('detail');
        expect(r.detailOpen).toBe(true);
        expect(r.detailReady).toBe(false);
    });

    it('falls back to the list once a pending tap clears without a selection (load-failed path)', () => {
        expect(deriveMobileSurface({ ...base, pendingDetailStack: null, selectedFile: null }).surface).toBe('list');
    });

    it('gives the detail precedence over a content view', () => {
        expect(
            deriveMobileSurface({ ...base, mobileView: 'content', activeView: 'editor', selectedFile: 'web.yml' }).surface,
        ).toBe('detail');
    });
});

describe('applyNavigateEvent', () => {
    it('runs the change behind the content-surface hop on a phone', () => {
        const order: string[] = [];
        applyNavigateEvent(true, (then) => { order.push('surface'); then(); }, () => order.push('apply'));
        expect(order).toEqual(['surface', 'apply']);
    });

    it('runs the change directly, with no surface hop, off a phone', () => {
        const hop = vi.fn();
        const apply = vi.fn();
        applyNavigateEvent(false, hop, apply);
        expect(hop).not.toHaveBeenCalled();
        expect(apply).toHaveBeenCalledTimes(1);
    });

    it('does not apply the change until the surface hop lets it (an unsaved-changes guard may hold it)', () => {
        const apply = vi.fn();
        applyNavigateEvent(true, () => { /* guard keeps the editor open */ }, apply);
        expect(apply).not.toHaveBeenCalled();
    });
});
