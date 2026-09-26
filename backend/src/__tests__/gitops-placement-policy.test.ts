/**
 * Bounded automatic placement.
 *
 * Every reason the decision can return is pinned here, in the direction that
 * matters: a refusal when the evidence says refuse, and an approval only for the
 * two shapes the policy allows. The totality cases matter most, because this
 * function runs inside a caller's write path and a decision that can throw is a
 * decision that can fail somebody else's commit.
 */
import { describe, expect, it } from 'vitest';
import {
  decideBoundedAutoPlacement,
  type AffectedNodeState,
  type BoundedAutoInput,
  type WorkloadStatelessness,
} from '../services/gitops/placementPolicy';

/** A bounded-auto input that reaches the end of the rule chain, then vary one thing. */
function input(overrides: Partial<BoundedAutoInput> = {}): BoundedAutoInput {
  return {
    policy: 'bounded_auto',
    approvedNodeIds: [1, 2],
    candidateNodeIds: [1, 2, 3],
    hasPriorApproval: true,
    statelessness: 'stateless',
    pinDriven: false,
    cordonOverride: false,
    affectedNodeState: 'reachable',
    conflictingOperation: false,
    evidenceReadable: true,
    evidenceWellFormed: true,
    ...overrides,
  };
}

describe('the policy gate', () => {
  it('defers to an operator without consulting anything else', () => {
    // Every other signal is adverse and the reason is still the policy, because
    // an operator policy is the answer and the rest was never needed.
    const decision = decideBoundedAutoPlacement(
      input({
        policy: 'operator',
        conflictingOperation: true,
        evidenceReadable: false,
        statelessness: 'stateful',
      }),
    );
    expect(decision.decision).toBe('operator_review');
    expect(decision.reason).toBe('policy_is_operator');
  });
});

describe('the two shapes the policy allows', () => {
  it('approves exactly one stateless addition', () => {
    const decision = decideBoundedAutoPlacement(input());
    expect(decision).toEqual({
      decision: 'auto_approve',
      reason: 'stateless_addition',
      effect: { additions: [3], removals: [] },
    });
  });

  it('approves exactly one stateless removal', () => {
    const decision = decideBoundedAutoPlacement(
      input({ approvedNodeIds: [1, 2, 3], candidateNodeIds: [1, 2] }),
    );
    expect(decision).toEqual({
      decision: 'auto_approve',
      reason: 'stateless_removal',
      effect: { additions: [], removals: [3] },
    });
  });

  it('does nothing when the candidate asks for the set already approved', () => {
    // Not an approval and not a review. There is nothing to decide, and
    // recording an approval here would mint authority for no change.
    const decision = decideBoundedAutoPlacement(input({ candidateNodeIds: [1, 2] }));
    expect(decision).toEqual({
      decision: 'no_action',
      reason: 'no_placement_change',
      effect: { additions: [], removals: [] },
    });
  });

  it('treats a reordered set as no change, because sets are compared canonically', () => {
    const decision = decideBoundedAutoPlacement(input({ candidateNodeIds: [2, 1] }));
    expect(decision.decision).toBe('no_action');
  });
});

describe('the shape of the change', () => {
  it('refuses one addition plus one removal', () => {
    const decision = decideBoundedAutoPlacement(
      input({ approvedNodeIds: [1, 2], candidateNodeIds: [2, 3] }),
    );
    expect(decision.reason).toBe('mixed_add_and_remove');
    expect(decision.decision).toBe('operator_review');
  });

  it('refuses more than one addition', () => {
    const decision = decideBoundedAutoPlacement(
      input({ approvedNodeIds: [1], candidateNodeIds: [1, 2, 3] }),
    );
    expect(decision.reason).toBe('multiple_additions');
  });

  it('refuses more than one removal', () => {
    const decision = decideBoundedAutoPlacement(
      input({ approvedNodeIds: [1, 2, 3], candidateNodeIds: [1] }),
    );
    expect(decision.reason).toBe('multiple_removals');
  });

  it('reports the effect it refused, so the refusal is auditable', () => {
    const decision = decideBoundedAutoPlacement(
      input({ approvedNodeIds: [1, 2, 3], candidateNodeIds: [2, 4, 5] }),
    );
    expect(decision.decision).toBe('operator_review');
    if (decision.decision === 'operator_review') {
      expect(decision.effect).toEqual({ additions: [4, 5], removals: [1, 3] });
    }
  });
});

