/**
 * Tests for the Sencho Mesh TCP frames added to the pilot tunnel protocol.
 */
import { describe, it, expect } from 'vitest';
import {
    AGENT_REVERSE_ID_BASE,
    BinaryFrameType,
    decodeBinaryFrame,
    decodeJsonFrame,
    encodeBinaryFrame,
    encodeJsonFrame,
} from '../pilot/protocol';

describe('Mesh TCP JSON frames', () => {
    it('roundtrips a tcp_open frame', () => {
        const raw = encodeJsonFrame({
            t: 'tcp_open',
            s: 42,
            stack: 'api',
            service: 'db',
            port: 5432,
        });
        const decoded = decodeJsonFrame(raw);
        expect(decoded.t).toBe('tcp_open');
        if (decoded.t !== 'tcp_open') throw new Error('narrowing');
        expect(decoded.s).toBe(42);
        expect(decoded.stack).toBe('api');
        expect(decoded.service).toBe('db');
        expect(decoded.port).toBe(5432);
    });

    it('roundtrips a tcp_open_ack success', () => {
        const raw = encodeJsonFrame({ t: 'tcp_open_ack', s: 42, ok: true });
        const decoded = decodeJsonFrame(raw);
        expect(decoded.t).toBe('tcp_open_ack');
        if (decoded.t !== 'tcp_open_ack') throw new Error('narrowing');
        expect(decoded.ok).toBe(true);
        expect(decoded.err).toBeUndefined();
    });

    it('roundtrips a tcp_open_ack failure with error code', () => {
        const raw = encodeJsonFrame({
            t: 'tcp_open_ack',
            s: 42,
            ok: false,
            err: 'unreachable',
        });
        const decoded = decodeJsonFrame(raw);
        if (decoded.t !== 'tcp_open_ack') throw new Error('narrowing');
        expect(decoded.ok).toBe(false);
        expect(decoded.err).toBe('unreachable');
    });

    it('roundtrips a tcp_close frame', () => {
        const raw = encodeJsonFrame({ t: 'tcp_close', s: 42 });
        const decoded = decodeJsonFrame(raw);
        expect(decoded.t).toBe('tcp_close');
        if (decoded.t !== 'tcp_close') throw new Error('narrowing');
        expect(decoded.s).toBe(42);
    });
});

describe('Mesh TcpData binary frames', () => {
    it('encodes the 0x04 type discriminator', () => {
        const payload = Buffer.from('hello');
        const encoded = encodeBinaryFrame(BinaryFrameType.TcpData, 1, payload);
        expect(encoded[0]).toBe(0x04);
    });

    it('roundtrips streamId + payload', () => {
        const payload = Buffer.from('SELECT 1;');
        const encoded = encodeBinaryFrame(BinaryFrameType.TcpData, 0xdeadbeef, payload);
        const decoded = decodeBinaryFrame(encoded);
        expect(decoded.type).toBe(BinaryFrameType.TcpData);
        expect(decoded.streamId).toBe(0xdeadbeef);
        expect(decoded.payload.toString()).toBe('SELECT 1;');
    });

    it('roundtrips an empty payload', () => {
        const encoded = encodeBinaryFrame(BinaryFrameType.TcpData, 7, Buffer.alloc(0));
        const decoded = decodeBinaryFrame(encoded);
        expect(decoded.type).toBe(BinaryFrameType.TcpData);
        expect(decoded.streamId).toBe(7);
        expect(decoded.payload.length).toBe(0);
    });

    it('preserves binary payloads byte-for-byte', () => {
        const payload = Buffer.from([0x00, 0xff, 0x01, 0x80, 0x7f, 0x10]);
        const encoded = encodeBinaryFrame(BinaryFrameType.TcpData, 1, payload);
        const decoded = decodeBinaryFrame(encoded);
        expect(decoded.payload.equals(payload)).toBe(true);
    });

    it('rejects an unknown binary frame type', () => {
        const buf = Buffer.alloc(5);
        buf.writeUInt8(0x99, 0);
        buf.writeUInt32BE(1, 1);
        expect(() => decodeBinaryFrame(buf)).toThrow(/unknown binary frame type/);
    });

    it('continues to accept the existing http and ws binary types', () => {
        for (const t of [BinaryFrameType.HttpReqBody, BinaryFrameType.HttpResBody, BinaryFrameType.WsMessageBinary]) {
            const buf = encodeBinaryFrame(t, 1, Buffer.from('x'));
            expect(() => decodeBinaryFrame(buf)).not.toThrow();
        }
    });
});

describe('Phase B: tcp_open_reverse', () => {
    it('roundtrips a tcp_open_reverse frame including targetNodeId', () => {
        const raw = encodeJsonFrame({
            t: 'tcp_open_reverse',
            s: AGENT_REVERSE_ID_BASE + 7,
            targetNodeId: 12,
            stack: 'api',
            service: 'db',
            port: 5432,
        });
        const decoded = decodeJsonFrame(raw);
        expect(decoded.t).toBe('tcp_open_reverse');
        if (decoded.t !== 'tcp_open_reverse') throw new Error('narrowing');
        expect(decoded.s).toBe(AGENT_REVERSE_ID_BASE + 7);
        expect(decoded.targetNodeId).toBe(12);
        expect(decoded.stack).toBe('api');
        expect(decoded.service).toBe('db');
        expect(decoded.port).toBe(5432);
    });

    it('AGENT_REVERSE_ID_BASE is in the upper half of the 32-bit space and clears primary allocator collision risk', () => {
        // Primary allocator wraps at 0x7fffffff. Agent base must be above
        // that range so primary's id sequence (1..0x7fffffff) and the
        // agent's reverse sequence never collide on the same tunnel for
        // the lifetime of the tunnel (well beyond MAX_STREAMS_PER_TUNNEL).
        expect(AGENT_REVERSE_ID_BASE).toBeGreaterThan(0x40000000);
        expect(AGENT_REVERSE_ID_BASE).toBeLessThan(0x80000000);
    });
});
