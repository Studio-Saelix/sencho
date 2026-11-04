/**
 * The evidence explanation is pure presentation logic over the gate's decision
 * record, so it is tested directly rather than only through a rendered dialog.
 * The cases that matter are the ones where a naive implementation loses
 * information: one image with two distinct problems, and a state no
 * availability setting governs.
 */
import { describe, it, expect } from 'vitest';
import { buildEvidenceLines, candidateEvidenceFor } from '../policyBlockEvidence';
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
      'Scanner availability: unavailable, blocked by the Scanner unavailable setting, set to block.',
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
    expect(textFor('block')).toContain('too old, blocked by');
    expect(textFor('allow')).toContain('too old, allowed by');
    expect(textFor('warn')).toContain('too old, warned about by');
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
      applications: [],
      summary: '',
    });
    expect(lines.map((l) => l.text).join(' ')).toContain('for this node');
    expect(lines.map((l) => l.text).join(' ')).not.toContain('(node)');
  });

  it('explains a node-wide refusal once', () => {
    // The application carries no target and the record carries the sentinel, so
    // matching on target alone printed one fact twice: the rule that acted and
    // then the same state again. The cause is the violation row's text.
    const lines = buildEvidenceLines({
      outcome: 'block',
      records: [{ source: 'scanner_availability', state: 'unavailable', target: '(node)', collectedAt: null, reason: 'The vulnerability scanner is not available on this node' }],
      applications: [{ source: 'scanner_availability', state: 'unavailable', outcome: 'block', rule: 'security_scanner_unavailable=block' }],
      summary: '',
    });
    expect(lines.map((l) => l.text)).toEqual([
      'Scanner availability: unavailable, blocked by the Scanner unavailable setting, set to block.',
    ]);
  });

  it('does not let a target-less application swallow an image-specific record', () => {
    const lines = buildEvidenceLines({
      outcome: 'block',
      records: [{ source: 'vulnerability_scan', state: 'failed', target: 'nginx:1.27', collectedAt: null, reason: 'The scan did not complete' }],
      applications: [{ source: 'vulnerability_scan', state: 'failed', outcome: 'block', rule: 'security_scan_failure=block' }],
      summary: '',
    });
    expect(lines).toHaveLength(2);
    expect(lines[1].text).toBe('Vulnerability scan for nginx:1.27: failed. The scan did not complete.');
  });

  it('shows an outcome, source, state or rule this build does not know as sent', () => {
    const lines = buildEvidenceLines({
      outcome: 'block',
      records: [],
      applications: [{ source: 'constructor', state: 'toString', outcome: 'quarantine', rule: 'hasOwnProperty=x' } as never],
      summary: '',
    });
    expect(lines[0].text).toBe('Constructor: toString, quarantine by hasOwnProperty=x.');
    expect(lines[0].text).not.toMatch(/undefined|function/);
  });

  it('words a failed scan without "was failed"', () => {
    const lines = buildEvidenceLines({
      outcome: 'block',
      records: [{ source: 'vulnerability_scan', state: 'failed', target: 'nginx:1.27', collectedAt: null, reason: 'The scan did not complete.' }],
      applications: [{ source: 'vulnerability_scan', state: 'failed', outcome: 'block', rule: 'security_scan_failure=block', target: 'nginx:1.27' }],
      summary: '',
    });
    expect(lines).toHaveLength(1);
    expect(lines[0].text).toBe('Vulnerability scan for nginx:1.27: failed, blocked by the Scan failed setting, set to block.');
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

  it('reads an unsupported image reference as unresolved, not as an older node version', () => {
    // `unsupported` also covers a reference no build can resolve. Only the
    // node-wide record may say the cause is the node's version.
    const lines = buildEvidenceLines({
      outcome: 'block',
      records: [{
        source: 'vulnerability_scan',
        state: 'unsupported',
        target: 'not a valid ref',
        collectedAt: null,
        reason: 'The image reference could not be parsed, so the registry image could not be resolved',
      }],
      applications: [{
        source: 'vulnerability_scan',
        state: 'unsupported',
        outcome: 'block',
        rule: 'security_scan_failure=block',
        target: 'not a valid ref',
      }],
      summary: '',
    });
    const text = lines.map((line) => line.text).join(' ');
    expect(text).toContain('not supported');
    expect(text).not.toContain('node version');
  });

  it('keeps the node-version wording for a node that cannot evaluate a candidate', () => {
    const lines = buildEvidenceLines({
      outcome: 'block',
      records: [{
        source: 'vulnerability_scan',
        state: 'unsupported',
        target: '(node)',
        collectedAt: null,
        reason: "This node's version checks the image already installed, not the image this update would pull",
      }],
      applications: [{
        source: 'vulnerability_scan',
        state: 'unsupported',
        outcome: 'block',
        rule: 'security_candidate_unproven=block',
      }],
      summary: '',
    });
    expect(lines.map((line) => line.text).join(' ')).toContain('not evaluated on this node version');
  });

  it('gives one ref a distinct evidence line per platform', () => {
    // One ref can have one record per platform variant; keying only on the
    // source, state and target collapsed them into duplicate React keys, and
    // the text alone could not tell the variants apart.
    const lines = buildEvidenceLines({
      outcome: 'block',
      records: [
        { source: 'vulnerability_scan', state: 'partial', target: 'app:latest', platform: 'linux/amd64' },
        { source: 'vulnerability_scan', state: 'partial', target: 'app:latest', platform: 'linux/arm64' },
      ],
      applications: [],
      summary: '',
    });
    expect(lines).toHaveLength(2);
    expect(new Set(lines.map((line) => line.key)).size).toBe(2);
    expect(lines[0].text).toContain('app:latest (linux/amd64)');
    expect(lines[1].text).toContain('app:latest (linux/arm64)');
  });

  it('keys applications per platform and does not let one variant suppress another', () => {
    // Two unresolved variants produce applications with the same source, state
    // and target. Target-only keys duplicated the React key and the explained
    // set let the amd64 application hide the arm64 record.
    const lines = buildEvidenceLines({
      outcome: 'block',
      records: [
        { source: 'vulnerability_scan', state: 'unavailable', target: 'app:latest', platform: 'linux/amd64', reason: 'registry 503' },
        { source: 'vulnerability_scan', state: 'unavailable', target: 'app:latest', platform: 'linux/arm64', reason: 'registry 503' },
      ],
      applications: [
        { source: 'vulnerability_scan', state: 'unavailable', outcome: 'block', rule: 'security_scan_failure=block', target: 'app:latest', platform: 'linux/amd64' },
      ],
      summary: '',
    });
    expect(new Set(lines.map((line) => line.key)).size).toBe(lines.length);
    // The amd64 application explains its own record; the arm64 record remains.
    expect(lines.some((line) => line.text.includes('app:latest (linux/arm64)'))).toBe(true);
  });
});

