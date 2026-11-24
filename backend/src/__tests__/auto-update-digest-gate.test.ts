import { describe, it, expect } from 'vitest';
import {
  alsoPullsNote,
  createAutoUpdateDigestGateState,
  evaluateAutoUpdateTrigger,
  messageWhenDigestApplyBlockedByCheckErrors,
  messageWhenNoDigestUpdate,
  recordAutoUpdateImageCheck,
  triggerImagesFromContainers,
} from '../helpers/autoUpdateDigestGate';
import { checkResultFromDetection } from '../services/updateDetectionDirectives';

describe('autoUpdateDigestGate', () => {
  it('blocks digest apply when sibling check errors exist', () => {
    const state = createAutoUpdateDigestGateState();
    recordAutoUpdateImageCheck(state, 'nginx:latest', {
      hasUpdate: true,
      digestUpdate: true,
      tagUpdate: false,
    });
    recordAutoUpdateImageCheck(state, 'redis:latest', {
      hasUpdate: false,
      digestUpdate: false,
      tagUpdate: false,
      checkStatus: 'failed',
      error: 'registry timeout',
    });

    const msg = messageWhenDigestApplyBlockedByCheckErrors('web', state);
    expect(msg).toContain('image check(s) failed');
    expect(msg).toContain('registry timeout');
  });

  it('does not block when digest update exists without check errors', () => {
    const state = createAutoUpdateDigestGateState();
    recordAutoUpdateImageCheck(state, 'nginx:latest', {
      hasUpdate: true,
      digestUpdate: true,
      tagUpdate: false,
    });
    expect(messageWhenDigestApplyBlockedByCheckErrors('web', state)).toBeNull();
  });
});

describe('evaluateAutoUpdateTrigger with update detection labels', () => {
  const DIGEST_A = `sha256:${'a'.repeat(64)}`;
  const rebuild = (candidate = DIGEST_A) => checkResultFromDetection({
    hasUpdate: true, digestUpdate: true, tagUpdate: false, nextTag: 'latest', digestError: null,
    tagEnumKind: 'skipped', tagEnumReason: null, checkStatus: 'ok', reason: null, semverBump: 'patch',
    candidateDigest: candidate,
  });
  const upToDate = { hasUpdate: false, digestUpdate: false, tagUpdate: false, checkStatus: 'ok' as const };
  const failed = { hasUpdate: false, checkStatus: 'failed' as const, error: 'registry timeout' };
  const off = { check: false, ignore: [], changelogUrl: null };
  const skipA = { check: true, ignore: [{ kind: 'digest' as const, digest: DIGEST_A }], changelogUrl: null };

  it('does not start for an update only a skipping service has, and says so', async () => {
    const state = await evaluateAutoUpdateTrigger(
      [{ ref: 'web:latest', owners: ['web'] }, { ref: 'db:latest', owners: ['db'] }],
      new Map([['web', skipA]]),
      async ref => (ref === 'web:latest' ? rebuild() : upToDate),
    );
    expect(state.hasDigestUpdate).toBe(false);
    const message = messageWhenNoDigestUpdate('site', state, 2);
    expect(message).toBe('Stack "site": the only available update is skipped by io.sencho.update.ignore (web); no update applied.');
    expect(message).not.toContain('up to date');
  });

  it('does not start for an update only a checks-off service has, and says so', async () => {
    const state = await evaluateAutoUpdateTrigger(
      [{ ref: 'web:latest', owners: ['web'] }],
      new Map([['web', off]]),
      async () => rebuild(),
    );
    expect(state.hasDigestUpdate).toBe(false);
    expect(messageWhenNoDigestUpdate('site', state, 1))
      .toBe('Stack "site": the only available update belongs to a service with update checks off (web); no update applied.');
  });

  it('still blocks a sibling update when a checks-off service image fails its check', async () => {
    const state = await evaluateAutoUpdateTrigger(
      [{ ref: 'web:latest', owners: ['web'] }, { ref: 'db:latest', owners: ['db'] }],
      new Map([['db', off]]),
      async ref => (ref === 'web:latest' ? rebuild() : failed),
    );
    expect(state.hasDigestUpdate).toBe(true);
    expect(messageWhenDigestApplyBlockedByCheckErrors('site', state)).toContain('1 image check(s) failed');
  });

  it('starts for a real update and names the services it also pulls', async () => {
    const state = await evaluateAutoUpdateTrigger(
      [
        { ref: 'web:latest', owners: ['web'] },
        { ref: 'api:latest', owners: ['api'] },
        { ref: 'db:latest', owners: ['db'] },
      ],
      new Map([['api', skipA], ['db', off]]),
      async ref => (ref === 'web:latest' ? rebuild(`sha256:${'b'.repeat(64)}`) : ref === 'api:latest' ? rebuild() : upToDate),
    );
    expect(state.hasDigestUpdate).toBe(true);
    expect(state.updatedImages).toEqual(['web:latest']);
    expect(messageWhenDigestApplyBlockedByCheckErrors('site', state)).toBeNull();
    expect(alsoPullsNote(state)).toBe(' Also pulled: api (update skipped), db (update checks off).');
  });

  it('behaves as before for an unlabeled stack', async () => {
    const state = await evaluateAutoUpdateTrigger(
      [{ ref: 'web:latest', owners: ['web'] }, { ref: 'db:latest', owners: ['db'] }],
      new Map(),
      async ref => (ref === 'web:latest' ? rebuild() : upToDate),
    );
    expect(state).toMatchObject({ hasDigestUpdate: true, updatedImages: ['web:latest'], checkErrors: [], suppressed: [], alsoPulls: [] });
    expect(alsoPullsNote(state)).toBe('');
    const quiet = await evaluateAutoUpdateTrigger([{ ref: 'db:latest', owners: ['db'] }], new Map(), async () => upToDate);
    expect(messageWhenNoDigestUpdate('site', quiet, 1)).toBe('Stack "site": all images up to date.');
  });

  it('records a thrown or missing check as an error', async () => {
    const state = await evaluateAutoUpdateTrigger(
      [{ ref: 'web:latest', owners: ['web'] }, { ref: 'db:latest', owners: [] }],
      new Map(),
      async ref => {
        if (ref === 'web:latest') throw new Error('inspect failed');
        return null;
      },
    );
    expect(state.checkErrors).toEqual(['inspect failed', 'Update check incomplete']);
  });

  it('groups container images by Compose service, keeping ownerless and skipping digest refs', () => {
    expect(triggerImagesFromContainers([
      { Image: 'shared:1', Labels: { 'com.docker.compose.service': 'b' } },
      { Image: 'shared:1', Labels: { 'com.docker.compose.service': 'a' } },
      { Image: 'shared:1', Labels: { 'com.docker.compose.service': 'a' } },
      { Image: 'loose:1' },
      { Image: `sha256:${'c'.repeat(64)}` },
      {},
    ])).toEqual([{ ref: 'shared:1', owners: ['a', 'b'] }, { ref: 'loose:1', owners: [] }]);
  });
});
