/**
 * Tests for the pilot tunnel wire protocol.
 */
import { describe, it, expect } from 'vitest';
import {
    BinaryFrameType,
    PROTOCOL_VERSION,
    StreamIdAllocator,
    decodeBinaryFrame,
    decodeJsonFrame,
    encodeBinaryFrame,
    encodeJsonFrame,
} from '../pilot/protocol';

describe('JSON frame roundtrip', () => {
    it('roundtrips a hello frame', () => {
        const frame = encodeJsonFrame({ t: 'hello', version: PROTOCOL_VERSION, role: 'agent', agentVersion: '0.1.0' });
        const decoded = decodeJsonFrame(frame);
        expect(decoded).toEqual({ t: 'hello', version: PROTOCOL_VERSION, role: 'agent', agentVersion: '0.1.0' });
    });

    it('roundtrips an http_req frame', () => {
        const raw = encodeJsonFrame({
            t: 'http_req',
            s: 7,
            method: 'POST',
            path: '/api/stacks',
            headers: { 'content-type': 'application/json', 'x-sencho-tier': 'paid' },
        });
        const decoded = decodeJsonFrame(raw);
        expect(decoded.t).toBe('http_req');
        if (decoded.t !== 'http_req') throw new Error('narrowing');
        expect(decoded.s).toBe(7);
        expect(decoded.method).toBe('POST');
        expect(decoded.headers['x-sencho-tier']).toBe('paid');
    });

    it('roundtrips ws lifecycle frames', () => {
        const open = decodeJsonFrame(encodeJsonFrame({ t: 'ws_open', s: 3, path: '/ws', headers: {} }));
        expect(open.t).toBe('ws_open');
        const accept = decodeJsonFrame(encodeJsonFrame({ t: 'ws_accept', s: 3, headers: {} }));
        expect(accept.t).toBe('ws_accept');
        const close = decodeJsonFrame(encodeJsonFrame({ t: 'ws_close', s: 3, code: 1000, reason: 'done' }));
        expect(close.t).toBe('ws_close');
    });

    it('roundtrips an http_cancel frame', () => {
        const decoded = decodeJsonFrame(encodeJsonFrame({ t: 'http_cancel', s: 12 }));
        expect(decoded).toEqual({ t: 'http_cancel', s: 12 });
    });

    it('rejects malformed JSON', () => {
        expect(() => decodeJsonFrame('not json')).toThrow();
    });

    it('rejects missing type discriminator', () => {
        expect(() => decodeJsonFrame('{"foo":1}')).toThrow(/type discriminator/);
    });
});

describe('Binary frame roundtrip', () => {
    it('roundtrips an http request body chunk', () => {
        const payload = Buffer.from('hello world');
        const encoded = encodeBinaryFrame(BinaryFrameType.HttpReqBody, 42, payload);
        const decoded = decodeBinaryFrame(encoded);
        expect(decoded.type).toBe(BinaryFrameType.HttpReqBody);
        expect(decoded.streamId).toBe(42);
        expect(decoded.payload.equals(payload)).toBe(true);
    });

    it('roundtrips a ws binary message', () => {
        const payload = Buffer.from([0xde, 0xad, 0xbe, 0xef]);
        const encoded = encodeBinaryFrame(BinaryFrameType.WsMessageBinary, 1, payload);
        const decoded = decodeBinaryFrame(encoded);
        expect(decoded.type).toBe(BinaryFrameType.WsMessageBinary);
        expect(decoded.streamId).toBe(1);
        expect(decoded.payload.equals(payload)).toBe(true);
    });

    it('roundtrips an empty payload', () => {
        const encoded = encodeBinaryFrame(BinaryFrameType.HttpResBody, 99, Buffer.alloc(0));
        const decoded = decodeBinaryFrame(encoded);
        expect(decoded.payload.length).toBe(0);
        expect(decoded.streamId).toBe(99);
    });

    it('handles max streamId', () => {
        const encoded = encodeBinaryFrame(BinaryFrameType.HttpReqBody, 0xffffffff, Buffer.from([0]));
        const decoded = decodeBinaryFrame(encoded);
        expect(decoded.streamId).toBe(0xffffffff);
    });

    it('rejects negative streamId', () => {
        expect(() => encodeBinaryFrame(BinaryFrameType.HttpReqBody, -1, Buffer.alloc(0))).toThrow(/streamId/);
    });

    it('rejects streamId above uint32 max', () => {
        expect(() => encodeBinaryFrame(BinaryFrameType.HttpReqBody, 0x100000000, Buffer.alloc(0))).toThrow(/streamId/);
    });

    it('rejects frames shorter than the 5-byte header', () => {
        expect(() => decodeBinaryFrame(Buffer.from([0x01, 0x00]))).toThrow(/too short/);
    });

    it('rejects unknown binary frame types', () => {
        const buf = Buffer.alloc(5);
        buf.writeUInt8(0x99, 0);
        expect(() => decodeBinaryFrame(buf)).toThrow(/unknown binary frame type/);
    });
});

describe('StreamIdAllocator', () => {
    it('allocates monotonically starting at 1', () => {
        const alloc = new StreamIdAllocator();
        expect(alloc.allocate()).toBe(1);
        expect(alloc.allocate()).toBe(2);
        expect(alloc.allocate()).toBe(3);
    });

    it('wraps before overflowing int32', () => {
        const alloc = new StreamIdAllocator();
        (alloc as unknown as { next: number }).next = 0x7fffffff;
        expect(alloc.allocate()).toBe(0x7fffffff);
        expect(alloc.allocate()).toBe(1);
    });
});
