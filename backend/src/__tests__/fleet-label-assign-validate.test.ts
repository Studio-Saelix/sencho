/**
 * Unit tests for validateRemoteAssignResults: the membership + shape guard the
 * bulk-assign orchestrator applies to a remote node's local-assign 200 body.
 * The receiver returns exactly one result row per unique requested stack, so a
 * body that drops, duplicates, or adds rows is a contract failure the control
 * must not read as a successful (possibly zero-stack) assign.
 */
import { describe, it, expect } from 'vitest';
import { validateRemoteAssignResults } from '../helpers/fleetLabelAssign';

describe('validateRemoteAssignResults', () => {
  it('accepts a body whose results cover exactly the requested stacks', () => {
    const out = validateRemoteAssignResults(['a', 'b'], {
      created: true,
      results: [
        { stackName: 'a', success: true },
        { stackName: 'b', success: false, error: 'Stack not found' },
      ],
    });
    expect(out).toEqual({
      ok: true,
      created: true,
      results: [
        { stackName: 'a', success: true },
        { stackName: 'b', success: false, error: 'Stack not found' },
      ],
    });
  });

  it('dedupes the requested set so a duplicated request still validates one row each', () => {
    const out = validateRemoteAssignResults(['a', 'a'], {
      created: false,
      results: [{ stackName: 'a', success: true }],
    });
    expect(out).toEqual({ ok: true, created: false, results: [{ stackName: 'a', success: true }] });
  });

  it('rejects an empty results array for a non-empty request (the false-success case)', () => {
    expect(validateRemoteAssignResults(['a'], { created: true, results: [] })).toEqual({ ok: false });
  });

  it('rejects a body that omits a requested stack', () => {
    expect(
      validateRemoteAssignResults(['a', 'b'], { created: true, results: [{ stackName: 'a', success: true }] }),
    ).toEqual({ ok: false });
  });

  it('rejects a result for a stack that was never requested', () => {
    expect(
      validateRemoteAssignResults(['a'], {
        created: true,
        results: [{ stackName: 'a', success: true }, { stackName: 'rogue', success: true }],
      }),
    ).toEqual({ ok: false });
  });

  it('rejects a duplicated result row for the same stack', () => {
    expect(
      validateRemoteAssignResults(['a'], {
        created: true,
        results: [{ stackName: 'a', success: true }, { stackName: 'a', success: false }],
      }),
    ).toEqual({ ok: false });
  });

  it('rejects a malformed result row (missing success)', () => {
    expect(
      validateRemoteAssignResults(['a'], { created: true, results: [{ stackName: 'a' }] }),
    ).toEqual({ ok: false });
  });

  it('rejects a result row with a non-string error', () => {
    expect(
      validateRemoteAssignResults(['a'], { created: true, results: [{ stackName: 'a', success: false, error: 5 }] }),
    ).toEqual({ ok: false });
  });

  it('rejects a non-boolean created', () => {
    expect(
      validateRemoteAssignResults(['a'], { created: 'yes', results: [{ stackName: 'a', success: true }] }),
    ).toEqual({ ok: false });
  });

  it('rejects a non-array results', () => {
    expect(validateRemoteAssignResults(['a'], { created: true, results: 'nope' })).toEqual({ ok: false });
  });

  it('rejects a null or non-object body', () => {
    expect(validateRemoteAssignResults(['a'], null)).toEqual({ ok: false });
    expect(validateRemoteAssignResults(['a'], 'string')).toEqual({ ok: false });
  });
});
