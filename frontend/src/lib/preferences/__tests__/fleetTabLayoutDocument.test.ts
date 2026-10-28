import { describe, it, expect, beforeEach } from 'vitest';
import { buildAppearanceDocument, hydrateAppearanceDocument, defaultAppearanceDocument, writePreferenceCacheFromDocuments, PREFERENCE_CACHE_KEYS } from '../preferencesDocuments';
import { FLEET_TAB_LAYOUT_KEY } from '@/hooks/use-fleet-tab-layout';

describe('the fleet tab layout in the appearance document', () => {
  beforeEach(() => localStorage.clear());

  it('is part of the serialized document and of the defaults', () => {
    expect(defaultAppearanceDocument().fleetTabLayout).toBe('flat');
    localStorage.setItem(FLEET_TAB_LAYOUT_KEY, 'compact');
    expect(buildAppearanceDocument().fleetTabLayout).toBe('compact');
  });

  it('is applied from a server document', () => {
    hydrateAppearanceDocument({ ...defaultAppearanceDocument(), fleetTabLayout: 'compact' });
    expect(localStorage.getItem(FLEET_TAB_LAYOUT_KEY)).toBe('compact');
  });

  it('falls back to the default for a document that lacks it or carries an unknown or retired value', () => {
    localStorage.setItem(FLEET_TAB_LAYOUT_KEY, 'compact');
    const withoutField: Record<string, unknown> = { ...defaultAppearanceDocument() };
    delete withoutField.fleetTabLayout;
    hydrateAppearanceDocument(withoutField);
    expect(localStorage.getItem(FLEET_TAB_LAYOUT_KEY)).toBe('flat');

    hydrateAppearanceDocument({ ...defaultAppearanceDocument(), fleetTabLayout: 'grouped' });
    expect(localStorage.getItem(FLEET_TAB_LAYOUT_KEY)).toBe('flat');
  });

  it('is restored by hydrating the default document, which is what Reset all appearance applies', () => {
    localStorage.setItem(FLEET_TAB_LAYOUT_KEY, 'compact');
    hydrateAppearanceDocument(defaultAppearanceDocument());
    expect(localStorage.getItem(FLEET_TAB_LAYOUT_KEY)).toBe('flat');
  });

  it('is owned by the preference cache, so another account never inherits it', () => {
    expect(PREFERENCE_CACHE_KEYS).toContain(FLEET_TAB_LAYOUT_KEY);
  });

  it('stays out of the theme cache blob, which only holds the fields without their own key', () => {
    localStorage.setItem(FLEET_TAB_LAYOUT_KEY, 'compact');
    writePreferenceCacheFromDocuments();
    const theme = JSON.parse(localStorage.getItem('sencho.appearance.theme') ?? '{}') as Record<string, unknown>;
    expect(theme).not.toHaveProperty('fleetTabLayout');
    expect(localStorage.getItem(FLEET_TAB_LAYOUT_KEY)).toBe('compact');
  });
});