describe('a first placement', () => {
  it('refuses a first placement across more than one node', () => {
    const decision = decideBoundedAutoPlacement(
      input({ approvedNodeIds: [], candidateNodeIds: [1, 2], hasPriorApproval: false }),
    );
    expect(decision.reason).toBe('first_multi_node_placement');
  });

  it('allows a first placement of exactly one node, which is an ordinary addition', () => {
    const decision = decideBoundedAutoPlacement(
      input({ approvedNodeIds: [], candidateNodeIds: [7], hasPriorApproval: false }),
    );
    expect(decision.decision).toBe('auto_approve');
    expect(decision.reason).toBe('stateless_addition');
  });

  it('stops treating a later multi-node change as a first placement', () => {
    const decision = decideBoundedAutoPlacement(
      input({ approvedNodeIds: [1], candidateNodeIds: [1, 2, 3], hasPriorApproval: true }),
    );
    // Never a first placement once something has been approved, so this falls to
    // the cardinality rule, which is the honest reason here.
    expect(decision.reason).toBe('multiple_additions');
  });
});

describe('workload nature', () => {
  it('refuses a stateful workload on an addition and on a removal alike', () => {
    for (const overrides of [
      { approvedNodeIds: [1], candidateNodeIds: [1, 2] },
      { approvedNodeIds: [1, 2], candidateNodeIds: [1] },
    ]) {
      const decision = decideBoundedAutoPlacement(input({ ...overrides, statelessness: 'stateful' }));
      expect(decision.reason).toBe('stateful_workload');
    }
  });

  it('refuses a workload whose nature could not be established', () => {
    // Unreadable compose is treated as data. Reading it as stateless would be
    // the one interpretation that turns missing evidence into an approval.
    const decision = decideBoundedAutoPlacement(input({ statelessness: 'unknown' }));
    expect(decision.reason).toBe('unknown_workload');
  });

  it.each<WorkloadStatelessness>(['stateful', 'unknown'])(
    'never auto-approves when the workload reads as %s',
    (statelessness) => {
      // The `stateless` case is deliberately absent: that is the one reading
      // that may approve, and it only gets there from evidence that was read.
      expect(decideBoundedAutoPlacement(input({ statelessness })).decision).not.toBe('auto_approve');
    },
  );

  it('treats an absent statelessness as stateful rather than as stateless', () => {
    // A missing reading is not a stateless reading. Defaulting the other way
    // would turn a field that never arrived into the one answer that approves.
    const decision = decideBoundedAutoPlacement(
      input({ statelessness: undefined as unknown as WorkloadStatelessness }),
    );
    expect(decision.decision).toBe('operator_review');
    expect(decision.reason).toBe('stateful_workload');
  });
});

describe('node and binding state', () => {
  it('refuses a cordon override', () => {
    expect(decideBoundedAutoPlacement(input({ cordonOverride: true })).reason).toBe('cordon_override');
  });

  it('refuses placement that moved because a pin moved', () => {
    expect(decideBoundedAutoPlacement(input({ pinDriven: true })).reason).toBe('pin_driven_placement');
  });

  it.each<[AffectedNodeState, string]>([
    ['unreachable', 'stale_node'],
    ['unknown', 'unknown_connectivity'],
  ])('refuses a node that is %s', (affectedNodeState, reason) => {
    expect(decideBoundedAutoPlacement(input({ affectedNodeState })).reason).toBe(reason);
  });

  it('refuses while an operation is in flight', () => {
    // Ahead of the evidence and shape rules: a decision taken while a fetch,
    // apply, deploy, or recovery is running is a decision about a moving world.
    const decision = decideBoundedAutoPlacement(
      input({ conflictingOperation: true, evidenceReadable: false }),
    );
    expect(decision.reason).toBe('conflicting_operation');
  });
});

describe('evidence integrity', () => {
  it('refuses when the evidence could not be read', () => {
    const decision = decideBoundedAutoPlacement(
      input({ evidenceReadable: false, statelessness: 'stateless' }),
    );
    expect(decision.reason).toBe('missing_evidence');
    expect(decision.decision).toBe('operator_review');
  });

  it('refuses when the evidence was present but unusable', () => {
    expect(decideBoundedAutoPlacement(input({ evidenceWellFormed: false })).reason).toBe(
      'malformed_evidence',
    );
  });

  it('never approves on missing or malformed evidence, whatever else looks safe', () => {
    for (const overrides of [{ evidenceReadable: false }, { evidenceWellFormed: false }]) {
      const decision = decideBoundedAutoPlacement(
        input({ approvedNodeIds: [1], candidateNodeIds: [1, 2], ...overrides }),
      );
      expect(decision.decision).toBe('operator_review');
    }
  });
});

