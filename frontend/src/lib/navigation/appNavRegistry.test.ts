import { describe, it, expect } from 'vitest';
import {
  APP_NAV_REGISTRY,
  recommendedQuickLinkIds,
} from './appNavRegistry';

describe('appNavRegistry', () => {
  it('has unique ActiveView values', () => {
    const values = APP_NAV_REGISTRY.map((item) => item.value);
    expect(new Set(values).size).toBe(values.length);
  });

  it('gives every non-Settings destination exactly one Smart placement of primary or overflow', () => {
    for (const item of APP_NAV_REGISTRY) {
      if (item.value === 'settings') {
        expect(item.smart).toBe('launcher-only');
        continue;
      }
      expect(item.smart === 'primary' || item.smart === 'overflow').toBe(true);
    }
  });

  it('exports recommendedQuickLinkIds from defaultQuickLink metadata in that order', () => {
    const flagged = APP_NAV_REGISTRY.filter((item) => item.defaultQuickLink).map((item) => item.value);
    expect(new Set(recommendedQuickLinkIds)).toEqual(new Set(flagged));
    expect([...recommendedQuickLinkIds]).toEqual([
      'dashboard',
      'fleet',
      'resources',
      'security',
      'auto-updates',
      'scheduled-ops',
    ]);
    for (const id of recommendedQuickLinkIds) {
      const item = APP_NAV_REGISTRY.find((entry) => entry.value === id);
      expect(item?.quickLinkEligible).toBe(true);
      expect(item?.defaultQuickLink).toBe(true);
    }
  });

  it('keeps Networking after Resources in navOrder metadata', () => {
    const resources = APP_NAV_REGISTRY.find((item) => item.value === 'resources');
    const networking = APP_NAV_REGISTRY.find((item) => item.value === 'networking');
    expect(resources).toBeDefined();
    expect(networking).toBeDefined();
    expect(networking!.navOrder).toBeGreaterThan(resources!.navOrder);
  });
});
