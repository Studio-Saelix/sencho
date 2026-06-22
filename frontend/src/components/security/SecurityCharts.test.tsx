import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, act, renderHook } from '@testing-library/react';
import { useTheme } from '@/hooks/use-theme';

// recharts paints nothing at 0x0 in jsdom, so stub every export with a prop-
// capturing element. The real ChartContainer still runs (it injects the
// --color-* vars from SEVERITY_CONFIG), so the token mapping is observable.
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
    // Explicit named exports (vitest validates named imports against real keys,
    // so a Proxy namespace will not do). Covers what SecurityCharts and the shared
    // ChartContainer (ResponsiveContainer / Tooltip / Legend) reference.
    return {
        ResponsiveContainer: stub('ResponsiveContainer'),
        Tooltip: stub('Tooltip'),
        Legend: stub('Legend'),
        PieChart: stub('PieChart'),
        Pie: stub('Pie'),
        AreaChart: stub('AreaChart'),
        Area: stub('Area'),
        BarChart: stub('BarChart'),
        Bar: stub('Bar'),
        XAxis: stub('XAxis'),
        YAxis: stub('YAxis'),
        CartesianGrid: stub('CartesianGrid'),
        LabelList: stub('LabelList'),
    };
});

import { RiskTrendChart, FindingsByTypeChart, SeverityDonutChart } from './SecurityCharts';
import type { ScanSummary, SecurityRiskTrendPoint } from '@/types/security';

const TREND: SecurityRiskTrendPoint[] = [
    { date: '2026-06-01', critical: 2, high: 5 },
    { date: '2026-06-02', critical: 1, high: 3 },
];

const SUMMARY: ScanSummary = {
    image_ref: 'nginx:1.27',
    highest_severity: 'CRITICAL',
    scanned_at: 0,
    scan_id: 1,
    total: 11,
    critical: 2, high: 5, medium: 3, low: 1, unknown: 0,
    fixable: 3,
    secret_count: 1, misconfig_count: 4,
};

function configureChart(opts: { chartStyle?: 'muted' | 'heat' | 'signature'; reducedEffects?: boolean; readability?: boolean } = {}) {
    const { result } = renderHook(() => useTheme());
    act(() => {
        result.current.setReadability(false);
        result.current.setVisualStyle('signature');
        if (opts.chartStyle) result.current.setChartStyle(opts.chartStyle);
        if (opts.reducedEffects) result.current.setReducedEffects(true);
        if (opts.readability) result.current.setReadability(true);
    });
}

describe('SecurityCharts palette routing', () => {
    beforeEach(() => configureChart());

    it('routes FindingsByType through --sev-* / neutral (no destructive/warning/brand)', () => {
        const { container } = render(<FindingsByTypeChart summaries={[SUMMARY]} />);
        const chart = container.querySelector('[data-rc="BarChart"]');
        const data = JSON.parse(chart!.getAttribute('data-chartdata')!) as { fill: string }[];
        expect(data.map((d) => d.fill)).toEqual(['var(--sev-vuln)', 'var(--sev-critical)', 'var(--stat-icon)']);
        for (const d of data) {
            expect(d.fill).not.toMatch(/--(destructive|warning|brand)\)/);
        }
    });

    it('maps the four donut severities to the --sev-* tokens', () => {
        const { container } = render(<SeverityDonutChart summaries={[SUMMARY]} />);
        const css = container.querySelector('style')?.textContent ?? '';
        expect(css).toContain('--color-critical: var(--sev-critical)');
        expect(css).toContain('--color-high: var(--sev-high)');
        expect(css).toContain('--color-medium: var(--sev-medium)');
        expect(css).toContain('--color-low: var(--sev-low)');
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

    it('uses the heat fill (0.15) with no gradient under Heat', () => {
        configureChart({ chartStyle: 'heat' });
        const { container } = render(<RiskTrendChart trend={TREND} />);
        const areas = [...container.querySelectorAll('[data-rc="Area"]')];
        expect(areas).toHaveLength(2);
        for (const a of areas) {
            expect(a.getAttribute('data-fill')).toMatch(/^var\(--color-/);
            expect(a.getAttribute('data-fillopacity')).toBe('0.15');
            expect(a.getAttribute('data-strokewidth')).toBe('1.9');
        }
    });

    it('dims the fill further and flattens under reduced effects, even in Signature', () => {
        configureChart({ chartStyle: 'signature', reducedEffects: true });
        const { container } = render(<RiskTrendChart trend={TREND} />);
        const areas = [...container.querySelectorAll('[data-rc="Area"]')];
        for (const a of areas) {
            expect(a.getAttribute('data-fill')).toMatch(/^var\(--color-/);
            expect(a.getAttribute('data-strokewidth')).toBe('1.9');
            // 0.30 * 0.62
            expect(Number(a.getAttribute('data-fillopacity'))).toBeCloseTo(0.186, 5);
        }
    });
});
