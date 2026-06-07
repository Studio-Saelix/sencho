import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Home, Radar, Clock } from 'lucide-react';
import { MobileTabBar } from './MobileTabBar';
import type { NavItem } from './EditorLayout/hooks/useViewNavigationState';

const allItems: NavItem[] = [
    { value: 'dashboard', label: 'Home', icon: Home },
    { value: 'fleet', label: 'Fleet', icon: Radar },
    { value: 'scheduled-ops', label: 'Schedules', icon: Clock },
];

function renderBar(over: Partial<React.ComponentProps<typeof MobileTabBar>> = {}) {
    const props: React.ComponentProps<typeof MobileTabBar> = {
        navItems: allItems,
        activeView: 'dashboard',
        mobileView: 'list',
        detailOpen: false,
        onStacks: vi.fn(),
        onNavigate: vi.fn(),
        onSettings: vi.fn(),
        ...over,
    };
    render(<MobileTabBar {...props} />);
    return props;
}

describe('MobileTabBar', () => {
    it('always renders Stacks and Settings', () => {
        renderBar();
        expect(screen.getByRole('button', { name: 'Stacks' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Settings' })).toBeInTheDocument();
    });

    it('renders Fleet and Schedules only when present in the gated nav items', () => {
        renderBar({ navItems: [{ value: 'dashboard', label: 'Home', icon: Home }] });
        expect(screen.queryByRole('button', { name: 'Fleet' })).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Schedules' })).not.toBeInTheDocument();
        // Stacks + Settings remain.
        expect(screen.getByRole('button', { name: 'Stacks' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Settings' })).toBeInTheDocument();
    });

    it('routes each tab to its handler', () => {
        const props = renderBar();
        fireEvent.click(screen.getByRole('button', { name: 'Stacks' }));
        expect(props.onStacks).toHaveBeenCalledTimes(1);
        fireEvent.click(screen.getByRole('button', { name: 'Fleet' }));
        expect(props.onNavigate).toHaveBeenCalledWith('fleet');
        fireEvent.click(screen.getByRole('button', { name: 'Schedules' }));
        expect(props.onNavigate).toHaveBeenCalledWith('scheduled-ops');
        fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
        expect(props.onSettings).toHaveBeenCalledTimes(1);
    });

    it('marks Stacks as current while a stack detail is open', () => {
        renderBar({ detailOpen: true, mobileView: 'content', activeView: 'fleet' });
        expect(screen.getByRole('button', { name: 'Stacks' })).toHaveAttribute('aria-current', 'page');
        expect(screen.getByRole('button', { name: 'Fleet' })).not.toHaveAttribute('aria-current');
    });

    it('marks the active content view as current', () => {
        renderBar({ mobileView: 'content', activeView: 'fleet' });
        expect(screen.getByRole('button', { name: 'Fleet' })).toHaveAttribute('aria-current', 'page');
        expect(screen.getByRole('button', { name: 'Stacks' })).not.toHaveAttribute('aria-current');
    });
});
