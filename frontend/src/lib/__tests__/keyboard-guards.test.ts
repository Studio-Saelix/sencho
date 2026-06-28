/**
 * Unit tests for isInputFocused, the shared guard both global hotkey systems
 * use to bail when the user is typing in a field.
 *
 * Regression guard for #1410: Monaco's Chromium EditContext input surface is a
 * plain focusable <div class="native-edit-context"> inside .monaco-editor, not a
 * <textarea> or contentEditable element, so the tag/contentEditable checks miss
 * it and single-key hotkeys (a/h/u/p/b) fired while editing a compose file in
 * Chrome (Safari falls back to a hidden <textarea> and was unaffected).
 *
 * activeElement is stubbed with real DOM nodes so tagName, isContentEditable, and
 * closest() all run their real logic, while staying free of jsdom's unreliable
 * .focus() / isContentEditable handling on detached elements.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { isInputFocused } from '../keyboard-guards';

function stubActiveElement(el: Element | null): void {
  Object.defineProperty(document, 'activeElement', { configurable: true, get: () => el });
}

afterEach(() => {
  // Drop the own-property shadow so jsdom's native activeElement getter returns.
  Reflect.deleteProperty(document, 'activeElement');
});

describe('isInputFocused', () => {
  it('returns false when nothing is focused', () => {
    stubActiveElement(null);
    expect(isInputFocused()).toBe(false);
  });

  it('returns true for a focused <input>', () => {
    stubActiveElement(document.createElement('input'));
    expect(isInputFocused()).toBe(true);
  });

  it('returns true for a focused <textarea>', () => {
    stubActiveElement(document.createElement('textarea'));
    expect(isInputFocused()).toBe(true);
  });

  it('returns true for a contentEditable element', () => {
    const div = document.createElement('div');
    Object.defineProperty(div, 'isContentEditable', { value: true });
    stubActiveElement(div);
    expect(isInputFocused()).toBe(true);
  });

  it('returns false for a focused non-editable element', () => {
    stubActiveElement(document.createElement('button'));
    expect(isInputFocused()).toBe(false);
  });

  it('returns true for focus inside the Monaco editor container (#1410)', () => {
    const editor = document.createElement('div');
    editor.className = 'monaco-editor';
    const editContext = document.createElement('div');
    editContext.className = 'native-edit-context';
    editor.appendChild(editContext);
    document.body.appendChild(editor);
    stubActiveElement(editContext);
    try {
      expect(isInputFocused()).toBe(true);
    } finally {
      document.body.removeChild(editor);
    }
  });

  it('returns true for any descendant of the Monaco editor, not just the edit-context node', () => {
    // Pins the deliberate whole-container semantics: focus anywhere inside
    // .monaco-editor counts, so narrowing the guard to a specific inner class
    // would regress.
    const editor = document.createElement('div');
    editor.className = 'monaco-editor';
    const viewLine = document.createElement('div');
    viewLine.className = 'view-line';
    editor.appendChild(viewLine);
    document.body.appendChild(editor);
    stubActiveElement(viewLine);
    try {
      expect(isInputFocused()).toBe(true);
    } finally {
      document.body.removeChild(editor);
    }
  });
});
