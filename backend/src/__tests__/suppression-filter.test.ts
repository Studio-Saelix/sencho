/**
 * Unit tests for the read-time CVE suppression filter.
 */
import { describe, it, expect } from 'vitest';
import { applySuppressions, findSuppression } from '../utils/suppression-filter';
import type { CveSuppression } from '../services/DatabaseService';

const NOW = 1_700_000_000_000;

function makeSuppression(overrides: Partial<CveSuppression> = {}): CveSuppression {
  return {
    id: 1,
    cve_id: 'CVE-2024-1234',
    pkg_name: null,
    image_pattern: null,
    reason: 'known false positive',
    created_by: 'admin',
    created_at: NOW - 1000,
    expires_at: null,
    replicated_from_control: 0,
    ...overrides,
  };
}

describe('findSuppression', () => {
  it('returns null when no suppression exists for the CVE', () => {
    const match = findSuppression(
      { vulnerability_id: 'CVE-2024-9999', pkg_name: 'openssl' },
      'nginx:1.25',
      [makeSuppression({ cve_id: 'CVE-2024-1234' })],
      NOW,
    );
    expect(match).toBeNull();
  });

  it('matches a fleet-wide suppression (null pkg, null pattern)', () => {
    const s = makeSuppression({ id: 42 });
    const match = findSuppression(
      { vulnerability_id: 'CVE-2024-1234', pkg_name: 'openssl' },
      'nginx:1.25',
      [s],
      NOW,
    );
    expect(match?.id).toBe(42);
  });

  it('does not match a suppression pinned to a different pkg', () => {
    const match = findSuppression(
      { vulnerability_id: 'CVE-2024-1234', pkg_name: 'glibc' },
      'nginx:1.25',
      [makeSuppression({ pkg_name: 'openssl' })],
      NOW,
    );
    expect(match).toBeNull();
  });

  it('ignores expired suppressions', () => {
    const match = findSuppression(
      { vulnerability_id: 'CVE-2024-1234', pkg_name: 'openssl' },
      'nginx:1.25',
      [makeSuppression({ expires_at: NOW - 1 })],
      NOW,
    );
    expect(match).toBeNull();
  });

  it('accepts suppressions with expires_at in the future', () => {
    const match = findSuppression(
      { vulnerability_id: 'CVE-2024-1234', pkg_name: 'openssl' },
      'nginx:1.25',
      [makeSuppression({ id: 7, expires_at: NOW + 10_000 })],
      NOW,
    );
    expect(match?.id).toBe(7);
  });

  it('matches wildcard image_pattern via *', () => {
    const match = findSuppression(
      { vulnerability_id: 'CVE-2024-1234', pkg_name: 'openssl' },
      'registry.example.com/nginx:1.25',
      [makeSuppression({ image_pattern: '*nginx*' })],
      NOW,
    );
    expect(match).not.toBeNull();
  });

  it('does not match an image_pattern with no wildcards unless exact', () => {
    const match = findSuppression(
      { vulnerability_id: 'CVE-2024-1234', pkg_name: 'openssl' },
      'nginx:1.25-alpine',
      [makeSuppression({ image_pattern: 'nginx:1.25' })],
      NOW,
    );
    expect(match).toBeNull();
  });

  it('escapes regex metacharacters in image_pattern', () => {
    // The + should be literal; otherwise "a+" would match "aa"
    const match = findSuppression(
      { vulnerability_id: 'CVE-2024-1234', pkg_name: 'openssl' },
      'aa',
      [makeSuppression({ image_pattern: 'a+' })],
      NOW,
    );
    expect(match).toBeNull();
  });

  it('prefers pkg-specific suppression over wildcard', () => {
    const wildcard = makeSuppression({ id: 1, pkg_name: null });
    const specific = makeSuppression({ id: 2, pkg_name: 'openssl' });
    const match = findSuppression(
      { vulnerability_id: 'CVE-2024-1234', pkg_name: 'openssl' },
      'nginx:1.25',
      [wildcard, specific],
      NOW,
    );
    expect(match?.id).toBe(2);
  });

  it('prefers image-pattern + pkg over pkg-only', () => {
    const pkgOnly = makeSuppression({ id: 1, pkg_name: 'openssl' });
    const both = makeSuppression({ id: 2, pkg_name: 'openssl', image_pattern: 'nginx*' });
    const match = findSuppression(
      { vulnerability_id: 'CVE-2024-1234', pkg_name: 'openssl' },
      'nginx:1.25',
      [pkgOnly, both],
      NOW,
    );
    expect(match?.id).toBe(2);
  });
});

