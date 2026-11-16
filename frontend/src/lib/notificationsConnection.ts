/**
 * The hub notification socket's state, for views that must read again after an outage.
 *
 * `useNotifications` announces each open and close of the socket with a `sencho:notifications-connection` event, but an
 * event says nothing to a view that subscribes later. A view that learned of the outage only by watching for the close
 * would miss one already under way when it mounted (a dialog opened while the socket is backing off), and so would miss
 * the announcements the hub sent into the dead socket. The last announced state is kept here so a late subscriber
 * starts from it instead of from "never dropped".
 */

export const NOTIFICATIONS_CONNECTION_EVENT = 'sencho:notifications-connection';

/** The last announced state. `null` until the socket first opens or closes, and an open with no earlier close is not a return. */
let lastAnnounced: boolean | null = null;

/** Record the socket's new state and announce it. The notification socket's owner calls this. */
export function announceNotificationsConnection(connected: boolean): void {
  lastAnnounced = connected;
  window.dispatchEvent(new CustomEvent(NOTIFICATIONS_CONNECTION_EVENT, { detail: { connected } }));
}

/**
 * Run `onReturn` each time the socket comes back after a period in which it was down, including a period that began
 * before this call. A connection with no earlier drop, such as the first open, does not run it. Returns the unsubscribe.
 */
export function onNotificationsReturn(onReturn: () => void): () => void {
  let wasDown = lastAnnounced === false;
  const onConnection = (event: Event) => {
    const connected = (event as CustomEvent<{ connected?: unknown }>).detail?.connected;
    if (connected === false) {
      wasDown = true;
    } else if (connected === true && wasDown) {
      wasDown = false;
      onReturn();
    }
  };
  window.addEventListener(NOTIFICATIONS_CONNECTION_EVENT, onConnection);
  return () => window.removeEventListener(NOTIFICATIONS_CONNECTION_EVENT, onConnection);
}
