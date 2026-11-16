import { afterEach, describe, expect, it, vi } from 'vitest';
import { announceNotificationsConnection, onNotificationsReturn } from './notificationsConnection';

afterEach(() => {
  // The last announced state is module-wide; leave it up for the next test.
  announceNotificationsConnection(true);
});

describe('onNotificationsReturn', () => {
  it('does not run for a connection that never dropped', () => {
    const onReturn = vi.fn();
    const stop = onNotificationsReturn(onReturn);
    announceNotificationsConnection(true);
    announceNotificationsConnection(true);
    expect(onReturn).not.toHaveBeenCalled();
    stop();
  });

  it('runs once when the socket returns from a drop it watched begin', () => {
    const onReturn = vi.fn();
    const stop = onNotificationsReturn(onReturn);
    announceNotificationsConnection(false);
    expect(onReturn).not.toHaveBeenCalled();
    announceNotificationsConnection(true);
    announceNotificationsConnection(true);
    expect(onReturn).toHaveBeenCalledTimes(1);
    stop();
  });

  it('runs when the socket returns from a drop that began before it subscribed', () => {
    announceNotificationsConnection(false);
    const onReturn = vi.fn();
    const stop = onNotificationsReturn(onReturn);
    announceNotificationsConnection(true);
    expect(onReturn).toHaveBeenCalledTimes(1);
    stop();
  });

  it('starts from "never dropped" before any state was announced or after the socket came back', () => {
    announceNotificationsConnection(false);
    announceNotificationsConnection(true);
    const onReturn = vi.fn();
    const stop = onNotificationsReturn(onReturn);
    announceNotificationsConnection(true);
    expect(onReturn).not.toHaveBeenCalled();
    stop();
  });

  it('stops running after it is unsubscribed', () => {
    const onReturn = vi.fn();
    onNotificationsReturn(onReturn)();
    announceNotificationsConnection(false);
    announceNotificationsConnection(true);
    expect(onReturn).not.toHaveBeenCalled();
  });
});
