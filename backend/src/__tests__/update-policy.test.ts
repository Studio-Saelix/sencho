/**
 * The two behavioral labels and the one policy evaluator.
 *
 * These are unit tests over the pure path: the registry parser, the resolver,
 * and `evaluateUpdatePolicy`. They pin the eligibility matrix, the fail-closed
 * rules, and the rule that no refusal reason ever carries a label value.
 */
import { describe, it, expect } from 'vitest';
import {
  SENCHO_LABEL_POLICY_CAPABILITY,
  SENCHO_LABEL_DEFINITIONS,
  SENCHO_NOTIFY_ROUTE_LABEL,
  SENCHO_UPDATE_LABEL,
  parseRouteKey,
  parseUpdatePolicy,
  resolveSenchoLabels,
} from '../helpers/senchoLabels';
import {
  assertPolicyAllows,
  describePolicySkip,
  evaluateUpdatePolicy,
  ineligibleServices,
  readRemoteUpdatePolicy,
  toUpdatePolicyWire,
  triggerClassOf,
  UpdatePolicyRefusedError,
  type PolicyRequest,
} from '../services/updatePolicy';
import { renderedModel } from './__helpers__/updatePolicyFixture';

function resolution(services: Record<string, { update?: string; notifyRoute?: string }>) {
  return resolveSenchoLabels(renderedModel(services));
}

const stackRequest = (trigger: PolicyRequest['trigger'] = 'manual'): PolicyRequest => ({
  stack: 'web', target: { scope: 'stack' }, trigger,
});
const serviceRequest = (
  serviceName: string,
  trigger: PolicyRequest['trigger'] = 'manual',
): PolicyRequest => ({ stack: 'web', target: { scope: 'service', serviceName }, trigger });

describe('io.sencho.update registry entry', () => {
  it('is a service-scoped operation label that needs the policy capability', () => {
    const def = SENCHO_LABEL_DEFINITIONS.find(d => d.id === 'update');
    expect(def).toMatchObject({
      scope: 'service',
      effect: 'operations',
      trust: 'compose',
      onInvalid: 'restrict-unattended',
      minCapability: SENCHO_LABEL_POLICY_CAPABILITY,
    });
    expect(SENCHO_UPDATE_LABEL).toBe('io.sencho.update');
  });

  it('accepts auto, manual and disabled, ignoring case and surrounding space', () => {
    expect(parseUpdatePolicy('auto')).toEqual({ ok: true, value: 'auto' });
    expect(parseUpdatePolicy('  MANUAL ')).toEqual({ ok: true, value: 'manual' });
    expect(parseUpdatePolicy('Disabled')).toEqual({ ok: true, value: 'disabled' });
  });

  it('refuses an unrecognized value without echoing it', () => {
    for (const raw of ['diabled', 'off', 'false', '0']) {
      const parsed = parseUpdatePolicy(raw);
      expect(parsed.ok).toBe(false);
      if (parsed.ok) throw new Error('expected refusal');
      expect(parsed.reason).not.toContain(raw);
    }
  });

  it('records an unrecognized value as invalid rather than absent, so the policy can fail closed', () => {
    const resolved = resolution({ web: { update: 'off' } });
    expect(resolved.renderable).toBe(true);
    if (!resolved.renderable) throw new Error('expected a renderable model');
    expect(resolved.services.web.update).toBe('invalid');
  });

  it('reads an absent label as null', () => {
    const resolved = resolution({ web: {} });
    if (!resolved.renderable) throw new Error('expected a renderable model');
    expect(resolved.services.web.update).toBeNull();
  });
});

