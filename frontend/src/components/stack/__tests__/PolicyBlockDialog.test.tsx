import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PolicyBlockDialog, type PolicyBlockPayload } from '../PolicyBlockDialog';

const publicPayload: PolicyBlockPayload = {
  error: 'blocked',
  policy: { id: 1, name: 'prod-gate', maxSeverity: 'CRITICAL', blockOnSeverity: 0, blockOnKev: 1, blockOnFixable: 1 },
  violations: [
    { imageRef: 'nginx:1.14', severity: 'CRITICAL', criticalCount: 2, highCount: 0, kevCount: 1, fixableCount: 1, reasons: ['kev', 'fixable'], scanId: 1 },
  ],
};

describe('PolicyBlockDialog evidence', () => {
  const unavailablePayload: PolicyBlockPayload = {
    error: 'blocked',
    policy: { id: 1, name: 'prod-gate', maxSeverity: 'HIGH', blockOnSeverity: 1, blockOnKev: 0, blockOnFixable: 0 },
    violations: [
      { imageRef: '(scanner unavailable)', severity: 'UNKNOWN', criticalCount: 0, highCount: 0, kevCount: 0, fixableCount: 0, reasons: [], scanId: 0, error: 'Unavailable evidence for scanner availability: block (security_scanner_unavailable=block)' },
    ],
    evidence: {
      outcome: 'block',
      summary: 'Unavailable evidence for scanner availability: block (security_scanner_unavailable=block)',
      applications: [
        { source: 'scanner_availability', state: 'unavailable', outcome: 'block', rule: 'security_scanner_unavailable=block' },
      ],
    },
  };

  const renderDialog = (p: PolicyBlockPayload) =>
    render(<PolicyBlockDialog open payload={p} stackName="web" canBypass={false} bypassing={false} onClose={vi.fn()} onBypass={vi.fn()} />);

  it('says the block was not a proven vulnerability', () => {
    renderDialog(unavailablePayload);
    // The distinction the whole change exists for: absent evidence must never
    // read as a proven finding.
    expect(screen.getByText(/not stopped by a proven vulnerability/i)).toBeInTheDocument();
  });

  it('names the evidence state and the setting that produced the refusal', () => {
    renderDialog(unavailablePayload);
    // The sentence is split across inline spans, so match the assembled row text.
    // The modal portals to document.body, so read it there rather than off the
    // render container.
    const rows = [...document.body.querySelectorAll('li')].map((li) => li.textContent ?? '');
    expect(rows.some((t) => t.includes('scanner availability evidence was unavailable'))).toBe(true);
    expect(rows.some((t) => t.includes('it was blocked by the Scanner unavailable setting, set to block'))).toBe(true);
  });

  it('spells every outcome rather than appending a suffix', () => {
    const warned: PolicyBlockPayload = {
      ...unavailablePayload,
      evidence: {
        outcome: 'warn',
        summary: 'x',
        applications: [
          { source: 'vulnerability_scan', state: 'stale', outcome: 'warn', rule: 'security_scan_failure=warn' },
        ],
      },
    };
    renderDialog(warned);
    const text = [...document.body.querySelectorAll('li')].map((li) => li.textContent ?? '').join(' ');
    expect(text).toContain('it was warned about by the Scan failed setting, set to warn');
    expect(text).not.toContain('warnd');
    expect(text).not.toContain('allowd');
  });

  it('points at the place to change it', () => {
    renderDialog(unavailablePayload);
    expect(screen.getByText(/Policies tab, under Evidence availability/i)).toBeInTheDocument();
  });

  it('shows no evidence section for a genuine policy match', () => {
    // A proven match needs no availability explanation, and adding one would
    // dilute the case that actually matters.
    renderDialog(publicPayload);
    expect(screen.queryByText(/Evidence unavailable/i)).not.toBeInTheDocument();
  });

  it('shows no evidence section on an older control payload with no evidence field', () => {
    renderDialog({ ...publicPayload, evidence: undefined });
    expect(screen.queryByText(/Evidence unavailable/i)).not.toBeInTheDocument();
  });

  it('claims the whole block was a scan failure only when it was', () => {
    // The gate: "the deploy was blocked because the scan did not complete" is a
    // claim about the entire block. On a payload where an image matched on the
    // merits, the scan is not why the deploy stopped, and the sentence would send
    // the operator to fix a scan that was fine. Reverting the gate must fail
    // here.
    const mixed: PolicyBlockPayload = {
      ...unavailablePayload,
      violations: [...unavailablePayload.violations, publicPayload.violations[0]],
    };
    const { unmount } = render(
      <PolicyBlockDialog open payload={mixed} stackName="web" canBypass={false} bypassing={false} onClose={vi.fn()} onBypass={vi.fn()} />,
    );
    expect(screen.queryByText(/blocked because the scan did not complete/i)).not.toBeInTheDocument();
    // And the replacement still tells the operator the failed image needs
    // resolving, so the gate does not cost them the recovery path.
    expect(screen.getByText(/Some images could not be evaluated\./i)).toBeInTheDocument();
    expect(screen.getByText(/the counts above do not cover them/i)).toBeInTheDocument();
    expect(screen.getByText(/deploy again/i)).toBeInTheDocument();
    unmount();

    // On an evidence-only payload the sentence is the whole account of the block,
    // so it has to be there.
    render(
      <PolicyBlockDialog open payload={unavailablePayload} stackName="web" canBypass={false} bypassing={false} onClose={vi.fn()} onBypass={vi.fn()} />,
    );
    expect(screen.getByText(/blocked because the scan did not complete/i)).toBeInTheDocument();
  });

  it('explains both problems when one image is stale and its findings incomplete', () => {
    // Regression: the de-duplication keyed only on source:target, so the second
    // problem on the same image was silently dropped from the dialog.
    const both: PolicyBlockPayload = {
      ...unavailablePayload,
      evidence: {
        outcome: 'block',
        summary: 'x',
        records: [
          {
            source: 'vulnerability_scan',
            state: 'stale',
            target: 'nginx:1.27',
            collectedAt: Date.now() - 9 * 86_400_000,
            reason: 'The scan is 9 day(s) old, past the configured 7 day limit',
          },
          {
            source: 'vulnerability_scan',
            state: 'partial',
            target: 'nginx:1.27',
            collectedAt: Date.now() - 9 * 86_400_000,
            reason: 'The stored findings do not cover every vulnerability in this scan',
          },
        ],
        applications: [
          {
            source: 'vulnerability_scan',
            state: 'stale',
            outcome: 'block',
            rule: 'security_scan_failure=block',
            target: 'nginx:1.27',
          },
        ],
      },
    };
    renderDialog(both);
    const rows = [...document.body.querySelectorAll('li')].map((li) => li.textContent ?? '');
    expect(rows.some((t) => t.includes('the Scan failed setting'))).toBe(true);
    expect(rows.some((t) => t.includes('incomplete'))).toBe(true);
  });

  it('gives every row a distinct key when one image has several problems', () => {
    const multi: PolicyBlockPayload = {
      ...unavailablePayload,
      evidence: {
        outcome: 'block',
        summary: 'x',
        records: [],
        applications: [
          { source: 'vulnerability_scan', state: 'stale', outcome: 'allow', rule: 'security_scan_failure=allow', target: 'a:1' },
          { source: 'vulnerability_scan', state: 'stale', outcome: 'allow', rule: 'security_scan_failure=allow', target: 'b:1' },
        ],
      },
    };
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      renderDialog(multi);
      // Two images, two rows, and no duplicate-key complaint. Asserting on the
      // specific warning rather than blanket silence, so an unrelated error is
      // not swallowed and still fails the run.
      expect(document.body.querySelectorAll('li').length).toBe(2);
      const keyWarnings = errSpy.mock.calls.filter((args) => /same key|duplicate key/i.test(String(args[0])));
      expect(keyWarnings).toEqual([]);
    } finally {
      errSpy.mockRestore();
    }
  });

  it('does not claim the block was not a vulnerability when a genuine violation is also present', () => {
    // A payload can carry both. The gap is still worth naming, but the sentence
    // is a claim about the whole block and would be false here.
    const mixed: PolicyBlockPayload = {
      ...unavailablePayload,
      violations: [
        ...unavailablePayload.violations,
        publicPayload.violations[0],
      ],
    };
    renderDialog(mixed);
    expect(screen.queryByText(/not stopped by a proven vulnerability/i)).not.toBeInTheDocument();
    expect(screen.getByText(/also affected by missing evidence/i)).toBeInTheDocument();
    // The gap is still explained rather than dropped.
    expect(screen.getAllByText(/the Scanner unavailable setting/).length).toBeGreaterThan(0);
  });

  it('names no violating image when every violation is an evidence gap', () => {
    // For an evidence block the violating row is a placeholder, not an image, so
    // "the following image triggered the block" would be false.
    renderDialog(unavailablePayload);
    expect(screen.queryByText(/triggered the block/i)).not.toBeInTheDocument();
    expect(screen.getByText(/No image was found to match those conditions/i)).toBeInTheDocument();
  });

  it('still names the violating images when there is a genuine match', () => {
    renderDialog(publicPayload);
    expect(screen.getByText(/triggered the block/i)).toBeInTheDocument();
  });

  it('counts only the genuine matches on a mixed payload', () => {
    // The evidence placeholder did not trigger anything on the merits, so
    // counting it would overstate how many images matched.
    const mixed: PolicyBlockPayload = {
      ...unavailablePayload,
      violations: [...unavailablePayload.violations, publicPayload.violations[0]],
    };
    renderDialog(mixed);
    // One genuine match, so the singular form: the evidence placeholder beside it
    // must not be counted as a second violating image.
    expect(screen.getByText(/The following image triggered the block/)).toBeInTheDocument();
    expect(screen.queryByText(/2 images triggered the block/)).not.toBeInTheDocument();
  });

  it('omits current evidence from the explanation', () => {
    const mixed: PolicyBlockPayload = {
      ...unavailablePayload,
      evidence: {
        outcome: 'block',
        summary: 'x',
        applications: [
          { source: 'vulnerability_scan', state: 'current', outcome: 'allow', rule: 'nothing' },
          { source: 'vulnerability_scan', state: 'stale', outcome: 'block', rule: 'security_scan_failure=block' },
        ],
      },
    };
    renderDialog(mixed);
    expect(screen.getByText(/the Scan failed setting/)).toBeInTheDocument();
    expect(screen.queryByText(/state was current/)).not.toBeInTheDocument();
  });
});

