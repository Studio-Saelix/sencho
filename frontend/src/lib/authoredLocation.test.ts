import { describe, expect, it, vi } from 'vitest';

import {
  isUsableAuthoredLocation, normalizeStackPath, planAuthoredLocation, revealLocation,
} from './authoredLocation';

const location = { file: 'compose.override.yaml', line: 14, column: 3, endLine: 14, endColumn: 9 };

describe('planAuthoredLocation', () => {
  it('opens the compose editor when the file is the loaded primary file', () => {
    expect(planAuthoredLocation({ ...location, file: 'compose.yaml' }, 'compose.yaml')).toEqual({
      surface: 'compose', file: 'compose.yaml',
    });
  });

  it('opens the Files tab for any other file', () => {
    expect(planAuthoredLocation(location, 'compose.yaml')).toEqual({
      surface: 'files', file: 'compose.override.yaml',
    });
  });

  it('normalizes relative spellings before comparing', () => {
    expect(planAuthoredLocation({ ...location, file: './compose.yaml' }, './compose.yaml')).toEqual({
      surface: 'compose', file: 'compose.yaml',
    });
    expect(planAuthoredLocation({ ...location, file: 'sub\\compose.yaml' }, 'compose.yaml')?.file).toBe('sub/compose.yaml');
  });

  it('rejects a location with no file or an invalid range', () => {
    expect(planAuthoredLocation({ ...location, file: '' }, 'compose.yaml')).toBeNull();
    expect(planAuthoredLocation({ ...location, line: 0 }, 'compose.yaml')).toBeNull();
    expect(planAuthoredLocation({ ...location, endLine: 13 }, 'compose.yaml')).toBeNull();
    expect(planAuthoredLocation({ ...location, file: '../outside.yaml' }, 'compose.yaml')).toBeNull();
    expect(planAuthoredLocation(null, 'compose.yaml')).toBeNull();
  });
});

describe('normalizeStackPath', () => {
  it('rejects absolute and escaping paths', () => {
    expect(normalizeStackPath('/etc/passwd')).toBeNull();
    expect(normalizeStackPath('C:\\secrets')).toBeNull();
    expect(normalizeStackPath('a/../b')).toBeNull();
    expect(normalizeStackPath('a/b')).toBe('a/b');
  });
});

describe('revealLocation', () => {
  it('reveals, selects, and focuses once', () => {
    const editor = { revealRangeInCenter: vi.fn(), setSelection: vi.fn(), focus: vi.fn() };
    revealLocation(editor, location);
    expect(editor.revealRangeInCenter).toHaveBeenCalledWith({
      startLineNumber: 14, startColumn: 3, endLineNumber: 14, endColumn: 9,
    });
    expect(editor.setSelection).toHaveBeenCalledTimes(1);
    expect(editor.focus).toHaveBeenCalledTimes(1);
  });
});

describe('isUsableAuthoredLocation', () => {
  it('accepts a complete range and rejects a missing column', () => {
    expect(isUsableAuthoredLocation(location)).toBe(true);
    expect(isUsableAuthoredLocation({ ...location, column: undefined })).toBe(false);
  });

  it('validates a revision digest when one is present', () => {
    expect(isUsableAuthoredLocation({ ...location, fileHash: 'a'.repeat(64) })).toBe(true);
    expect(isUsableAuthoredLocation({ ...location, fileHash: 'abc' })).toBe(false);
    expect(isUsableAuthoredLocation({ ...location, fileHash: 'A'.repeat(64) })).toBe(false);
  });
});
