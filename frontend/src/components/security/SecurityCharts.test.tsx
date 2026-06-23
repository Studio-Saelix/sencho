import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, act, renderHook, fireEvent } from '@testing-library/react';
import { useTheme } from '@/hooks/use-theme';

// recharts paints nothing at 0x0 in jsdom, so stub every export with a prop-
// capturing element. The real ChartContainer still runs (it injects the
// --color-* vars), so the token mapping is observable.
vi.mock('recharts', async () => {
    const React = await import('react');
    const stub = (tag: string) => (props: Record<string, unknown>) =>
        React.createElement(
            'div',
            {
                'data-rc': tag,
                'data-fill': props.fill as string | undefined,
                'data-fillopacity':
                    props.fillOpacity === undefined ? undefined : String(props.fillOpacity),
                'data-strokewidth':
                    props.strokeWidth === undefined ? undefined : String(props.strokeWidth),
                'data-chartdata': props.data ? JSON.stringify(props.data) : undefined,
            },
            props.children as React.ReactNode,
        );
    return {
        ResponsiveContainer: stub('ResponsiveContainer'),
        Tooltip: stub('Tooltip'),
        Legend: stub('Legend'),
        AreaChart: stub('AreaChart'),
        Area: stub('Area'),
        BarChart: stub('BarChart'),
        Bar: stub('Bar'),
        Cell: stub('Cell'),
        ScatterChart: stub('ScatterChart'),
        Scatter: stub('Scatter'),
        XAxis: stub('XAxis'),
        YAxis: stub('YAxis'),
        ZAxis: stub('ZAxis'),
        CartesianGrid: stub('CartesianGrid'),
        LabelList: stub('LabelList'),
        ReferenceLine: stub('ReferenceLine'),
    };
});

import { RiskTrendChart, ActionPostureChart, TopExploitRiskList, CvssEpssQuadrantChart } from './SecurityCharts';
import type { SecurityOverview, SecurityRiskTrendPoint, ExploitIntelFinding } from '@/types/security';

const TREND: SecurityRiskTrendPoint[] = [
    { date: '2026-06-01', critical: 2, high: 5 },
    { date: '2026-06-02', critical: 1, high: 3 },
];

function overview(o: Partial<SecurityOverview>): SecurityOverview {
    return {
        scannedImages: 0, critical: 0, high: 0, fixable: 0, secrets: 0, misconfigs: 0,
        staleScans: 0, failedScans: 0, lastSuccessfulScanAt: null,
        scanner: { available: true, version: '1', source: 'managed', autoUpdate: false },
        deployEnforcement: { honorSuppressionsOnDeploy: false, eligibleBlockPolicies: 0 },
        rawCritical: 0, rawHigh: 0, fixableCriticalHigh: 0, knownExploited: 0, publiclyExposed: 0,
        dangerousCompose: 0, needsReview: 0, accepted: 0, notAffected: 0, actionable: 0,
        posture: 'Secure', posturePartial: false,
        ...o,
    };
}

function finding(o: Partial<ExploitIntelFinding>): ExploitIntelFinding {
    return {
        vulnerability_id: 'CVE-0000-0000', image_ref: 'img:1', scan_id: 1, severity: 'HIGH',
        cvss_score: null, epss_score: null, epss_percentile: null, kev: false, fixed_version: null,
        ...o,
    };
}

function configureChart(opts: { chartStyle?: 'muted' | 'heat' | 'signature'; reducedEffects?: boolean } = {}) {
    const { result } = renderHook(() => useTheme());
    act(() => {
        result.current.setReadability(false);
        result.current.setVisualStyle('signature');
        if (opts.chartStyle) result.current.setChartStyle(opts.chartStyle);
        if (opts.reducedEffects) result.current.setReducedEffects(true);
    });
}

describe('ActionPostureChart', () => {
    beforeEach(() => configureChart());

    it('renders the five posture bars from the overview facts', () => {
        const { container } = render(
            <ActionPostureChart overview={overview({ fixableCriticalHigh: 3, knownExploited: 1, needsReview: 2, accepted: 1, notAffected: 0, rawCritical: 5, rawHigh: 4 })} />,
        );
        const chart = container.querySelector('[data-rc="BarChart"]');
        const data = JSON.parse(chart!.getAttribute('data-chartdata')!) as { label: string; value: number }[];
        expect(data.map((d) => [d.label, d.value])).toEqual([
            ['Fixable', 3], ['Known exploited', 1], ['Needs review', 2], ['Accepted', 1], ['Not affected', 0],
        ]);
        expect(container.textContent).toContain('known-exploited');
    });

    it('shows an empty state with no Critical or High findings', () => {
        const { container } = render(<ActionPostureChart overview={overview({})} />);
        expect(container.textContent).toContain('No Critical or High findings');
    });
});

