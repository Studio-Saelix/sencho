import { describe, it, expect } from 'vitest';
import {
  classifyExposedImages,
  classifyImageExposureBucket,
  collectKevDrivers,
  POSTURE_DRIVER_CAP,
  type ExposedFindingRow,
} from '../services/securityExposureClassification';
import type { PostureTarget } from '../services/securityPosture';

function intentionalTarget(imageRef: string, intent: 'public' | 'lan' | 'reverse-proxy' | 'temporary' = 'public'): PostureTarget {
  return {
    imageRef,
    stackName: 'web',
    serviceName: 'api',
    intentStatus: 'set',
    exposureIntent: intent,
    intentConflict: false,
  };
}

function conflictTarget(imageRef: string): PostureTarget {
  return {
    imageRef,
    stackName: 'web',
    serviceName: 'api',
    intentStatus: 'set',
    exposureIntent: 'internal',
    intentConflict: true,
  };
}

function unsetTarget(imageRef: string): PostureTarget {
  return { imageRef, stackName: 'web', serviceName: 'api', intentStatus: 'unset' };
}

function mapsFor(imageRef: string, opts: {
  findings: ExposedFindingRow[];
  targets: PostureTarget[];
  exposed?: boolean;
  unsuppressed?: ExposedFindingRow[];
  intel?: Map<string, { kev?: boolean; epssScore?: number | null }>;
}) {
  const critHighByImage = new Map([[imageRef, opts.findings]]);
  const exposedMap = new Map([[imageRef, opts.exposed ?? true]]);
  const targetsByImage = new Map([[imageRef, opts.targets]]);
  const unsuppressedByImage = new Map([[imageRef, opts.unsuppressed ?? opts.findings]]);
  return {
    critHighByImage,
    exposedMap,
    targetsByImage,
    unsuppressedByImage,
    intel: opts.intel ?? new Map(),
  };
}

describe('classifyImageExposureBucket', () => {
  it('returns conflict when any target conflicts', () => {
    expect(classifyImageExposureBucket([
      intentionalTarget('a:1'),
      conflictTarget('a:1'),
    ])).toBe('conflict');
  });

  it('returns intentional when all complete contexts are intentional', () => {
    expect(classifyImageExposureBucket([
      intentionalTarget('a:1', 'public'),
      intentionalTarget('a:1', 'lan'),
      intentionalTarget('a:1', 'reverse-proxy'),
    ])).toBe('intentional');
  });

  it('returns unclassified for unset or empty targets', () => {
    expect(classifyImageExposureBucket([unsetTarget('a:1')])).toBe('unclassified');
    expect(classifyImageExposureBucket([])).toBe('unclassified');
  });
});