describe('PolicyBlockDialog', () => {
  it('describes the active inputs (KEV + fixable, not the severity threshold)', () => {
    render(
      <PolicyBlockDialog open payload={publicPayload} stackName="web" canBypass={false} bypassing={false} onClose={vi.fn()} onBypass={vi.fn()} />,
    );
    const desc = screen.getAllByText(/known-exploited CVE \(KEV\)/i);
    expect(desc.length).toBeGreaterThan(0);
    expect(screen.getAllByText(/fixable Critical\/High finding/i).length).toBeGreaterThan(0);
  });

  it('renders a reason badge per matched input on the violation row', () => {
    render(
      <PolicyBlockDialog open payload={publicPayload} stackName="web" canBypass={false} bypassing={false} onClose={vi.fn()} onBypass={vi.fn()} />,
    );
    expect(screen.getByText('KEV')).toBeInTheDocument();
    expect(screen.getByText('Fixable')).toBeInTheDocument();
    expect(screen.getByText(/1 KEV/)).toBeInTheDocument();
    // A clean policy match must not show the scan-failure recovery hint.
    expect(screen.queryByText(/deploy again/i)).not.toBeInTheDocument();
  });

  it('renders matched and scan-failed violations together with a single recovery hint', () => {
    const mixed: PolicyBlockPayload = {
      error: 'blocked',
      policy: { id: 1, name: 'prod-gate', maxSeverity: 'CRITICAL', blockOnSeverity: 0, blockOnKev: 1, blockOnFixable: 1 },
      violations: [
        { imageRef: 'nginx:1.14', severity: 'CRITICAL', criticalCount: 2, highCount: 0, kevCount: 1, fixableCount: 1, reasons: ['kev', 'fixable'], scanId: 1 },
        { imageRef: 'redis:7', severity: 'UNKNOWN', criticalCount: 0, highCount: 0, kevCount: 0, fixableCount: 0, reasons: [], scanId: 0, error: 'Pre-flight scan failed: timeout' },
      ],
    };
    render(
      <PolicyBlockDialog open payload={mixed} stackName="web" canBypass={false} bypassing={false} onClose={vi.fn()} onBypass={vi.fn()} />,
    );
    // The matched row keeps its counts and reason badges.
    expect(screen.getByText(/1 KEV/)).toBeInTheDocument();
    expect(screen.getByText('Fixable')).toBeInTheDocument();
    // The failed row shows its reason under the could-not-be-scanned label.
    // Matched exactly and case-sensitively: the mixed-payload banner added
    // later also contains the phrase, in sentence case.
    expect(screen.getByText(/Pre-flight scan failed: timeout/i)).toBeInTheDocument();
    expect(screen.getByText('Could not be scanned')).toBeInTheDocument();
    // The recovery hint appears once for the whole list, not per failed row.
    expect(screen.getAllByText(/deploy again/i)).toHaveLength(1);
  });

  it('explains a scan failure with its reason instead of a zero-count block', () => {
    const failed: PolicyBlockPayload = {
      error: 'blocked',
      policy: { id: 1, name: 'prod-gate', maxSeverity: 'CRITICAL', blockOnSeverity: 0, blockOnKev: 1, blockOnFixable: 1 },
      violations: [
        { imageRef: 'nginx:1.14', severity: 'UNKNOWN', criticalCount: 0, highCount: 0, kevCount: 0, fixableCount: 0, reasons: [], scanId: 0, error: 'Pre-flight scan failed: trivy crashed' },
      ],
    };
    render(
      <PolicyBlockDialog open payload={failed} stackName="web" canBypass={false} bypassing={false} onClose={vi.fn()} onBypass={vi.fn()} />,
    );
    // The actual failure reason is shown, not an unexplained "0 critical 0 high".
    expect(screen.getByText(/Pre-flight scan failed: trivy crashed/i)).toBeInTheDocument();
    expect(screen.getByText(/could not be scanned/i)).toBeInTheDocument();
    // A recovery hint points the operator at the fix-and-retry path.
    expect(screen.getByText(/deploy again/i)).toBeInTheDocument();
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
