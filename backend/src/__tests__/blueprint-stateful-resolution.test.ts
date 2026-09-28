/**
 * The two readings of the same document, and why they must stay separate.
 *
 * `statefulServiceNamesStrict` is the evidence an automatic placement decision
 * rests on: a service it does not name is one the system believes carries no
 * data, so a construct it cannot resolve has to be a refusal rather than a
 * partial set.
 *
 * `statefulServiceNames` answers the same document best-effort, because its
 * caller is the stateful withdrawal guard, which compares two generations rather
 * than deciding whether to place anything. Returning null there holds the update
 * for ever on a compose file that was working yesterday, which broke automatic
 * source acceptance for every file using a merge key, an extends, or an include.
 * Those are ordinary idioms, not evidence of a stateful workload.
 */
import { describe, expect, it } from 'vitest';
import { BlueprintAnalyzer } from '../services/BlueprintAnalyzer';

describe('statefulServiceNamesStrict on content it cannot resolve', () => {
  it('refuses a YAML merge key rather than crediting the wrong service', () => {
    // The sharpest case. The anchored service is found, so a partial answer
    // would name it and report the service that merges it as stateless, which is
    // exactly the workload that inherits the volume.
    const names = BlueprintAnalyzer.statefulServiceNamesStrict(
      'services:\n  base: &b\n    volumes:\n      - data:/d\n  web:\n    <<: *b\n    image: nginx\n',
    );
    expect(names).toBeNull();
  });

  it('refuses an include, which names a file this text does not contain', () => {
    expect(
      BlueprintAnalyzer.statefulServiceNamesStrict('include:\n  - other.yaml\nservices:\n  web:\n    image: nginx\n'),
    ).toBeNull();
  });

  it('refuses an extends, for the same reason', () => {
    expect(
      BlueprintAnalyzer.statefulServiceNamesStrict(
        'services:\n  web:\n    extends:\n      file: base.yaml\n      service: db\n',
      ),
    ).toBeNull();
  });

  it('refuses a volumes_from, which attaches another container volumes', () => {
    expect(
      BlueprintAnalyzer.statefulServiceNamesStrict(
        'services:\n  web:\n    image: nginx\n    volumes_from:\n      - container:db\n',
      ),
    ).toBeNull();
  });

  it('refuses a document with no services at all', () => {
    // Nothing to place is not the same as proven stateless, and a caller
    // deciding whether a placement is safe should not have to tell them apart.
    expect(BlueprintAnalyzer.statefulServiceNamesStrict('volumes:\n  data:\n')).toBeNull();
  });
});

describe('statefulServiceNames on content it can resolve', () => {
  it('still reports nothing for a stateless service', () => {
    expect([...BlueprintAnalyzer.statefulServiceNamesStrict('services:\n  web:\n    image: nginx\n')!]).toEqual([]);
  });

  it('still names a service carrying a named volume', () => {
    expect([
      ...BlueprintAnalyzer.statefulServiceNamesStrict(
        'services:\n  db:\n    image: postgres\n    volumes:\n      - data:/var/lib\n',
      )!,
    ]).toEqual(['db']);
  });

  it('still ignores a tmpfs mount, which is not data the workload owns', () => {
    expect([
      ...BlueprintAnalyzer.statefulServiceNamesStrict(
        'services:\n  cache:\n    image: redis\n    volumes:\n      - type: tmpfs\n        target: /t\n',
      )!,
    ]).toEqual([]);
  });

  it('still returns null for content that does not parse', () => {
    expect(BlueprintAnalyzer.statefulServiceNamesStrict('services: [unclosed')).toBeNull();
  });
});

describe('the withdrawal guard reading is unaffected by the strict one', () => {
  /**
   * The regression this exists to catch. The strict reading was applied to the
   * shared helper, and the guard treats null as unreadable, so it compared the
   * staged candidate and the generation in force as unreadable and held every
   * update. A source on the automatic policy using a merge key stopped applying.
   */
  it.each([
    ['a YAML merge key', 'services:\n  base: &b\n    volumes:\n      - data:/d\n  web:\n    <<: *b\n    image: nginx\n'],
    ['an include', 'include:\n  - other.yaml\nservices:\n  web:\n    image: nginx\n'],
    ['an extends', 'services:\n  web:\n    extends:\n      file: base.yaml\n      service: db\n'],
    ['a volumes_from', 'services:\n  web:\n    image: nginx\n    volumes_from:\n      - container:db\n'],
    ['a document with no services', 'volumes:\n  data:\n'],
  ])('still answers for %s, so the guard does not hold the update for ever', (_label, yaml) => {
    // Best effort means an answer, and for these it is the services whose own
    // blocks declare a mount. Not a refusal, and not a claim that the workload is
    // stateless either: the guard's job is a withdrawal comparison, not a
    // placement decision.
    expect(BlueprintAnalyzer.statefulServiceNames(yaml)).not.toBeNull();
  });

  it('still names a service carrying a named volume alongside a merge key', () => {
    // The anchored service is visible even when the merge is not resolved, so
    // the guard still sees a withdrawal of it.
    const names = BlueprintAnalyzer.statefulServiceNames(
      'services:\n  base: &b\n    volumes:\n      - data:/d\n  web:\n    <<: *b\n    image: nginx\n',
    );
    expect(names).toEqual(new Set(['base']));
  });
});
