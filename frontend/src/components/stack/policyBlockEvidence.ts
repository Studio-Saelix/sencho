/**
 * Wording for the deploy-block dialog's evidence explanation.
 *
 * Its own module, separate from `PolicyBlockDialog`, for two reasons. It is pure
 * presentation logic over the gate's decision record, so it can be unit-tested
 * without mounting a dialog; and a component module that also exports a runtime
 * function stops being Fast-Refresh eligible, which the component-only rule
 * enforces.
 */
import type { PolicyBlockPayload } from './PolicyBlockDialog';

/** Spelled out rather than derived: 'allow' + 'd' is not a word. */
const OUTCOME_PAST_TENSE: Record<'allow' | 'warn' | 'block', string> = {
  allow: 'allowed',
  warn: 'warned about',
  block: 'blocked',
};

/** Human wording for one evidence state, for the block dialog's explanation. */
const EVIDENCE_STATE_LABEL: Record<string, string> = {
  current: 'current',
  stale: 'too old',
  unavailable: 'unavailable',
  failed: 'failed',
  partial: 'incomplete',
  unsupported: 'not supported on this node',
  not_evaluated: 'never evaluated',
  unknown: 'indeterminate',
};

export interface EvidenceLine {
  key: string;
  text: string;
}

/**
 * Operator-facing name for the setting behind a rule clause.
 *
 * The decision record carries the raw setting key (`security_scan_failure=block`)
 * because that is what an audit needs. An operator reading a block dialog needs
 * the control they can go and change, so the dialog renders this instead and the
 * raw clause stays in the record.
 */
const RULE_LABEL: Record<string, string> = {
    'security_scanner_unavailable': 'the Scanner unavailable setting',
    'security_scan_failure': 'the Scan failed setting',
    'security_candidate_unproven': 'the Candidate not evaluated setting',
    'security_partial_evidence': 'partial evidence handling',
};

/** Turn `security_scan_failure=block` into "the Scan failed setting, set to block". */
function describeRule(rule: string): string {
    // The dialog is where a malformed payload lands, so this must degrade rather
    // than throw. The code it replaced interpolated the value directly and could
    // not fail; a split on a missing string would.
    if (typeof rule !== 'string' || rule === '') return 'an unknown rule';
    const [key, value] = rule.split('=');
    const label = RULE_LABEL[key];
    if (!label) return rule;
    return value ? `${label}, set to ${value}` : label;
}

/**
 * Operator-facing wording for one evidence target.
 *
 * A node-wide source, such as scanner availability, has no image to point at, so
 * its record carries a sentinel rather than a reference. Rendering that sentinel
 * verbatim would put `(node)` in a sentence an operator reads, which reads like a
 * placeholder rather than the thing that actually failed. An image reference
 * passes through untouched, including one literally called `node`, which is why
 * the sentinel is parenthesised on the server rather than matched by name here.
 */
const NODE_WIDE_TARGETS: ReadonlySet<string> = new Set(['(node)']);

function describeTarget(target: string): string {
  if (NODE_WIDE_TARGETS.has(target)) return 'this node';
  return target;
}

/**
 * Turn the decision record into one sentence per piece of evidence that was not
 * usable, preferring the rule application (which names the setting that acted)
 * and falling back to the record's own reason for a state no setting governs.
 *
 * Applications come first because they explain why the gate acted. A record
 * covers what no setting governs: partial evidence, for instance, is a state the
 * gate fails closed on by definition, so it produces no application at all.
 */
export function buildEvidenceLines(evidence: PolicyBlockPayload['evidence']): EvidenceLine[] {
  if (!evidence) return [];
  const lines: EvidenceLine[] = [];
  const explained = new Set<string>();

  for (const a of evidence.applications ?? []) {
    if (a.state === 'current') continue;
    const what = a.source.replace(/_/g, ' ');
    const state = EVIDENCE_STATE_LABEL[a.state] ?? a.state.replace(/_/g, ' ');
    const who = a.target ? ` for ${describeTarget(a.target)}` : '';
    lines.push({
      key: `app:${a.source}:${a.state}:${a.target ?? ''}`,
      text: `${what} evidence${who} was ${state}, so it was ${OUTCOME_PAST_TENSE[a.outcome]} by ${describeRule(a.rule)}.`,
    });
    // Keyed by state as well as target: one image can legitimately have two
    // distinct problems (a stale scan whose finding rows were also truncated),
    // and collapsing them would drop the second explanation.
    if (a.target) explained.add(`${a.source}:${a.state}:${a.target}`);
  }

  for (const r of evidence.records ?? []) {
    if (r.state === 'current') continue;
    // Skip a record already described by an application, so the same evidence is
    // not explained twice in one dialog.
    if (explained.has(`${r.source}:${r.state}:${r.target}`)) continue;
    const what = r.source.replace(/_/g, ' ');
    const state = EVIDENCE_STATE_LABEL[r.state] ?? r.state.replace(/_/g, ' ');
    lines.push({
      key: `rec:${r.source}:${r.state}:${r.target}`,
      text: `${what} evidence for ${describeTarget(r.target)} was ${state}${r.reason ? `: ${r.reason}` : '.'}`,
    });
  }

  return lines;
}
