/**
 * Per-agent notification payload template validation and rendering.
 */
import { describe, it, expect } from 'vitest';
import {
  PAYLOAD_TEMPLATE_MAX_LENGTH,
  assertPayloadTemplateAllowedForChannel,
  renderPayloadTemplate,
  templateTopLevelKeys,
  validatePayloadTemplate,
} from '../helpers/notificationPayloadTemplate';

describe('validatePayloadTemplate', () => {
  it('accepts undefined, null, and blank as null (built-in payload)', () => {
    expect(validatePayloadTemplate(undefined)).toEqual({ ok: true, value: null });
    expect(validatePayloadTemplate(null)).toEqual({ ok: true, value: null });
    expect(validatePayloadTemplate('')).toEqual({ ok: true, value: null });
    expect(validatePayloadTemplate('   \n  ')).toEqual({ ok: true, value: null });
  });

  it('rejects non-string values', () => {
    expect(validatePayloadTemplate(42)).toEqual({ ok: false, error: 'must be a string' });
    expect(validatePayloadTemplate({ a: 1 })).toEqual({ ok: false, error: 'must be a string' });
  });

  it('accepts valid templates and returns the trimmed value', () => {
    expect(validatePayloadTemplate('{"level": "{{level}}"}')).toEqual({
      ok: true,
      value: '{"level": "{{level}}"}',
    });
    expect(validatePayloadTemplate('"{{message}}"')).toEqual({ ok: true, value: '"{{message}}"' });
  });

  it('accepts nested JSON, quoted keys, arrays, and variables mixed into strings', () => {
    expect(validatePayloadTemplate('{"a": {"b": "{{level}}"}}').ok).toBe(true);
    expect(validatePayloadTemplate('{"{{level}}": 1}').ok).toBe(true);
    expect(validatePayloadTemplate('["{{message}}"]').ok).toBe(true);
    expect(validatePayloadTemplate('{"a": "pre {{level}} post"}').ok).toBe(true);
    expect(validatePayloadTemplate('{"a": "{{level}} and {{message}}"}').ok).toBe(true);
    expect(validatePayloadTemplate('{"a": "{{level}}!"}').ok).toBe(true);
    expect(validatePayloadTemplate('{"empty": {}}').ok).toBe(true);
  });

  it('rejects unterminated or stray open variable tokens', () => {
    const unclosed = validatePayloadTemplate('{"a": "{{message}"}');
    expect(unclosed.ok).toBe(false);
    if (!unclosed.ok) expect(unclosed.error).toContain('complete {{name}} token');

    const strayOpen = validatePayloadTemplate('{"a": "{{"}');
    expect(strayOpen.ok).toBe(false);
  });

  it('rejects a bare variable in a non-string value position', () => {
    const result = validatePayloadTemplate('{"a": {{level}}}');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('valid JSON');
  });

  it('rejects unknown variables and names all of them', () => {
    const result = validatePayloadTemplate('{"a": "{{foo}}"}');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('{{foo}}');
      expect(result.error).toContain('Allowed variables: level, message, category, timestamp, stack_name, actor');
    }

    const multi = validatePayloadTemplate('{"a": "{{foo}}", "b": "{{bar}}"}');
    expect(multi.ok).toBe(false);
    if (!multi.ok) {
      expect(multi.error).toContain('{{foo}}');
      expect(multi.error).toContain('{{bar}}');
    }
  });

  it('rejects malformed JSON', () => {
    const result = validatePayloadTemplate('{');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('valid JSON');
  });

  it('enforces the length cap after trimming, before substitution', () => {
    // '{"msg":"' is 8 chars and '"}' is 2, so the payload is 10 + repeats.
    const atLimit = `{"msg":"${'x'.repeat(PAYLOAD_TEMPLATE_MAX_LENGTH - 10)}"}`;
    expect(atLimit.length).toBe(PAYLOAD_TEMPLATE_MAX_LENGTH);
    expect(validatePayloadTemplate(atLimit).ok).toBe(true);

    const over = `{"msg":"${'x'.repeat(PAYLOAD_TEMPLATE_MAX_LENGTH - 9)}"}`;
    expect(over.length).toBe(PAYLOAD_TEMPLATE_MAX_LENGTH + 1);
    const result = validatePayloadTemplate(over);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain(`${PAYLOAD_TEMPLATE_MAX_LENGTH} characters or fewer`);
  });
});

