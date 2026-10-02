/**
 * The shared block message must name the inputs that actually matched, so a
 * KEV-driven block never reads as a severity-threshold block.
 */
import { describe, it, expect } from 'vitest';
import { describePolicyBlock } from '../helpers/policyGate';
import type { PolicyViolation } from '../services/PolicyEnforcement';
import type { ScanPolicy } from '../services/DatabaseService';

const policy = { name: 'prod-gate', max_severity: 'CRITICAL' } as ScanPolicy;
const violation = (over: Partial<PolicyViolation>): PolicyViolation => ({
  imageRef: 'nginx:1.14', severity: 'LOW', criticalCount: 0, highCount: 0,
  kevCount: 0, fixableCount: 0, reasons: [], scanId: 1, ...over,
});

describe('describePolicyBlock', () => {
  it('reports an evidence block as missing evidence, not as a matched finding', () => {
    // The unattended paths only have this sentence, so a scanner outage must
    // not read as a policy match there.
    const msg = describePolicyBlock(
      policy,
      [violation({ error: 'Pre-flight scan failed: scanner crashed' })],
      'deploy',
      {
        outcome: 'block',
        records: [{ source: 'vulnerability_scan', state: 'failed', target: 'nginx:1.14', collectedAt: null }],
        applications: [
          {
            source: 'vulnerability_scan',
            state: 'failed',
            outcome: 'block',
            rule: 'security_scan_failure=block',
            target: 'nginx:1.14',
          },
        ],
        summary: 'Failed evidence for vulnerability_scan: block (security_scan_failure=block)',
      },
    );
    expect(msg).toContain('required security evidence was unavailable');
    expect(msg).not.toContain('matched');
  });

  it('does not contradict itself when no rule application exists', () => {
    // An evaluation failure produces no application, and the summary for that
    // case is "No security evidence was required", which would directly
    // contradict the sentence it is appended to.
    const msg = describePolicyBlock(
      policy,
      [violation({ error: 'Policy evaluation failed: database is locked' })],
      'deploy',
      { outcome: 'allow', records: [], applications: [], summary: 'No security evidence was required for this decision' },
    );
    expect(msg).toContain('could not be evaluated');
    expect(msg).not.toContain('No security evidence was required');
  });

  it('counts only the genuine matches on a mixed payload', () => {
    const msg = describePolicyBlock(
      policy,
      [violation({ reasons: ['kev'] }), violation({ error: 'Pre-flight scan failed: scanner crashed' })],
      'deploy',
      {
        outcome: 'block',
        records: [],
        applications: [
          { source: 'vulnerability_scan', state: 'failed', outcome: 'block', rule: 'security_scan_failure=block' },
        ],
        summary: 'Failed evidence for vulnerability_scan: block (security_scan_failure=block)',
      },
    );
    expect(msg).toContain('1 image(s) matched');
  });

  it('names the unproven images on an evidence block', () => {
    // The case an operator cannot otherwise resolve: a scheduled auto-update on a
    // two-image stack is blocked because one image's scan failed. Only that image
    // is a violation, because the other one scanned clean, so before this the
    // sentence named the rule and not the image and nothing on screen said which
    // of the two had failed.
    const msg = describePolicyBlock(
      policy,
      [violation({ imageRef: 'nginx:1.14', error: 'Pre-flight scan failed: scanner crashed' })],
      'update',
      {
        outcome: 'block',
        records: [],
        applications: [
          { source: 'vulnerability_scan', state: 'failed', outcome: 'block', rule: 'security_scan_failure=block', target: 'nginx:1.14' },
        ],
        summary: 'Failed evidence for vulnerability_scan: block (security_scan_failure=block)',
      },
    );
    expect(msg).toContain('required security evidence was unavailable');
    expect(msg).toContain('images=[nginx:1.14]');
    // The image that scanned clean is not named: it is not why the update was
    // blocked, and naming it would send the operator to the wrong service.
    expect(msg).not.toContain('redis:7');
  });

  it('names the unscanned images alongside the matches on a mixed block', () => {
    // A payload can carry both a real match and an image the gate could not scan.
    // Naming only the match leaves the operator fixing what they can see, then
    // redeploying into the same block, and on the unattended paths this sentence
    // is all they get.
    const msg = describePolicyBlock(
      policy,
      [violation({ imageRef: 'nginx:1.14', reasons: ['kev'] }), violation({ imageRef: 'redis:7', error: 'Pre-flight scan failed: timeout' })],
      'update',
      {
        outcome: 'block',
        records: [],
        applications: [
          { source: 'vulnerability_scan', state: 'failed', outcome: 'block', rule: 'security_scan_failure=block', target: 'redis:7' },
        ],
        summary: 'Failed evidence for vulnerability_scan: block (security_scan_failure=block)',
      },
    );
    expect(msg).toContain('1 image(s) matched');
    expect(msg).toContain('images=[nginx:1.14]');
    // The unscanned image is named as its own clause, not folded into the match
    // count, which would overstate how many images matched.
    expect(msg).toContain('1 image(s) could not be scanned');
    expect(msg).toContain('images=[redis:7]');
  });

  it('says nothing extra on a block with no evidence gap', () => {
    const msg = describePolicyBlock(policy, [violation({ reasons: ['kev'] })], 'update');
    expect(msg).not.toContain('could not be scanned');
    expect(msg).not.toContain('could not be evaluated');
  });

  it('names the images it could not evaluate when no rule blocked', () => {
    // An evaluation failure produces a record and a violation but no
    // application, so this is the sentence that has to name the image.
    const msg = describePolicyBlock(
      policy,
      [violation({ imageRef: 'redis:7', error: 'Policy evaluation failed: database is locked' })],
      'update',
      { outcome: 'allow', records: [], applications: [], summary: 'No security evidence was required for this decision' },
    );
    expect(msg).toContain('could not be evaluated');
    expect(msg).toContain('images=[redis:7]');
  });

  it('does not cite a rule that allowed or only warned', () => {
    // Image A's scan failed with the setting on warn; image B's policy
    // evaluation threw, which no setting governs. The block is B, so the message
    // must not name A's rule as the reason.
    const msg = describePolicyBlock(
      policy,
      [violation({ imageRef: 'redis:7', error: 'Policy evaluation failed: database is locked' })],
      'update',
      {
        outcome: 'warn',
        records: [],
        applications: [
          { source: 'vulnerability_scan', state: 'failed', outcome: 'warn', rule: 'security_scan_failure=warn', target: 'nginx:1.14' },
        ],
        summary: 'Failed evidence for vulnerability_scan: warn (security_scan_failure=warn)',
      },
    );
    expect(msg).not.toContain('security_scan_failure=warn');
    expect(msg).toContain('could not be evaluated');
  });

  it('names the operation the caller asked about', () => {
    expect(describePolicyBlock(policy, [violation({ reasons: ['kev'] })], 'rollback')).toContain('blocked rollback');
  });

  it('names KEV without mentioning a severity threshold', () => {
    const msg = describePolicyBlock(policy, [violation({ kevCount: 1, reasons: ['kev'] })]);
    expect(msg).toContain('known-exploited');
    expect(msg).not.toContain('CRITICAL');
  });

  it('joins multiple distinct reasons across violations', () => {
    const msg = describePolicyBlock(policy, [
      violation({ reasons: ['kev'] }),
      violation({ imageRef: 'redis:7', reasons: ['fixable'] }),
    ]);
    expect(msg).toContain('known-exploited');
    expect(msg).toContain('fixable');
  });

  it('de-duplicates a reason shared by multiple violations', () => {
    const msg = describePolicyBlock(policy, [
      violation({ reasons: ['kev'] }),
      violation({ imageRef: 'redis:7', reasons: ['kev'] }),
    ]);
    expect(msg.match(/known-exploited/g)).toHaveLength(1);
    expect(msg).toContain('2 image(s)');
  });

  it('uses the supplied action verb and a generic phrase when no reason is set', () => {
    const msg = describePolicyBlock(policy, [violation({})], 'update');
    expect(msg).toContain('blocked update');
    expect(msg).toContain('scan policy conditions');
  });
});