describe('applySuppressions', () => {
  it('enriches findings without mutating inputs', () => {
    const findings = [
      { vulnerability_id: 'CVE-2024-1234', pkg_name: 'openssl', severity: 'HIGH' },
      { vulnerability_id: 'CVE-2024-9999', pkg_name: 'glibc', severity: 'LOW' },
    ];
    const result = applySuppressions(
      findings,
      'nginx:1.25',
      [makeSuppression({ id: 5, reason: 'accepted risk' })],
      NOW,
    );

    expect(result[0]).toMatchObject({
      vulnerability_id: 'CVE-2024-1234',
      severity: 'HIGH',
      suppressed: true,
      suppression_id: 5,
      suppression_reason: 'accepted risk',
    });
    expect(result[1]).toMatchObject({
      vulnerability_id: 'CVE-2024-9999',
      suppressed: false,
    });
    expect(result[1].suppression_id).toBeUndefined();
    // Original findings untouched
    expect(findings[0]).not.toHaveProperty('suppressed');
  });

  it('returns an empty array for empty input', () => {
    expect(applySuppressions([], 'nginx:1.25', [], NOW)).toEqual([]);
  });

  it('treats a missing status as accepted (back-compat) and dismisses it', () => {
    const [r] = applySuppressions(
      [{ vulnerability_id: 'CVE-2024-1234', pkg_name: 'openssl' }],
      'nginx:1.25',
      [makeSuppression({})],
      NOW,
    );
    expect(r).toMatchObject({ suppressed: true, triage_status: 'accepted' });
  });

  it('surfaces a dismissing status (not_affected) as suppressed with the status', () => {
    const [r] = applySuppressions(
      [{ vulnerability_id: 'CVE-2024-1234', pkg_name: 'openssl' }],
      'nginx:1.25',
      [makeSuppression({ status: 'not_affected', justification: 'component_not_present' })],
      NOW,
    );
    expect(r).toMatchObject({ suppressed: true, triage_status: 'not_affected', triage_justification: 'component_not_present' });
  });

  it('does NOT dismiss a needs_review decision (stays actionable, still tagged)', () => {
    const [r] = applySuppressions(
      [{ vulnerability_id: 'CVE-2024-1234', pkg_name: 'openssl' }],
      'nginx:1.25',
      [makeSuppression({ status: 'needs_review' })],
      NOW,
    );
    expect(r).toMatchObject({ suppressed: false, triage_status: 'needs_review' });
  });

  it('does NOT dismiss an affected decision', () => {
    const [r] = applySuppressions(
      [{ vulnerability_id: 'CVE-2024-1234', pkg_name: 'openssl' }],
      'nginx:1.25',
      [makeSuppression({ status: 'affected' })],
      NOW,
    );
    expect(r.suppressed).toBe(false);
  });

  // Regression guard for the cve_id bucketing optimization. A naive O(N*M)
  // implementation drifts into the tens of millions of comparisons at this
  // scale; the bucketed implementation lands in low-tens of milliseconds on
  // commodity hardware. The 1500ms ceiling is generous to keep the test
  // stable across CI runners and slow Windows VMs while still catching a
  // regression to the quadratic shape (which would blow well past 1.5s).
  it('processes 10k suppressions x 2k findings in well under 1.5s', () => {
    const suppressions: CveSuppression[] = Array.from({ length: 10_000 }, (_, i) =>
      makeSuppression({ id: i, cve_id: `CVE-2024-${10_000 + i}`, pkg_name: i % 3 === 0 ? 'openssl' : null }),
    );
    const findings = Array.from({ length: 2_000 }, (_, i) => ({
      vulnerability_id: `CVE-2024-${10_000 + (i * 5) % 10_000}`,
      pkg_name: i % 2 === 0 ? 'openssl' : 'glibc',
    }));
    const start = Date.now();
    const result = applySuppressions(findings, 'nginx:1.25', suppressions, NOW);
    const elapsed = Date.now() - start;
    expect(result).toHaveLength(2_000);
    // At least one finding must actually match a suppression; otherwise a
    // regression where bucketing silently drops every match could pass.
    expect(result.some((r) => r.suppressed)).toBe(true);
    expect(elapsed).toBeLessThan(1500);
  });
});
