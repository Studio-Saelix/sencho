import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PolicyBlockDialog, type PolicyBlockPayload } from '../PolicyBlockDialog';

const payload: PolicyBlockPayload = {
  error: 'blocked',
  policy: { id: 1, name: 'prod-gate', maxSeverity: 'CRITICAL', blockOnSeverity: 0, blockOnKev: 1, blockOnFixable: 1 },
  violations: [
    { imageRef: 'nginx:1.14', severity: 'CRITICAL', criticalCount: 2, highCount: 0, kevCount: 1, fixableCount: 1, reasons: ['kev', 'fixable'], scanId: 1 },
  ],
};

describe('PolicyBlockDialog', () => {
  it('describes the active inputs (KEV + fixable, not the severity threshold)', () => {
    render(
      <PolicyBlockDialog open payload={payload} stackName="web" canBypass={false} bypassing={false} onClose={vi.fn()} onBypass={vi.fn()} />,
    );
    const desc = screen.getAllByText(/known-exploited CVE \(KEV\)/i);
    expect(desc.length).toBeGreaterThan(0);
    expect(screen.getAllByText(/fixable Critical\/High finding/i).length).toBeGreaterThan(0);
  });

  it('renders a reason badge per matched input on the violation row', () => {
    render(
      <PolicyBlockDialog open payload={payload} stackName="web" canBypass={false} bypassing={false} onClose={vi.fn()} onBypass={vi.fn()} />,
    );
    expect(screen.getByText('KEV')).toBeInTheDocument();
    expect(screen.getByText('Fixable')).toBeInTheDocument();
    expect(screen.getByText(/1 KEV/)).toBeInTheDocument();
  });

  it('falls back to severity wording when input flags are absent (older payload)', () => {
    const legacy: PolicyBlockPayload = {
      error: 'blocked',
      policy: { id: 1, name: 'old-gate', maxSeverity: 'HIGH' },
      violations: [{ imageRef: 'redis:7', severity: 'HIGH', criticalCount: 0, highCount: 1, kevCount: 0, fixableCount: 0, reasons: [], scanId: 2 }],
    };
    render(
      <PolicyBlockDialog open payload={legacy} stackName="web" canBypass={false} bypassing={false} onClose={vi.fn()} onBypass={vi.fn()} />,
    );
    expect(screen.getAllByText(/severity at or above HIGH/i).length).toBeGreaterThan(0);
  });
});
