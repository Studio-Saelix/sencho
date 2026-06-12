import { describe, it, expect } from 'vitest';
import { MOBILE_TREATMENTS, BESPOKE_MOBILE_VIEWS, type MobileTreatment } from './mobile-treatments';

const VALID: MobileTreatment[] = ['bespoke', 'responsive', 'desktop-only', 'detail'];

describe('mobile treatments', () => {
  it('classifies every view with a known treatment', () => {
    // The Record<ActiveView, MobileTreatment> type already forces every view to
    // be present at compile time; this guards the values at runtime so a typo or
    // a bad merge cannot leave an unknown treatment in the map.
    for (const [view, treatment] of Object.entries(MOBILE_TREATMENTS)) {
      expect(VALID, `${view} has an unknown treatment "${treatment}"`).toContain(treatment);
    }
  });

  it('treats the Security view as responsive (reflowed, not bespoke or desktop-only)', () => {
    expect(MOBILE_TREATMENTS.security).toBe('responsive');
  });

  it('keeps BESPOKE_MOBILE_VIEWS in lockstep with the bespoke treatments', () => {
    const declaredBespoke = Object.entries(MOBILE_TREATMENTS)
      .filter(([, treatment]) => treatment === 'bespoke')
      .map(([view]) => view)
      .sort();
    expect([...BESPOKE_MOBILE_VIEWS].sort()).toEqual(declaredBespoke);
  });

  it('pins the set of bespoke phone screens (update deliberately when adding one)', () => {
    // A change here means a top-level view gained or lost a bespoke phone screen.
    // Updating this list should go hand in hand with adding the screen under
    // components/mobile/ and wiring its case in EditorLayout's renderMobileBespoke.
    expect([...BESPOKE_MOBILE_VIEWS].sort()).toEqual(
      ['dashboard', 'fleet', 'scheduled-ops', 'settings'],
    );
  });
});