describe('templateTopLevelKeys', () => {
  it('returns the top-level keys of the placeholder-substituted object', () => {
    expect(templateTopLevelKeys('{"a": 1, "b": "{{level}}"}')).toEqual(['a', 'b']);
  });

  it('returns an empty array for non-object or unparseable documents', () => {
    expect(templateTopLevelKeys('"{{message}}"')).toEqual([]);
    expect(templateTopLevelKeys('[1, 2]')).toEqual([]);
    expect(templateTopLevelKeys('{')).toEqual([]);
    expect(templateTopLevelKeys('{}')).toEqual([]);
  });
});

describe('assertPayloadTemplateAllowedForChannel', () => {
  it('allows any template on non-Apprise channels', () => {
    expect(assertPayloadTemplateAllowedForChannel('{{message}}', 'discord')).toBeNull();
    expect(assertPayloadTemplateAllowedForChannel('{"urls": "x"}', 'webhook')).toBeNull();
  });

  it('rejects Apprise templates carrying urls or tag', () => {
    const urls = assertPayloadTemplateAllowedForChannel('{"urls": "discord://x"}', 'apprise');
    expect(urls).toContain('urls');
    const tag = assertPayloadTemplateAllowedForChannel('{"tag": "ops"}', 'apprise');
    expect(tag).toContain('tag');
  });

  it('requires Apprise templates to render a non-empty JSON object', () => {
    expect(assertPayloadTemplateAllowedForChannel('{{message}}', 'apprise')).toContain('render a JSON object');
    expect(assertPayloadTemplateAllowedForChannel('"{{message}}"', 'apprise')).toContain('render a JSON object');
    expect(assertPayloadTemplateAllowedForChannel('{}', 'apprise')).toContain('render a JSON object');
    expect(assertPayloadTemplateAllowedForChannel('{"title": "{{level}}"}', 'apprise')).toBeNull();
  });
});

describe('renderPayloadTemplate', () => {
  it('JSON-escapes values so quotes, newlines, and backslashes survive', () => {
    const message = 'say "hi"\nline\\two';
    const rendered = renderPayloadTemplate('{"message": "{{message}}"}', { message }) as {
      message: string;
    };
    expect(rendered.message).toBe(message);
  });

  it('substitutes missing context with an empty string', () => {
    expect(renderPayloadTemplate('{"message": "{{message}}"}', {})).toEqual({ message: '' });
  });

  it('supports quoted keys, arrays, and variables mixed into strings', () => {
    expect(renderPayloadTemplate('{"{{level}}": 1}', { level: 'info' })).toEqual({ info: 1 });
    expect(renderPayloadTemplate('["{{level}}"]', { level: 'info' })).toEqual(['info']);
    expect(renderPayloadTemplate('{"a": "x {{level}} y"}', { level: 'info' })).toEqual({ a: 'x info y' });
  });

  it('JSON-escapes values substituted inside a string', () => {
    const message = 'say "hi"\nline\\two';
    const rendered = renderPayloadTemplate('{"a": "x {{message}} y"}', { message }) as { a: string };
    expect(rendered.a).toBe(`x ${message} y`);
  });

  it('does not re-substitute braces inside substituted values', () => {
    const rendered = renderPayloadTemplate('{"message": "{{message}}"}', {
      message: 'contains {{level}} literal',
    }) as { message: string };
    expect(rendered.message).toBe('contains {{level}} literal');
  });

  it('throws on a template that fails to parse after substitution', () => {
    expect(() => renderPayloadTemplate('{"a":', {})).toThrow('Templated payload rendered invalid JSON');
  });
});
