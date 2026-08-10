/**
 * Byte-level contract for rejectUpgrade: omitted headers stay historically
 * identical; optional headers are written before the terminating blank line.
 */
import { describe, it, expect, vi } from 'vitest';
import type { Duplex } from 'stream';
import { rejectUpgrade } from '../websocket/reject';

function captureWrite(): { socket: Duplex; chunks: string[] } {
  const chunks: string[] = [];
  const socket = {
    write: vi.fn((data: string | Buffer) => {
      chunks.push(typeof data === 'string' ? data : data.toString('utf8'));
      return true;
    }),
    destroy: vi.fn(),
  } as unknown as Duplex;
  return { socket, chunks };
}

describe('rejectUpgrade', () => {
  it('emits the historical byte sequence when headers are omitted', () => {
    const { socket, chunks } = captureWrite();
    rejectUpgrade(socket, 401, 'Unauthorized');
    expect(chunks.join('')).toBe('HTTP/1.1 401 Unauthorized\r\n\r\n');
    expect(socket.destroy).toHaveBeenCalledOnce();
  });

  it('writes optional headers before the terminating blank line', () => {
    const { socket, chunks } = captureWrite();
    rejectUpgrade(socket, 401, 'Unauthorized', {
      'X-Sencho-Pilot-Reject': 'invalid_token',
      Connection: 'close',
    });
    const body = chunks.join('');
    expect(body.startsWith('HTTP/1.1 401 Unauthorized\r\n')).toBe(true);
    expect(body).toContain('X-Sencho-Pilot-Reject: invalid_token\r\n');
    expect(body).toContain('Connection: close\r\n');
    expect(body.endsWith('\r\n\r\n')).toBe(true);
    const blankIndex = body.lastIndexOf('\r\n\r\n');
    const headerBlock = body.slice(0, blankIndex);
    expect(headerBlock).toContain('X-Sencho-Pilot-Reject: invalid_token');
    expect(headerBlock).toContain('Connection: close');
    expect(socket.destroy).toHaveBeenCalledOnce();
  });
});
