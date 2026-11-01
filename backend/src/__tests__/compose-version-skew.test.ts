/**
 * The shared Compose version-skew detector: which containers record a version
 * other than the one this node deploys with, and how that is worded. Pure, so
 * every case here is a direct function call.
 */
import { describe, it, expect } from 'vitest';
import {
  composeVersionContainerFromLabels,
  describeComposeVersionSkew,
  findComposeVersionSkew,
  normalizeComposeVersion,
  type ComposeVersionContainer,
} from '../helpers/composeVersionSkew';

const container = (over: Partial<ComposeVersionContainer> = {}): ComposeVersionContainer => ({
  service: 'web',
  composeVersion: '5.6.0',
  oneOff: false,
  ...over,
});

describe('normalizeComposeVersion', () => {
  it('drops the v prefix and surrounding whitespace', () => {
    expect(normalizeComposeVersion(' v2.38.1\n')).toBe('2.38.1');
    expect(normalizeComposeVersion(undefined)).toBe('');
    expect(normalizeComposeVersion(null)).toBe('');
  });
});

describe('composeVersionContainerFromLabels', () => {
  it('reads the three Compose labels', () => {
    expect(composeVersionContainerFromLabels({
      'com.docker.compose.service': 'proxy',
      'com.docker.compose.version': '2.38.1',
      'com.docker.compose.oneoff': 'True',
    })).toEqual({ service: 'proxy', composeVersion: '2.38.1', oneOff: true });
  });

  it('stores an empty label as null rather than an empty string', () => {
    expect(composeVersionContainerFromLabels({
      'com.docker.compose.service': '',
      'com.docker.compose.version': '',
      'com.docker.compose.oneoff': 'False',
    })).toEqual({ service: null, composeVersion: null, oneOff: false });
    expect(composeVersionContainerFromLabels(undefined)).toEqual({ service: null, composeVersion: null, oneOff: false });
  });
});

describe('findComposeVersionSkew', () => {
  it('reports nothing when every container records the running version', () => {
    expect(findComposeVersionSkew([container(), container({ service: 'app' })], '5.6.0')).toEqual({
      runningVersion: '5.6.0',
      services: [],
    });
  });

  it('reports the service whose container records another version', () => {
    expect(findComposeVersionSkew([
      container({ service: 'proxy', composeVersion: '2.38.1' }),
      container({ service: 'app', composeVersion: '5.6.0' }),
    ], '5.6.0')).toEqual({
      runningVersion: '5.6.0',
      services: [{ service: 'proxy', createdBy: ['2.38.1'] }],
    });
  });

  it('reports a container that records no version at all', () => {
    expect(findComposeVersionSkew([container({ composeVersion: null })], '5.6.0')?.services).toEqual([
      { service: 'web', createdBy: [null] },
    ]);
  });

  it('compares the versions with the v prefix removed on either side', () => {
    expect(findComposeVersionSkew([container({ composeVersion: 'v5.6.0' })], 'v5.6.0')?.services).toEqual([]);
    expect(findComposeVersionSkew([container({ composeVersion: '5.6.0' })], 'v5.6.0')?.services).toEqual([]);
  });

  it('lists a replicated service once with each version it records', () => {
    expect(findComposeVersionSkew([
      container({ service: 'web', composeVersion: '2.38.1' }),
      container({ service: 'web', composeVersion: '5.1.3' }),
      container({ service: 'web', composeVersion: '2.38.1' }),
      container({ service: 'web', composeVersion: null }),
    ], '5.6.0')?.services).toEqual([
      { service: 'web', createdBy: ['2.38.1', '5.1.3', null] },
    ]);
  });

  it('skips a container with no service label, which Compose removes rather than recreates', () => {
    expect(findComposeVersionSkew([
      container({ service: null, composeVersion: '2.38.1' }),
    ], '5.6.0')?.services).toEqual([]);
  });

  it('skips a one-off container, which a stack update never brings up', () => {
    expect(findComposeVersionSkew([
      container({ oneOff: true, composeVersion: '2.38.1' }),
    ], '5.6.0')?.services).toEqual([]);
  });

  it('returns null when the running version cannot be read', () => {
    expect(findComposeVersionSkew([container({ composeVersion: '2.38.1' })], null)).toBeNull();
    expect(findComposeVersionSkew([container({ composeVersion: '2.38.1' })], '  ')).toBeNull();
  });

  it('returns an empty service list for a stack with no containers', () => {
    expect(findComposeVersionSkew([], '5.6.0')).toEqual({ runningVersion: '5.6.0', services: [] });
  });

  it('sorts the affected services by name', () => {
    const skew = findComposeVersionSkew([
      container({ service: 'worker', composeVersion: '2.38.1' }),
      container({ service: 'app', composeVersion: '2.38.1' }),
      container({ service: 'proxy', composeVersion: '2.38.1' }),
    ], '5.6.0');
    expect(skew?.services.map(s => s.service)).toEqual(['app', 'proxy', 'worker']);
  });
});

describe('describeComposeVersionSkew', () => {
  it('names one service', () => {
    expect(describeComposeVersionSkew({
      runningVersion: '5.6.0',
      services: [{ service: 'proxy', createdBy: ['2.38.1'] }],
    })).toBe('proxy was created by Docker Compose 2.38.1');
  });

  it('combines two services that share a version', () => {
    expect(describeComposeVersionSkew({
      runningVersion: '5.6.0',
      services: [
        { service: 'app', createdBy: ['2.38.1'] },
        { service: 'proxy', createdBy: ['2.38.1'] },
      ],
    })).toBe('app and proxy were created by Docker Compose 2.38.1');
  });

  it('lists more than two services', () => {
    expect(describeComposeVersionSkew({
      runningVersion: '5.6.0',
      services: [
        { service: 'app', createdBy: ['2.38.1'] },
        { service: 'jobs', createdBy: ['2.38.1'] },
        { service: 'proxy', createdBy: ['2.38.1'] },
      ],
    })).toBe('app, jobs, and proxy were created by Docker Compose 2.38.1');
  });

  it('states a container that records no Compose version', () => {
    expect(describeComposeVersionSkew({
      runningVersion: '5.6.0',
      services: [{ service: 'proxy', createdBy: [null] }],
    })).toBe('proxy records no Compose version');
  });

  it('keeps a genuinely mixed set in one clause per group', () => {
    expect(describeComposeVersionSkew({
      runningVersion: '5.6.0',
      services: [
        { service: 'app', createdBy: ['2.38.1'] },
        { service: 'proxy', createdBy: ['5.1.3'] },
      ],
    })).toBe('app was created by Docker Compose 2.38.1; proxy was created by Docker Compose 5.1.3');
  });

  it('lists each recorded version once for a replicated service', () => {
    expect(describeComposeVersionSkew({
      runningVersion: '5.6.0',
      services: [{ service: 'web', createdBy: ['2.38.1', '5.1.3'] }],
    })).toBe('web was created by Docker Compose 2.38.1 and 5.1.3');
  });
});
