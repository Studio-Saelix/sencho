import { describe, it, expect, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import WebSocket, { type WebSocketServer } from 'ws';
import { attachGenericConnectionHandlers, getTerminalWs } from '../websocket/generic';

class FakeWs extends EventEmitter {
  readyState: number = WebSocket.OPEN;
}

/** Simulate a client opening the generic /ws socket and registering for deploy
 *  output via the connectTerminal handshake. */
function connect(wss: EventEmitter, sessionId?: string): FakeWs {
  const ws = new FakeWs();
  wss.emit('connection', ws);
  ws.emit('message', Buffer.from(JSON.stringify({ action: 'connectTerminal', ...(sessionId ? { sessionId } : {}) })));
  return ws;
}

describe('generic ws terminal registry', () => {
  let wss: EventEmitter;
  beforeEach(() => {
    wss = new EventEmitter();
    attachGenericConnectionHandlers(wss as unknown as WebSocketServer);
  });

  it('routes output to the socket matching the deploy session id', () => {
    const a = connect(wss, 'sess-a');
    const b = connect(wss, 'sess-b');
    expect(getTerminalWs('sess-a')).toBe(a);
    expect(getTerminalWs('sess-b')).toBe(b);
    expect(getTerminalWs('not-a-session')).toBeUndefined();
  });

  it('falls back to the most recent id-less socket', () => {
    const a = connect(wss);
    expect(getTerminalWs()).toBe(a);
    const b = connect(wss);
    expect(getTerminalWs()).toBe(b);
  });

  it('drops a session from the registry when its socket closes', () => {
    const a = connect(wss, 'sess-x');
    expect(getTerminalWs('sess-x')).toBe(a);
    a.emit('close');
    expect(getTerminalWs('sess-x')).toBeUndefined();
  });

  it('ignores a registered socket that is no longer open', () => {
    const a = connect(wss, 'sess-y');
    a.readyState = WebSocket.CLOSED;
    expect(getTerminalWs('sess-y')).toBeUndefined();
  });

  it('rebinds a socket to a new session id and drops the old mapping', () => {
    const a = connect(wss, 'sess-1');
    // Same socket re-registers under a new id (a second deploy in the same tab).
    a.emit('message', Buffer.from(JSON.stringify({ action: 'connectTerminal', sessionId: 'sess-2' })));
    expect(getTerminalWs('sess-1')).toBeUndefined();
    expect(getTerminalWs('sess-2')).toBe(a);
  });

  it('clears the id-less fallback when its socket closes', () => {
    const a = connect(wss);
    expect(getTerminalWs()).toBe(a);
    a.emit('close');
    expect(getTerminalWs()).toBeUndefined();
  });

  it('does not expose a keyed socket as the id-less fallback', () => {
    // A headerless operation (bulk / rollback / legacy) resolves via getTerminalWs()
    // with no id; it must never reach a keyed deploy modal's socket.
    const a = connect(wss, 'sess-keyed');
    expect(getTerminalWs('sess-keyed')).toBe(a);
    expect(getTerminalWs()).toBeUndefined();
  });

  it('drops the id-less fallback when that socket later adopts a session id', () => {
    const a = connect(wss);
    expect(getTerminalWs()).toBe(a);
    a.emit('message', Buffer.from(JSON.stringify({ action: 'connectTerminal', sessionId: 'sess-late' })));
    expect(getTerminalWs()).toBeUndefined();
    expect(getTerminalWs('sess-late')).toBe(a);
  });
});
