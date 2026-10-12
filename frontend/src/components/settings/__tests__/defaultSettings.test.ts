import { describe, it, expect } from 'vitest';
import { DEFAULT_SETTINGS } from '../types';

describe('DEFAULT_SETTINGS stack guardrails', () => {
  it('keeps one rollback generation and blocks deploys on missing required env vars', () => {
    expect(DEFAULT_SETTINGS.recovery_max_generations).toBe('1');
    expect(DEFAULT_SETTINGS.env_block_deploy_on_missing_required).toBe('1');
  });
});
