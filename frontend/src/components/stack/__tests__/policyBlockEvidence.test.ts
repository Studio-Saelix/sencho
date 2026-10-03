/**
 * The evidence explanation is pure presentation logic over the gate's decision
 * record, so it is tested directly rather than only through a rendered dialog.
 * The cases that matter are the ones where a naive implementation loses
 * information: one image with two distinct problems, and a state no
 * availability setting governs.
 */
import { describe, it, expect } from 'vitest';
import { buildEvidenceLines } from '../policyBlockEvidence';
import type { PolicyBlockPayload } from '../PolicyBlockDialog';

type Evidence = PolicyBlockPayload['evidence'];

describe('buildEvidenceLines', () => {
  it('returns nothing when the gate recorded no evidence', () => {
    expect(buildEvidenceLines(undefined)).toEqual([]);
  });

  it('returns nothing when every source was current', () => {
    const evidence: Evidence = {
      outcome: 'allow',
      summary: 'x',
      records: [{ source: 'vulnerability_scan', state: 'current', target: 'nginx:1.27' }],
      applications: [
        { source: 'vulnerability_scan', state: 'current', outcome: 'allow', rule: 'n/a', target: 'nginx:1.27' },
      ],
    };
    // A genuine policy match must not grow an evidence explanation.
    expect(buildEvidenceLines(evidence)).toEqual([]);
  });

  it('names the setting in operator wording rather than by its raw key', () => {
    const evidence: Evidence = {
      outcome: 'block',
      summary: 'x',
      records: [],
      applications: [
        {
          source: 'scanner_availability',
          state: 'unavailable',
          outcome: 'block',
          rule: 'security_scanner_unavailable=block',
        },
      ],
    };
    const lines = buildEvidenceLines(evidence);
    expect(lines).toHaveLength(1);
    expect(lines[0].text).toBe(
      'scanner availability evidence was unavailable, so it was blocked by the Scanner unavailable setting, set to block.',
    );
    // The raw key belongs in the decision record, not in front of an operator.
    expect(lines[0].text).not.toContain('security_scanner_unavailable');
  });

  it('names the image when one is known', () => {
    const evidence: Evidence = {
      outcome: 'block',
      summary: 'x',
      records: [],
      applications: [
        {
          source: 'vulnerability_scan',
          state: 'failed',
          outcome: 'block',
          rule: 'security_scan_failure=block',
          target: 'redis:7',
        },
      ],
    };
    expect(buildEvidenceLines(evidence)[0].text).toContain('for redis:7');
  });

  it('spells every outcome rather than appending a suffix', () => {
    const textFor = (outcome: 'allow' | 'warn' | 'block') =>
      buildEvidenceLines({
        outcome,
        summary: 'x',
        records: [],
        applications: [{ source: 'vulnerability_scan', state: 'stale', outcome, rule: 'unknown_key' }],
      })[0].text;
    expect(textFor('block')).toContain('it was blocked');
    expect(textFor('allow')).toContain('it was allowed');
    expect(textFor('warn')).toContain('it was warned about');
    for (const outcome of ['allow', 'warn', 'block'] as const) {
      expect(textFor(outcome)).not.toMatch(/allowd|warnd|blockd/);
    }
  });

  it('explains a state no setting governs from the record and its reason', () => {
    // Partial evidence produces no application: the gate fails closed on it by
    // definition rather than by configuration.
    const evidence: Evidence = {
      outcome: 'allow',
      summary: 'x',
      applications: [],
      records: [
        {
          source: 'vulnerability_scan',
          state: 'partial',
          target: 'nginx:1.27',
          reason: 'The stored findings do not cover every vulnerability in this scan',
        },
      ],
    };
    const lines = buildEvidenceLines(evidence);
    expect(lines).toHaveLength(1);
    expect(lines[0].text).toContain('incomplete');
    expect(lines[0].text).toContain('do not cover every vulnerability');
  });

  it('keeps both explanations when one image is stale and its findings incomplete', () => {
    // Regression: de-duplicating on source and target alone dropped the second
    // problem on the same image.
    const evidence: Evidence = {
      outcome: 'block',
      summary: 'x',
      records: [
        {
          source: 'vulnerability_scan',
          state: 'partial',
          target: 'nginx:1.27',
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
    };
    const lines = buildEvidenceLines(evidence);
    expect(lines).toHaveLength(2);
    expect(lines.some((l) => l.text.includes('the Scan failed setting'))).toBe(true);
    expect(lines.some((l) => l.text.includes('incomplete'))).toBe(true);
  });

  it('does not repeat evidence an application already explained', () => {
    const application = {
      source: 'vulnerability_scan' as const,
      state: 'stale',
      outcome: 'block' as const,
      rule: 'security_scan_failure=block',
      target: 'nginx:1.27',
    };
    const evidence: Evidence = {
      outcome: 'block',
      summary: 'x',
      applications: [application],
      records: [
        { source: 'vulnerability_scan', state: 'stale', target: 'nginx:1.27', reason: 'aged out' },
      ],
    };
    const lines = buildEvidenceLines(evidence);
    expect(lines).toHaveLength(1);
    expect(lines[0].key.startsWith('app:')).toBe(true);
  });

  it('gives every line a unique key across images and states', () => {
    const evidence: Evidence = {
      outcome: 'warn',
      summary: 'x',
      records: [
        { source: 'vulnerability_scan', state: 'partial', target: 'a:1' },
        { source: 'vulnerability_scan', state: 'partial', target: 'b:1' },
        { source: 'image_exposure_map', state: 'stale', target: 'stack:web' },
      ],
      applications: [
        { source: 'vulnerability_scan', state: 'stale', outcome: 'warn', rule: 'unknown_key', target: 'a:1' },
        { source: 'vulnerability_scan', state: 'stale', outcome: 'warn', rule: 'unknown_key', target: 'b:1' },
      ],
    };
    const keys = buildEvidenceLines(evidence).map((l) => l.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('degrades rather than throwing on a malformed rule from an old payload', () => {
    // The dialog is where a malformed payload lands, so a missing rule must not
    // take the block explanation down with it.
    for (const bad of [undefined, null, ''] as unknown[]) {
      const lines = buildEvidenceLines({
        outcome: 'block',
        summary: 'x',
        applications: [
          { source: 'vulnerability_scan', state: 'failed', outcome: 'block', rule: bad as string },
        ],
      });
      expect(lines).toHaveLength(1);
      expect(lines[0].text).toContain('an unknown rule');
    }
  });

  it('maps every declared state to readable wording', () => {
    // A state with no label would surface as a raw enum token to an operator.
    const states = [
      'stale',
      'unavailable',
      'failed',
      'partial',
      'unsupported',
      'not_evaluated',
      'unknown',
    ];
    for (const state of states) {
      const [line] = buildEvidenceLines({
        outcome: 'allow',
        summary: 'x',
        applications: [],
        records: [{ source: 'vulnerability_scan', state, target: 'img:1' }],
      });
      expect(line.text).not.toContain('_');
      expect(line.text).toMatch(/\S/);
    }
  });

  it('names a node-wide target in words rather than showing the sentinel', () => {
    // The record carries a sentinel so the server can tell a node-wide source
    // from an image named `node`. An operator reading the dialog should not see
    // the sentinel; "this node" says what actually failed.
    const lines = buildEvidenceLines({
      outcome: 'block',
      records: [{ source: 'scanner_availability', state: 'unavailable', target: '(node)', collectedAt: null, reason: 'not responding' }],
      applications: [{ source: 'scanner_availability', state: 'unavailable', outcome: 'block', rule: 'security_scanner_unavailable=block' }],
      summary: '',
    });
    expect(lines.map((l) => l.text).join(' ')).toContain('for this node');
    expect(lines.map((l) => l.text).join(' ')).not.toContain('(node)');
  });

  it('still shows an image that happens to be called node', () => {
    const lines = buildEvidenceLines({
      outcome: 'block',
      records: [],
      applications: [{ source: 'vulnerability_scan', state: 'failed', outcome: 'block', rule: 'security_scan_failure=block', target: 'node' }],
      summary: '',
    });
    expect(lines[0].text).toContain('for node');
  });
});
