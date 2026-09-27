/**
 * Stateful service detection where the compose cannot be fully resolved.
 *
 * `statefulServiceNames` is the evidence an automatic placement decision rests
 * on: a service it does not name is one the system believes carries no data.
 * Every construct here can attach a mount to a service whose own block mentions
 * none, so a function that returned the services it could see would report the
 * rest as stateless. Null is the answer that means "cannot prove", and both of
 * its callers already hold on it rather than reading it as a clean result.
 */
import { describe, expect, it } from 'vitest';
import { BlueprintAnalyzer } from '../services/BlueprintAnalyzer';

describe('statefulServiceNames on content it cannot resolve', () => {
  it('refuses a YAML merge key rather than crediting the wrong service', () => {
    // The sharpest case. The anchored service is found, so a partial answer
    // would name it and report the service that merges it as stateless, which is
    // exactly the workload that inherits the volume.
    const names = BlueprintAnalyzer.statefulServiceNames(
      'services:\n  base: &b\n    volumes:\n      - data:/d\n  web:\n    <<: *b\n    image: nginx\n',
    );
    expect(names).toBeNull();
  });

  it('refuses an include, which names a file this text does not contain', () => {
    expect(
      BlueprintAnalyzer.statefulServiceNames('include:\n  - other.yaml\nservices:\n  web:\n    image: nginx\n'),
    ).toBeNull();
  });

  it('refuses an extends, for the same reason', () => {
    expect(
      BlueprintAnalyzer.statefulServiceNames(
        'services:\n  web:\n    extends:\n      file: base.yaml\n      service: db\n',
      ),
    ).toBeNull();
  });

  it('refuses a volumes_from, which attaches another container volumes', () => {
    expect(
      BlueprintAnalyzer.statefulServiceNames(
        'services:\n  web:\n    image: nginx\n    volumes_from:\n      - container:db\n',
      ),
    ).toBeNull();
  });

  it('refuses a document with no services at all', () => {
    // Nothing to place is not the same as proven stateless, and a caller
    // deciding whether a placement is safe should not have to tell them apart.
    expect(BlueprintAnalyzer.statefulServiceNames('volumes:\n  data:\n')).toBeNull();
  });
});

describe('statefulServiceNames on content it can resolve', () => {
  it('still reports nothing for a stateless service', () => {
    expect([...BlueprintAnalyzer.statefulServiceNames('services:\n  web:\n    image: nginx\n')!]).toEqual([]);
  });

  it('still names a service carrying a named volume', () => {
    expect([
      ...BlueprintAnalyzer.statefulServiceNames(
        'services:\n  db:\n    image: postgres\n    volumes:\n      - data:/var/lib\n',
      )!,
    ]).toEqual(['db']);
  });

  it('still ignores a tmpfs mount, which is not data the workload owns', () => {
    expect([
      ...BlueprintAnalyzer.statefulServiceNames(
        'services:\n  cache:\n    image: redis\n    volumes:\n      - type: tmpfs\n        target: /t\n',
      )!,
    ]).toEqual([]);
  });

  it('still returns null for content that does not parse', () => {
    expect(BlueprintAnalyzer.statefulServiceNames('services: [unclosed')).toBeNull();
  });
});