describe('a destructive effect', () => {
  it('refuses a removal that would leave the application with no target', () => {
    // This is the case that reads as an approved removal without the check: one
    // removal, stateless, reachable, no conflict, and the application is now
    // withdrawn entirely.
    const decision = decideBoundedAutoPlacement(
      input({ approvedNodeIds: [1], candidateNodeIds: [] }),
    );
    expect(decision.decision).toBe('operator_review');
    expect(decision.reason).toBe('destructive_effect');
  });

  it('refuses emptying the set from more than one node as a cardinality problem first', () => {
    const decision = decideBoundedAutoPlacement(
      input({ approvedNodeIds: [1, 2], candidateNodeIds: [] }),
    );
    expect(decision.reason).toBe('multiple_removals');
  });
});

describe('the baseline', () => {
  it('is the approved set, so a pending unapproved candidate is not absorbed', () => {
    // The bug this pins. An intent revision clears the placement approval before
    // a new candidate opens, so the only set still in hand is a superseded
    // candidate nobody approved: {A,B} awaiting review. Diffing against it reads
    // the later {A,B,C} as one stateless addition and authorizes B on the
    // strength of a decision no operator made.
    const pendingUnapproved = [1, 2];
    const decision = decideBoundedAutoPlacement(
      input({
        // The approved set is empty: nothing has ever been approved.
        approvedNodeIds: [],
        candidateNodeIds: [...pendingUnapproved, 3],
        hasPriorApproval: false,
      }),
    );
    expect(decision.decision).toBe('operator_review');
    expect(decision.reason).toBe('first_multi_node_placement');
    if (decision.decision === 'operator_review') {
      // All three nodes are the addition, not just the one that differs from
      // the superseded candidate.
      expect(decision.effect.additions).toEqual([1, 2, 3]);
    }
  });

  it('would have approved the absorbed candidate if the baseline were the superseded one', () => {
    // The mutation check: this is what the decision returns when handed the
    // superseded candidate as its baseline, which is exactly the reading the
    // baseline rule exists to prevent.
    const decision = decideBoundedAutoPlacement(
      input({ approvedNodeIds: [1, 2], candidateNodeIds: [1, 2, 3] }),
    );
    expect(decision.decision).toBe('auto_approve');
  });
});

describe('totality', () => {
  it('returns a reason rather than throwing for hostile input', () => {
    // The function runs inside a caller's write path. A decision that can throw
    // is a decision that can fail somebody else's commit instead of making its
    // own call, so every one of these has to come back as a decision.
    const hostile: unknown[] = [
      undefined,
      null,
      0,
      '',
      'bounded_auto',
      [],
      {},
      { policy: 'bounded_auto' },
      { policy: 'bounded_auto', approvedNodeIds: 'nope', candidateNodeIds: [1] },
      { policy: 'bounded_auto', approvedNodeIds: [1], candidateNodeIds: null },
      { policy: 'unknown-policy' },
      { policy: 'bounded_auto', approvedNodeIds: [1], candidateNodeIds: [1, 2], statelessness: 'wat' },
      { policy: 'bounded_auto', approvedNodeIds: [1], candidateNodeIds: [1, 2], affectedNodeState: 'maybe' },
      { policy: 'bounded_auto', approvedNodeIds: ['1'], candidateNodeIds: [2] },
      { policy: 'bounded_auto', approvedNodeIds: [NaN], candidateNodeIds: [2] },
    ];
    for (const value of hostile) {
      let decision: unknown;
      expect(() => {
        decision = decideBoundedAutoPlacement(value as BoundedAutoInput);
      }, `threw for ${JSON.stringify(value)}`).not.toThrow();
      expect(decision).toBeDefined();
    }
  });

  it('treats an absent effect as no change rather than approving it', () => {
    // A malformed set list is evidence damage, not an empty change. The
    // difference is refused at the setDifference layer by the reader, so the
    // decision sees a well-formed empty effect and says nothing changed.
    const decision = decideBoundedAutoPlacement(
      input({ approvedNodeIds: [], candidateNodeIds: [], hasPriorApproval: false }),
    );
    expect(decision.decision).toBe('no_action');
  });
});
