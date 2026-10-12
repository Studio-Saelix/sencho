import { describe, it, expect, beforeEach } from 'vitest';
import { defaultAppearanceDocument, hydrateAppearanceDocument } from '../preferencesDocuments';
import { LOG_CHIP_COLOR_KEY } from '@/hooks/use-log-chip-color-mode';

describe('the default appearance document', () => {
  beforeEach(() => localStorage.clear());

  it('uses the Signature chart palette and per-service log chips', () => {
    const d = defaultAppearanceDocument();
    expect(d.chartStyle).toBe('signature');
    expect(d.logChipColorMode).toBe('per-service');
  });

  it('applies the log chip default when hydrated', () => {
    hydrateAppearanceDocument(defaultAppearanceDocument());
    expect(localStorage.getItem(LOG_CHIP_COLOR_KEY)).toBe('per-service');
  });
});