describe('classifyExposedImages', () => {
  it('intentional public/lan/reverse-proxy + fixed_version only → no conflict, no elevated, unclassified=0', () => {
    for (const intent of ['public', 'lan', 'reverse-proxy'] as const) {
      const imageRef = `img-${intent}:1`;
      const result = classifyExposedImages(mapsFor(imageRef, {
        findings: [{ vulnerability_id: 'CVE-1' }],
        targets: [intentionalTarget(imageRef, intent)],
      }));
      expect(result).toMatchObject({
        publiclyExposed: 1,
        exposureIntentConflict: 0,
        exposedUnclassified: 0,
        elevatedExploitRisk: 0,
      });
      expect(result.elevatedExploitRiskDrivers).toEqual([]);
    }
  });

  it('intentional + high EPSS → elevatedExploitRisk', () => {
    const imageRef = 'exp:1';
    const result = classifyExposedImages(mapsFor(imageRef, {
      findings: [{ vulnerability_id: 'CVE-EPSS' }],
      targets: [intentionalTarget(imageRef)],
      intel: new Map([['CVE-EPSS', { epssScore: 0.42 }]]),
    }));
    expect(result.elevatedExploitRisk).toBe(1);
    expect(result.exposureIntentConflict).toBe(0);
    expect(result.exposedUnclassified).toBe(0);
    expect(result.elevatedExploitRiskDrivers).toEqual([
      { vulnerabilityId: 'CVE-EPSS', imageRef },
    ]);
  });

  it('conflict (internal) + unsuppressed → exposureIntentConflict', () => {
    const imageRef = 'bad:1';
    const result = classifyExposedImages(mapsFor(imageRef, {
      findings: [{ vulnerability_id: 'CVE-1' }],
      targets: [conflictTarget(imageRef)],
    }));
    expect(result.exposureIntentConflict).toBe(1);
    expect(result.exposedUnclassified).toBe(0);
    expect(result.elevatedExploitRisk).toBe(0);
    expect(result.exposureIntentConflictTargets[0]?.intentConflict).toBe(true);
  });

  it('unset intent → exposedUnclassified, not conflict', () => {
    const imageRef = 'unset:1';
    const result = classifyExposedImages(mapsFor(imageRef, {
      findings: [{ vulnerability_id: 'CVE-1' }],
      targets: [unsetTarget(imageRef)],
    }));
    expect(result.exposedUnclassified).toBe(1);
    expect(result.exposureIntentConflict).toBe(0);
    expect(result.elevatedExploitRisk).toBe(0);
  });

  it('fully empty unsuppressed → only publiclyExposed count', () => {
    const imageRef = 'supp:1';
    const result = classifyExposedImages(mapsFor(imageRef, {
      findings: [{ vulnerability_id: 'CVE-1' }],
      targets: [unsetTarget(imageRef)],
      unsuppressed: [],
    }));
    expect(result).toMatchObject({
      publiclyExposed: 1,
      exposureIntentConflict: 0,
      exposedUnclassified: 0,
      elevatedExploitRisk: 0,
    });
  });

  it('caps elevated drivers at POSTURE_DRIVER_CAP', () => {
    const imageRef = 'many:1';
    const findings: ExposedFindingRow[] = [];
    const intel = new Map<string, { epssScore: number }>();
    for (let i = 0; i < POSTURE_DRIVER_CAP + 5; i += 1) {
      const id = `CVE-${i}`;
      findings.push({ vulnerability_id: id });
      intel.set(id, { epssScore: 0.5 });
    }
    const result = classifyExposedImages(mapsFor(imageRef, {
      findings,
      targets: [intentionalTarget(imageRef)],
      intel,
    }));
    expect(result.elevatedExploitRisk).toBe(1);
    expect(result.elevatedExploitRiskDrivers).toHaveLength(POSTURE_DRIVER_CAP);
  });
});

describe('collectKevDrivers', () => {
  it('collects unsuppressed KEV drivers and skips suppressed', () => {
    const capped = collectKevDrivers([
      { imageRef: 'a:1', vulnerability_id: 'CVE-A', suppressed: false },
      { imageRef: 'a:1', vulnerability_id: 'CVE-B', suppressed: true },
      { imageRef: 'b:1', vulnerability_id: 'CVE-C' },
    ]);
    expect(capped).toEqual({
      drivers: [
        { vulnerabilityId: 'CVE-A', imageRef: 'a:1' },
        { vulnerabilityId: 'CVE-C', imageRef: 'b:1' },
      ],
      driverCount: 2,
      driversTruncated: false,
    });
  });

  it('caps KEV drivers at POSTURE_DRIVER_CAP', () => {
    const rows: Array<{ imageRef: string; vulnerability_id: string }> = [];
    for (let i = 0; i < POSTURE_DRIVER_CAP + 3; i += 1) {
      rows.push({ imageRef: 'img:1', vulnerability_id: `CVE-K${i}` });
    }
    const capped = collectKevDrivers(rows);
    expect(capped.drivers).toHaveLength(POSTURE_DRIVER_CAP);
    expect(capped.driverCount).toBe(POSTURE_DRIVER_CAP + 3);
    expect(capped.driversTruncated).toBe(true);
  });
});
