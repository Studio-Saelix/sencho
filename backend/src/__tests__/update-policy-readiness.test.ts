/**
 * The update-policy readiness signal.
 *
 * Two properties matter: the states map from the decision (attention when the
 * operator's own update is refused, warning when only unattended updates skip,
 * ok otherwise, unknown when the model cannot be read), and the signal never
 * changes the verdict. A deliberately pinned stack is a choice, not a finding,
 * and the Fleet readiness rollup must not report it as one.
 */
import { describe, it, expect } from 'vitest';
import { aggregateVerdict, updatePolicySignal, diskSignal } from '../services/updateGuard/readiness';
import type { UpdatePolicyReadiness } from '../services/updateGuard/types';

const evaluate = (
  services: UpdatePolicyReadiness['services'],
  manualDecision: UpdatePolicyReadiness['manualDecision'],
  unattendedDecision: UpdatePolicyReadiness['unattendedDecision'],
  reason: string | null = null,
): UpdatePolicyReadiness => ({
  evaluation: 'evaluated', services, manualDecision, unattendedDecision, reason,
});

describe('updatePolicySignal', () => {
  it('is attention when the operator own update is refused', () => {
    const signal = updatePolicySignal(evaluate(
      [{ service: 'db', policy: 'disabled', eligible: false, reason: 'set to disabled' }],
      'block', 'skip', '"db" is set to disabled',
    ));
    expect(signal).toMatchObject({ id: 'update_policy', status: 'attention', affectsVerdict: false });
    expect(signal.detail).toContain('refused');
    expect(signal.detail).toContain('"db" is set to disabled');
  });

  it('is warning when only unattended updates skip', () => {
    const signal = updatePolicySignal(evaluate(
      [
        { service: 'web', policy: 'manual', eligible: false, reason: 'set to manual' },
        { service: 'db', policy: 'default', eligible: true },
      ],
      'allow', 'skip', '"web" is set to manual',
    ));
    expect(signal).toMatchObject({ status: 'warning', affectsVerdict: false });
    expect(signal.detail).toContain('Manual updates are allowed');
    expect(signal.detail).toContain('"web"');
  });

  it('is ok when every service allows both classes', () => {
    const signal = updatePolicySignal(evaluate(
      [{ service: 'web', policy: 'auto', eligible: true }],
      'allow', 'allow',
    ));
    expect(signal).toMatchObject({ status: 'ok', affectsVerdict: false });
  });

  it('is unknown when the model cannot be read, and says why', () => {
    const unrenderable = updatePolicySignal({
      evaluation: 'unrenderable', services: [], manualDecision: 'block', unattendedDecision: 'skip',
      reason: 'Compose could not be rendered, so Sencho cannot evaluate io.sencho.update.',
    });
    expect(unrenderable).toMatchObject({ status: 'unknown', affectsVerdict: false });
    expect(unrenderable.detail).toContain('could not be rendered');
    expect(updatePolicySignal('error').status).toBe('unknown');
  });

  it('never changes the verdict', () => {
    const base = diskSignal({ usePercent: 10, limitPercent: 90 });
    const blocked = updatePolicySignal(evaluate(
      [{ service: 'db', policy: 'disabled', eligible: false, reason: 'set to disabled' }],
      'block', 'skip', '"db" is set to disabled',
    ));
    expect(aggregateVerdict([base])).toBe(aggregateVerdict([base, blocked]));
    expect(aggregateVerdict([base, blocked])).toBe('ready');
  });
});
