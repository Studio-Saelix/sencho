import { describe, expect, it } from 'vitest';

import { decodeUtf8PreservingBom, sha256Hex } from './sha256';

const EMPTY = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const ABC = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';

describe('decodeUtf8PreservingBom', () => {
  it('keeps a leading BOM that Response.text() would drop', () => {
    const text = '\uFEFFservices:\n  web:\n    image: nginx:alpine\n';
    const bytes = new TextEncoder().encode(text).buffer;
    expect(decodeUtf8PreservingBom(bytes)).toBe(text);
    expect(sha256Hex(decodeUtf8PreservingBom(bytes))).toBe(sha256Hex(text));
  });

  it('replaces malformed bytes the way the server decoder does', () => {
    // Node's `Buffer.toString('utf-8')` yields U+FFFD per malformed sequence;
    // the client must decode the same way or its digest diverges on such files.
    const malformed = new Uint8Array([0x61, 0xff, 0x62, 0xe2, 0x28, 0xa1]).buffer;
    expect(decodeUtf8PreservingBom(malformed)).toBe('a\uFFFDb\uFFFD(\uFFFD');
  });
});

describe('sha256Hex', () => {
  it('matches the published vectors for empty and short input', () => {
    expect(sha256Hex('')).toBe(EMPTY);
    expect(sha256Hex('abc')).toBe(ABC);
  });

  it('hashes the UTF-8 form of the text', () => {
    expect(sha256Hex('é')).toBe('4a99557e4033c3539de2eb65472017cad5f9557f7a0625a09f1c3f6e2ba69c4c');
  });

  it('processes more than one block', () => {
    expect(sha256Hex('a'.repeat(1000))).toBe(
      '41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3',
    );
  });
});