describe('io.sencho.notify.route registry entry', () => {
  it('is a service-scoped operation label that needs the policy capability', () => {
    const def = SENCHO_LABEL_DEFINITIONS.find(d => d.id === 'notify-route');
    expect(def).toMatchObject({
      scope: 'service',
      effect: 'operations',
      trust: 'compose',
      minCapability: SENCHO_LABEL_POLICY_CAPABILITY,
    });
    expect(SENCHO_NOTIFY_ROUTE_LABEL).toBe('io.sencho.notify.route');
  });

  it('normalizes case and whitespace', () => {
    expect(parseRouteKey('  Production ')).toEqual({ ok: true, value: 'production' });
    expect(parseRouteKey('team-a.01')).toEqual({ ok: true, value: 'team-a.01' });
  });

  it('refuses URL- and address-shaped values, whitespace, and over-length keys', () => {
    for (const raw of [
      'https://example.test/hook',
      'prod:8080',
      'user@host',
      'two words',
      '-leading',
      'trailing-',
      'a'.repeat(65),
    ]) {
      const parsed = parseRouteKey(raw);
      expect(parsed.ok).toBe(false);
      if (parsed.ok) throw new Error(`expected "${raw}" to be refused`);
      expect(parsed.reason).not.toContain(raw);
    }
  });

  it('reads a valid key and leaves an invalid one unresolved', () => {
    const valid = resolution({ web: { notifyRoute: 'Production' } });
    if (!valid.renderable) throw new Error('expected a renderable model');
    expect(valid.services.web.notifyRoute).toBe('production');

    const ignored = resolution({ web: { notifyRoute: 'https://example.test' } });
    if (!ignored.renderable) throw new Error('expected a renderable model');
    expect(ignored.services.web.notifyRoute).toBeNull();
    expect(ignored.entries.some(e => e.state === 'invalid')).toBe(true);
  });
});

describe('triggerClassOf', () => {
  it('treats only the operator click as manual', () => {
    expect(triggerClassOf('manual')).toBe('manual');
    for (const trigger of ['scheduled', 'automatic', 'webhook', 'bulk', 'blueprint'] as const) {
      expect(triggerClassOf(trigger)).toBe('unattended');
    }
  });
});

describe('evaluateUpdatePolicy eligibility matrix', () => {
  const cases: Array<{
    policy: string | undefined;
    manual: 'allow' | 'block';
    unattended: 'allow' | 'skip';
  }> = [
    { policy: undefined, manual: 'allow', unattended: 'allow' },
    { policy: 'auto', manual: 'allow', unattended: 'allow' },
    { policy: 'manual', manual: 'allow', unattended: 'skip' },
    { policy: 'invalid', manual: 'allow', unattended: 'skip' },
    { policy: 'disabled', manual: 'block', unattended: 'skip' },
  ];

  for (const item of cases) {
    it(`policy ${item.policy ?? 'absent'} on a stack target`, () => {
      const model = resolution({ web: item.policy === undefined ? {} : { update: item.policy } });
      expect(evaluateUpdatePolicy(model, stackRequest('manual')).decision).toBe(item.manual);
      expect(evaluateUpdatePolicy(model, stackRequest('scheduled')).decision).toBe(item.unattended);
    });

    it(`policy ${item.policy ?? 'absent'} on a service target`, () => {
      const model = resolution({ web: item.policy === undefined ? {} : { update: item.policy }, db: {} });
      expect(evaluateUpdatePolicy(model, serviceRequest('web', 'manual')).decision).toBe(item.manual);
      expect(evaluateUpdatePolicy(model, serviceRequest('web', 'automatic')).decision).toBe(item.unattended);
    });
  }

  it('is all-or-nothing: one disabled service blocks the whole stack', () => {
    const result = evaluateUpdatePolicy(resolution({ web: {}, db: { update: 'disabled' } }), stackRequest());
    expect(result.evaluation).toBe('evaluated');
    expect(result.decision).toBe('block');
    expect(ineligibleServices(result).map(s => s.service)).toEqual(['db']);
    // It never narrows the operation to the eligible services.
    if (result.evaluation !== 'evaluated') throw new Error('expected an evaluated result');
    expect(result.services.map(s => s.service).sort()).toEqual(['db', 'web']);
  });

  it('counts only the requested service for a service target', () => {
    const model = resolution({ web: {}, db: { update: 'disabled' } });
    expect(evaluateUpdatePolicy(model, serviceRequest('web')).decision).toBe('allow');
    expect(evaluateUpdatePolicy(model, serviceRequest('db')).decision).toBe('block');
  });

  it('names the ineligible service and policy in the reason, never the label value', () => {
    const result = evaluateUpdatePolicy(resolution({ db: { update: 'disabled' } }), stackRequest());
    expect(result.reason).toContain('db');
    expect(result.reason).toContain('set to disabled');
  });

  it('fails closed when the model cannot be rendered', () => {
    const blocked = evaluateUpdatePolicy({ renderable: false }, stackRequest('manual'));
    expect(blocked).toMatchObject({ evaluation: 'unrenderable', decision: 'block' });
    const skipped = evaluateUpdatePolicy({ renderable: false }, stackRequest('scheduled'));
    expect(skipped).toMatchObject({ evaluation: 'unrenderable', decision: 'skip' });
    if (blocked.evaluation !== 'unrenderable') throw new Error('expected unrenderable');
    expect(blocked.reason).toContain('could not be rendered');
  });

  it('fails closed for a service the rendered model does not contain', () => {
    const result = evaluateUpdatePolicy(resolution({ web: {} }), serviceRequest('ghost'));
    expect(result).toMatchObject({ evaluation: 'unrenderable', decision: 'block' });
  });

  it('changes the fingerprint when a policy changes', () => {
    const before = evaluateUpdatePolicy(resolution({ web: {} }), stackRequest());
    const after = evaluateUpdatePolicy(resolution({ web: { update: 'disabled' } }), stackRequest());
    if (before.evaluation !== 'evaluated' || after.evaluation !== 'evaluated') {
      throw new Error('expected evaluated results');
    }
    expect(before.fingerprint).not.toBe(after.fingerprint);
  });
});

