/**
 * Unit tests for evaluateRollbackEligibility (pure verdict mapping).
 */
import { describe, expect, it } from 'vitest';
import {
  evaluateRollbackEligibility,
  type RollbackEligibilityInput,
} from '../services/rollbackEligibility';

const base = (over: Partial<RollbackEligibilityInput> = {}): RollbackEligibilityInput => ({
  generationIntegrityOk: true,
  heldImagesPresent: true,
  securityPostureBlocked: false,
  ...over,
});

describe('evaluateRollbackEligibility', () => {
  it('returns eligible when every signal is known-good', () => {
    expect(evaluateRollbackEligibility(base())).toBe('eligible');
  });

  it('returns prohibited when security posture is blocked', () => {
    expect(evaluateRollbackEligibility(base({ securityPostureBlocked: true }))).toBe('prohibited');
  });

  it('returns prohibited when generation integrity is known bad', () => {
    expect(evaluateRollbackEligibility(base({ generationIntegrityOk: false }))).toBe('prohibited');
  });

  it('prefers prohibited over other signals when security is blocked', () => {
    expect(evaluateRollbackEligibility(base({
      securityPostureBlocked: true,
      generationIntegrityOk: null,
      heldImagesPresent: false,
    }))).toBe('prohibited');
  });

  it('returns eligible_with_warning when held images are missing', () => {
    expect(evaluateRollbackEligibility(base({ heldImagesPresent: false }))).toBe('eligible_with_warning');
  });

  it('returns unknown when any remaining signal is null', () => {
    expect(evaluateRollbackEligibility(base({ generationIntegrityOk: null }))).toBe('unknown');
    expect(evaluateRollbackEligibility(base({ heldImagesPresent: null }))).toBe('unknown');
    expect(evaluateRollbackEligibility(base({ securityPostureBlocked: null }))).toBe('unknown');
  });

  it('returns unknown when all signals are null', () => {
    expect(evaluateRollbackEligibility({
      generationIntegrityOk: null,
      heldImagesPresent: null,
      securityPostureBlocked: null,
    })).toBe('unknown');
  });
});
