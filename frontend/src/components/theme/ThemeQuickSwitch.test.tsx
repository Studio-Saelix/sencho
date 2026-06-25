import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act, renderHook } from '@testing-library/react';
import { ThemeQuickSwitch } from './ThemeQuickSwitch';
import { useTheme } from '@/hooks/use-theme';

function resetTheme() {
    const { result } = renderHook(() => useTheme());
    act(() => {
        result.current.setReadability(false);
        result.current.setVisualStyle('calm');
    });
}

describe('ThemeQuickSwitch', () => {
    beforeEach(() => resetTheme());

    it('replaces the font pickers with a Visual style switch and a Readability toggle', () => {
        render(<ThemeQuickSwitch />);
        fireEvent.click(screen.getByRole('button', { name: 'Theme' }));
        expect(screen.getByRole('radiogroup', { name: 'Visual style' })).toBeTruthy();
        expect(screen.getByRole('switch', { name: 'Readability mode' })).toBeTruthy();
        // Interface / Data font pickers are gone; Text size stays.
        expect(screen.queryByText('Interface')).toBeNull();
        expect(screen.getByText('Text size')).toBeTruthy();
    });

    it('switching the visual style from the panel applies it', () => {
        render(<ThemeQuickSwitch />);
        fireEvent.click(screen.getByRole('button', { name: 'Theme' }));
        fireEvent.click(screen.getByRole('radio', { name: 'Signature' }));
        expect(document.documentElement.dataset.headings).toBe('signature');
    });

    it('locks the Visual style switch while readability is on', () => {
        render(<ThemeQuickSwitch />);
        fireEvent.click(screen.getByRole('button', { name: 'Theme' }));
        fireEvent.click(screen.getByRole('switch', { name: 'Readability mode' }));
        expect(screen.getByRole('radiogroup', { name: 'Visual style' }).getAttribute('aria-disabled')).toBe('true');
    });

    it('the Settings link calls onOpenAppearance', () => {
        const onOpenAppearance = vi.fn();
        render(<ThemeQuickSwitch onOpenAppearance={onOpenAppearance} />);
        fireEvent.click(screen.getByRole('button', { name: 'Theme' }));
        fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
        expect(onOpenAppearance).toHaveBeenCalledTimes(1);
    });
});