describe('assertPolicyAllows', () => {
  it('accepts the exact request that produced it', () => {
    const policy = evaluateUpdatePolicy(resolution({ web: {} }), stackRequest());
    expect(() => assertPolicyAllows(policy, stackRequest())).not.toThrow();
  });

  it('refuses a different stack, target or trigger', () => {
    const policy = evaluateUpdatePolicy(resolution({ web: {} }), stackRequest());
    expect(() => assertPolicyAllows(policy, { ...stackRequest(), stack: 'other' })).toThrow(UpdatePolicyRefusedError);
    expect(() => assertPolicyAllows(policy, { ...stackRequest(), trigger: 'scheduled' })).toThrow(UpdatePolicyRefusedError);
    expect(() => assertPolicyAllows(policy, serviceRequest('web'))).toThrow(UpdatePolicyRefusedError);
  });

  it('refuses a result that does not allow', () => {
    const blocked = evaluateUpdatePolicy(resolution({ db: { update: 'disabled' } }), stackRequest());
    expect(() => assertPolicyAllows(blocked, stackRequest())).toThrow(UpdatePolicyRefusedError);
  });
});

describe('the wire projection', () => {
  it('round-trips an allowing result', () => {
    const policy = evaluateUpdatePolicy(resolution({ web: { update: 'manual' } }), stackRequest());
    const wire = toUpdatePolicyWire(policy);
    const read = readRemoteUpdatePolicy(wire);
    expect(read).not.toBeNull();
    expect(read?.decision).toBe(policy.decision);
    expect(read?.reason).toBe(policy.reason);
    expect(read?.services?.map(s => s.service)).toEqual(['web']);
  });

  it('round-trips an unrenderable result', () => {
    const policy = evaluateUpdatePolicy({ renderable: false }, stackRequest('scheduled'));
    const read = readRemoteUpdatePolicy(toUpdatePolicyWire(policy));
    expect(read).toMatchObject({ evaluation: 'unrenderable', decision: 'skip' });
  });

  it('rejects a malformed answer so the caller fails closed', () => {
    const good = toUpdatePolicyWire(evaluateUpdatePolicy(resolution({ web: {} }), stackRequest()));
    expect(readRemoteUpdatePolicy(null)).toBeNull();
    expect(readRemoteUpdatePolicy({ ...good, contract: 2 })).toBeNull();
    expect(readRemoteUpdatePolicy({ ...good, decision: 'maybe' })).toBeNull();
    expect(readRemoteUpdatePolicy({ ...good, stack: '' })).toBeNull();
    expect(readRemoteUpdatePolicy({ ...good, trigger: 'someday' })).toBeNull();
    expect(readRemoteUpdatePolicy({ ...good, fingerprint: 'nope' })).toBeNull();
    expect(readRemoteUpdatePolicy({ ...good, services: [{ service: 'web', policy: 'sometimes', eligible: true }] })).toBeNull();
    // A skip must say why.
    expect(readRemoteUpdatePolicy({ ...good, decision: 'skip', reason: null })).toBeNull();
  });

  it('describes a skip for a run history line', () => {
    const policy = evaluateUpdatePolicy(resolution({ db: { update: 'manual' } }), stackRequest('scheduled'));
    expect(describePolicySkip(policy)).toBe('skipped by update policy (db: manual)');
    const unrenderable = evaluateUpdatePolicy({ renderable: false }, stackRequest('scheduled'));
    expect(describePolicySkip(unrenderable)).toBe('skipped by update policy (Compose could not be rendered)');
  });
});
