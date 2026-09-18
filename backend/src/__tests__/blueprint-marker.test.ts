import { describe, expect, it } from 'vitest';
import { parseBlueprintMarker } from '../helpers/blueprintMarker';

const BASE = { blueprintId: 3, revision: 2, lastApplied: 100 };

function parsed(extra: Record<string, unknown> = {}): ReturnType<typeof parseBlueprintMarker> {
  return parseBlueprintMarker(JSON.stringify({ ...BASE, ...extra }));
}

describe('parseBlueprintMarker', () => {
  it('keeps a marker without binding fields valid', () => {
    expect(parsed()).toEqual(BASE);
  });

  it('reads optional applicationId and bindingRevision as evidence', () => {
    expect(parsed({
      applicationId: 'app-web',
      bindingRevision: 'rev-9',
      unknown: true,
    })).toEqual({
      ...BASE,
      applicationId: 'app-web',
      bindingRevision: 'rev-9',
    });
  });

  it('ignores binding fields that are the wrong type', () => {
    expect(parsed({
      applicationId: 12,
      bindingRevision: { id: 'rev-9' },
    })).toEqual(BASE);
  });
});
