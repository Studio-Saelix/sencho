import { describe, expect, it } from 'vitest';
import { redactSensitiveText } from '../utils/safeLog';

describe('redactSensitiveText', () => {
  it('redacts credentials from durable log text', () => {
    const text = redactSensitiveText(
      'connect https://user:pass@example.invalid failed Authorization: Bearer abc.def.ghi token=secret123 password=hunter2',
    );

    expect(text).toContain('https://[redacted]@example.invalid');
    expect(text).toContain('Authorization: [redacted]');
    expect(text).toContain('token=[redacted]');
    expect(text).toContain('password=[redacted]');
    expect(text).not.toContain('user:pass');
    expect(text).not.toContain('abc.def.ghi');
    expect(text).not.toContain('secret123');
    expect(text).not.toContain('hunter2');
  });
});
