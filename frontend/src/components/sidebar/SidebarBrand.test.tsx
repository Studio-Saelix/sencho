import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SidebarBrand, chipDetail } from './SidebarBrand';
import type { BuildInfo } from '@/context/BuildInfoProvider';

function info(channel: BuildInfo['channel']): BuildInfo {
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

describe('SidebarBrand build-identity chip', () => {
    it('shows a DEV text chip for a dev build', () => {
        render(<SidebarBrand isDarkMode={false} buildInfo={info('dev')} />);
        const chip = screen.getByText('DEV');
        expect(chip).toBeInTheDocument();
        // Text is the cue, not color alone.
        expect(chip.tagName).toBe('SPAN');
        expect(chip.textContent).toContain('DEV');
    });

    it('shows a PREVIEW text chip for a preview build', () => {
        render(<SidebarBrand isDarkMode={false} buildInfo={info('preview')} />);
        expect(screen.getByText('PREVIEW')).toBeInTheDocument();
    });

    it('renders no chip for a stable build', () => {
        render(<SidebarBrand isDarkMode={false} buildInfo={info('stable')} />);
        expect(screen.queryByText('DEV')).not.toBeInTheDocument();
        expect(screen.queryByText('PREVIEW')).not.toBeInTheDocument();
    });

    it('renders no chip when build info is unavailable', () => {
        render(<SidebarBrand isDarkMode={false} buildInfo={null} />);
        expect(screen.queryByText('DEV')).not.toBeInTheDocument();
        expect(screen.queryByText('PREVIEW')).not.toBeInTheDocument();
    });

    it('prefers the runtime version when available', () => {
        render(<SidebarBrand isDarkMode={false} buildInfo={info('stable')} />);
        expect(screen.getByText('v0.97.1')).toBeInTheDocument();
    });
});

describe('chipDetail', () => {
    it('reads Restricted for a redacted hardened reference', () => {
        const b: BuildInfo = { ...info('stable'), restricted: true, imageRef: null, revision: null };
        expect(chipDetail(b)).toBe('Restricted');
    });

    it('combines the reference and revision when both are present', () => {
        const b: BuildInfo = { ...info('dev'), revision: 'dev-abc1234' };
        expect(chipDetail(b)).toBe('ghcr.io/studio-saelix/sencho-dev:dev · dev-abc1234');
    });

    it('reads the reference alone when the revision is unknown', () => {
        const b: BuildInfo = { ...info('dev'), revision: null };
        expect(chipDetail(b)).toBe('ghcr.io/studio-saelix/sencho-dev:dev');
    });

    it('reads Unknown when the reference is absent and not restricted', () => {
        const b: BuildInfo = { ...info('dev'), imageRef: null };
        expect(chipDetail(b)).toBe('Unknown');
    });
});