describe('TopExploitRiskList', () => {
    it('ranks KEV first, then EPSS, then CVSS, and opens the scan on click', () => {
        const items = [
            finding({ vulnerability_id: 'CVE-LOW', cvss_score: 5, epss_score: 0.01, scan_id: 10 }),
            finding({ vulnerability_id: 'CVE-KEV', cvss_score: 6, kev: true, scan_id: 11 }),
            finding({ vulnerability_id: 'CVE-EPSS', cvss_score: 5, epss_score: 0.8, scan_id: 12 }),
        ];
        const onInspect = vi.fn();
        const { container } = render(<TopExploitRiskList items={items} onInspect={onInspect} />);
        const buttons = [...container.querySelectorAll('button')];
        const order = buttons.map((b) => b.querySelector('.font-mono')?.textContent);
        expect(order).toEqual(['CVE-KEV', 'CVE-EPSS', 'CVE-LOW']);
        fireEvent.click(buttons[0]);
        expect(onInspect).toHaveBeenCalledWith(11);
    });

    it('shows the severity-ranked hint when no intel is present', () => {
        const { container } = render(
            <TopExploitRiskList items={[finding({ vulnerability_id: 'CVE-A', cvss_score: 8 })]} onInspect={vi.fn()} />,
        );
        expect(container.textContent).toContain('Enable exploit intelligence');
    });

    it('shows an empty state with no actionable findings', () => {
        const { container } = render(<TopExploitRiskList items={[]} onInspect={vi.fn()} />);
        expect(container.textContent).toContain('No actionable');
    });
});

describe('CvssEpssQuadrantChart', () => {
    beforeEach(() => configureChart());

    it('plots only findings with both CVSS and EPSS and notes the excluded ones', () => {
        const items = [
            finding({ vulnerability_id: 'CVE-1', cvss_score: 9, epss_score: 0.5, kev: true }),
            finding({ vulnerability_id: 'CVE-2', cvss_score: 7, epss_score: 0.2 }),
            finding({ vulnerability_id: 'CVE-3', cvss_score: 8, epss_score: null }), // excluded
        ];
        const { container } = render(<CvssEpssQuadrantChart items={items} />);
        const scatters = [...container.querySelectorAll('[data-rc="Scatter"]')];
        const plotted = scatters.flatMap((s) => JSON.parse(s.getAttribute('data-chartdata') ?? '[]') as { cve: string }[]);
        expect(plotted.map((p) => p.cve).sort()).toEqual(['CVE-1', 'CVE-2']);
        expect(container.textContent).toContain('not shown');
    });

    it('shows an empty state when no finding has both scores', () => {
        const { container } = render(<CvssEpssQuadrantChart items={[finding({ cvss_score: 9, epss_score: null })]} />);
        expect(container.textContent).toContain('Enable exploit intelligence');
    });
});

describe('RiskTrendChart gradient vs flat', () => {
    beforeEach(() => configureChart());

    it('keeps the gradient fill and stroke 1.5 in Signature (the no-op baseline)', () => {
        configureChart({ chartStyle: 'signature' });
        const { container } = render(<RiskTrendChart trend={TREND} />);
        const areas = [...container.querySelectorAll('[data-rc="Area"]')];
        expect(areas).toHaveLength(2);
        for (const a of areas) {
            expect(a.getAttribute('data-fill')).toMatch(/^url\(#risk/);
            expect(a.getAttribute('data-strokewidth')).toBe('1.5');
            expect(a.getAttribute('data-fillopacity')).toBeNull();
        }
    });

    it('drops the gradient for a solid low-opacity fill under Muted', () => {
        configureChart({ chartStyle: 'muted' });
        const { container } = render(<RiskTrendChart trend={TREND} />);
        const areas = [...container.querySelectorAll('[data-rc="Area"]')];
        for (const a of areas) {
            expect(a.getAttribute('data-fill')).toMatch(/^var\(--color-/);
            expect(a.getAttribute('data-strokewidth')).toBe('1.9');
            expect(a.getAttribute('data-fillopacity')).toBe('0.16');
        }
    });

    it('dims the fill further and flattens under reduced effects, even in Signature', () => {
        configureChart({ chartStyle: 'signature', reducedEffects: true });
        const { container } = render(<RiskTrendChart trend={TREND} />);
        const areas = [...container.querySelectorAll('[data-rc="Area"]')];
        for (const a of areas) {
            expect(a.getAttribute('data-fill')).toMatch(/^var\(--color-/);
            expect(a.getAttribute('data-strokewidth')).toBe('1.9');
            expect(Number(a.getAttribute('data-fillopacity'))).toBeCloseTo(0.186, 5);
        }
    });
});
