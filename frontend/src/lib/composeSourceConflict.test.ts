import { describe, expect, it } from 'vitest';
import { COMPOSE_SOURCE_CHANGED_PROMPT, confirmComposeSourceReload } from './composeSourceConflict';

describe('confirmComposeSourceReload', () => {
  it('keeps the draft unless the operator discards it', () => {
    const prompts: string[] = [];
    expect(confirmComposeSourceReload(message => {
      prompts.push(message);
      return false;
    })).toBe(false);
    expect(confirmComposeSourceReload(() => true)).toBe(true);
    expect(prompts).toEqual([COMPOSE_SOURCE_CHANGED_PROMPT]);
  });
});