describe('candidateEvidenceFor', () => {
  const evidence: Evidence = {
    outcome: 'block',
    summary: 'x',
    records: [
      {
        source: 'vulnerability_scan',
        state: 'current',
        target: 'app:latest',
        subject: 'candidate',
        digest: 'sha256:451eee8bedcb',
        platformDigest: 'sha256:aaaa',
        platform: 'linux/amd64',
      },
      {
        source: 'vulnerability_scan',
        state: 'current',
        target: 'app:latest',
        subject: 'candidate',
        digest: 'sha256:451eee8bedcb',
        platformDigest: 'sha256:bbbb',
        platform: 'linux/arm64',
      },
    ],
    applications: [],
  };

  it('returns the record for the row platform, not the first record for the ref', () => {
    expect(candidateEvidenceFor(evidence, 'app:latest', 'linux/arm64')?.platformDigest).toBe('sha256:bbbb');
    expect(candidateEvidenceFor(evidence, 'app:latest', 'linux/amd64')?.platformDigest).toBe('sha256:aaaa');
  });

  it('falls back to the first record when the row does not name a platform', () => {
    expect(candidateEvidenceFor(evidence, 'app:latest')?.platform).toBe('linux/amd64');
  });

  it('shows no candidate line for a named platform with no digest record', () => {
    // The unresolved row for one variant must not borrow another variant's
    // digest and platform label.
    expect(candidateEvidenceFor(evidence, 'app:latest', 'linux/386')).toBeNull();
  });

  it('returns nothing when no candidate record named a digest', () => {
    expect(candidateEvidenceFor({
      outcome: 'block',
      summary: 'x',
      records: [{ source: 'vulnerability_scan', state: 'unavailable', target: 'app:latest', subject: 'candidate' }],
      applications: [],
    }, 'app:latest', 'linux/amd64')).toBeNull();
  });
});
