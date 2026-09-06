import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Home, Radar, Clock } from 'lucide-react';
import { MobileTabBar } from './MobileTabBar';
import { useBuildInfo } from '@/hooks/useBuildInfo';
import type { BuildInfo } from '@/context/BuildInfoProvider';
import type { NavItem } from './EditorLayout/hooks/useViewNavigationState';

vi.mock('@/hooks/useBuildInfo', () => ({
    useBuildInfo: vi.fn(() => ({ buildInfo: null, status: 'ready', retry: vi.fn() })),
}));

const mockUseBuildInfo = vi.mocked(useBuildInfo);

const allItems: NavItem[] = [
    { value: 'dashboard', label: 'Home', icon: Home },
    { value: 'fleet', label: 'Fleet', icon: Radar },
    { value: 'scheduled-ops', label: 'Schedules', icon: Clock },
];

function buildInfo(channel: BuildInfo['channel']): BuildInfo {
    return {
        version: '0.97.1',
        channel,
        imageChannel: 'community',
        imageRef: channel === 'dev' ? 'ghcr.io/studio-saelix/sencho-dev:dev' : 'ghcr.io/studio-saelix/sencho:0.97.1',
        imageId: 'a'.repeat(64),
        revision: null,
        restricted: false,
    };
}

const noPill = { buildInfo: null, status: 'ready' as const, retry: vi.fn() };

function renderBar(over: Partial<React.ComponentProps<typeof MobileTabBar>> = {}) {
    const props: React.ComponentProps<typeof MobileTabBar> = {
        navItems: allItems,
        activeView: 'dashboard',
        mobileView: 'list',
        detailOpen: false,
        onHome: vi.fn(),
        onStacks: vi.fn(),
        onNavigate: vi.fn(),
        onSettings: vi.fn(),
        ...over,
    };
    render(<MobileTabBar {...props} />);
    return props;
}

describe('MobileTabBar', () => {
    it('always renders Home, Stacks and Settings', () => {
        renderBar();
        expect(screen.getByRole('button', { name: 'Home' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Stacks' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Settings' })).toBeInTheDocument();
    });

    it('renders Fleet and Sched only when present in the gated nav items', () => {
        renderBar({ navItems: [{ value: 'dashboard', label: 'Home', icon: Home }] });
        expect(screen.queryByRole('button', { name: 'Fleet' })).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Sched' })).not.toBeInTheDocument();
        // Home + Stacks + Settings remain.
        expect(screen.getByRole('button', { name: 'Home' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Stacks' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Settings' })).toBeInTheDocument();
    });

    it('routes each tab to its handler', () => {
        const props = renderBar();
        fireEvent.click(screen.getByRole('button', { name: 'Home' }));
        expect(props.onHome).toHaveBeenCalledTimes(1);
        fireEvent.click(screen.getByRole('button', { name: 'Stacks' }));
        expect(props.onStacks).toHaveBeenCalledTimes(1);
        fireEvent.click(screen.getByRole('button', { name: 'Fleet' }));
        expect(props.onNavigate).toHaveBeenCalledWith('fleet');
        fireEvent.click(screen.getByRole('button', { name: 'Sched' }));
        expect(props.onNavigate).toHaveBeenCalledWith('scheduled-ops');
        fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
        expect(props.onSettings).toHaveBeenCalledTimes(1);
    });

    it('marks Stacks as current while a stack detail is open', () => {
        renderBar({ detailOpen: true, mobileView: 'content', activeView: 'fleet' });
        expect(screen.getByRole('button', { name: 'Stacks' })).toHaveAttribute('aria-current', 'page');
        expect(screen.getByRole('button', { name: 'Fleet' })).not.toHaveAttribute('aria-current');
    });

    it('marks Home as current on the dashboard content surface', () => {
        renderBar({ mobileView: 'content', activeView: 'dashboard' });
        expect(screen.getByRole('button', { name: 'Home' })).toHaveAttribute('aria-current', 'page');
        expect(screen.getByRole('button', { name: 'Stacks' })).not.toHaveAttribute('aria-current');
    });

    it('marks the active content view as current', () => {
        renderBar({ mobileView: 'content', activeView: 'fleet' });
        expect(screen.getByRole('button', { name: 'Fleet' })).toHaveAttribute('aria-current', 'page');
        expect(screen.getByRole('button', { name: 'Stacks' })).not.toHaveAttribute('aria-current');
    });
});

describe('MobileTabBar build-identity pill', () => {
    beforeEach(() => {
        mockUseBuildInfo.mockReturnValue(noPill);
    });

    it('shows a text DEV pill for a dev build, not an interactive control', () => {
        mockUseBuildInfo.mockReturnValue({ buildInfo: buildInfo('dev'), status: 'ready', retry: vi.fn() });
        renderBar();
        expect(screen.getByText('DEV')).toBeInTheDocument();
        // The pill is a plain span: it adds no competing tap target in the tab row.
        expect(screen.queryByRole('button', { name: 'DEV' })).not.toBeInTheDocument();
    });

    it('shows a text PREVIEW pill for a preview build', () => {
        mockUseBuildInfo.mockReturnValue({ buildInfo: buildInfo('preview'), status: 'ready', retry: vi.fn() });
        renderBar();
        expect(screen.getByText('PREVIEW')).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'PREVIEW' })).not.toBeInTheDocument();
    });

    it('renders no pill for a stable build', () => {
        mockUseBuildInfo.mockReturnValue({ buildInfo: buildInfo('stable'), status: 'ready', retry: vi.fn() });
        renderBar();
        expect(screen.queryByText('DEV')).not.toBeInTheDocument();
        expect(screen.queryByText('PREVIEW')).not.toBeInTheDocument();
    });

    it('keeps the tab touch targets present alongside the pill', () => {
        mockUseBuildInfo.mockReturnValue({ buildInfo: buildInfo('dev'), status: 'ready', retry: vi.fn() });
        renderBar();
        expect(screen.getByRole('button', { name: 'Home' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Stacks' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Settings' })).toBeInTheDocument();
    });
});
