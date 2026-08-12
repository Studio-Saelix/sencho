import type { Duplex } from 'stream';

/**
 * Write an HTTP status line and destroy the socket. Used by every WebSocket
 * handler to reject an upgrade before a successful handshake. Errors during
 * write/destroy are intentionally swallowed: the socket is already being
 * torn down and nothing downstream can recover.
 *
 * Optional `headers` are written before the terminating blank line. When
 * omitted, the response is exactly `HTTP/1.1 ${status} ${message}\r\n\r\n`
 * so non-Pilot callers stay byte-identical to the historical shape.
 */
export function rejectUpgrade(
  socket: Duplex,
  status: number,
  message: string,
  headers?: Record<string, string>,
): void {
  try {
    const extra = headers
      ? Object.entries(headers).map(([name, value]) => `${name}: ${value}\r\n`).join('')
      : '';
    socket.write(`HTTP/1.1 ${status} ${message}\r\n${extra}\r\n`);
  } catch { /* ignore */ }
  try { socket.destroy(); } catch { /* ignore */ }
}
