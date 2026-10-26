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

/**
 * Human wording for one evidence state. It follows a colon ("Vulnerability scan:
 * failed"), never "was", so no state needs a past participle that is not a word.
 */
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

/** Operator-facing name of each evidence source; the identifier stays in the record. */
const EVIDENCE_SOURCE_LABEL: Record<string, string> = {
  scanner_availability: 'Scanner availability',
  vulnerability_scan: 'Vulnerability scan',
  vulnerability_database: 'Vulnerability database',
  exploit_intelligence: 'Exploit intelligence',
  image_exposure_map: 'Image exposure map',
  image_trust: 'Image trust',
};

function describeSource(source: string): string {
  if (EVIDENCE_SOURCE_LABEL[source]) return EVIDENCE_SOURCE_LABEL[source];
  const spaced = source.replace(/_/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function describeState(state: string): string {
  return EVIDENCE_STATE_LABEL[state] ?? state.replace(/_/g, ' ');
}

/** A reason is a clause from the server; end it like a sentence without doubling a stop. */
function sentence(text: string): string {
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

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

  const records = evidence.records ?? [];

  for (const a of evidence.applications ?? []) {
    if (a.state === 'current') continue;
    const who = a.target ? ` for ${describeTarget(a.target)}` : '';
    // A node-wide application carries no target, so the record of the same
    // source and state is what says why. Its reason is folded into this line
    // rather than printed again as a second line about the same fact.
    const nodeWide = a.target ? undefined : records.find((r) => r.source === a.source && r.state === a.state);
    const why = nodeWide?.reason ? ` ${sentence(nodeWide.reason)}` : '';
    lines.push({
      key: `app:${a.source}:${a.state}:${a.target ?? ''}`,
      text: `${describeSource(a.source)}${who}: ${describeState(a.state)}, ${OUTCOME_PAST_TENSE[a.outcome]} by ${describeRule(a.rule)}.${why}`,
    });
    // Keyed by state as well as target: one image can legitimately have two
    // distinct problems (a stale scan whose finding rows were also truncated),
    // and collapsing them would drop the second explanation.
    if (a.target) explained.add(`${a.source}:${a.state}:${a.target}`);
    else if (nodeWide) explained.add(`${nodeWide.source}:${nodeWide.state}:${nodeWide.target}`);
  }

  for (const r of records) {
    if (r.state === 'current') continue;
    // Skip a record already described by an application, so the same evidence is
    // not explained twice in one dialog.
    if (explained.has(`${r.source}:${r.state}:${r.target}`)) continue;
    lines.push({
      key: `rec:${r.source}:${r.state}:${r.target}`,
      text: `${describeSource(r.source)} for ${describeTarget(r.target)}: ${describeState(r.state)}.${r.reason ? ` ${sentence(r.reason)}` : ''}`,
    });
  }

  return lines;
}
