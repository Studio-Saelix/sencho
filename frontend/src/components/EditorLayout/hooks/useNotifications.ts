import { useEffect, useRef, useState } from 'react';
import { apiFetch, fetchForNode } from '@/lib/api';
import { beginSpan, endSpan, markMilestone } from '@/lib/hydrationTiming';
import { toast } from '@/components/ui/toast-store';
import type { Node } from '@/context/NodeContext';
import type { NotificationItem } from '../../dashboard/types';

interface UseNotificationsOptions {
  nodes: Node[];
  onStateInvalidate: () => void;
  onImageUpdatesChange: () => void;
}

export function useNotifications({ nodes, onStateInvalidate, onImageUpdatesChange }: UseNotificationsOptions) {
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const [tickerConnected, setTickerConnected] = useState(false);

  // Stable refs so long-lived WS callbacks always read the latest values
  // without needing them in the zero-dep effect dependency arrays.
  const nodesRef = useRef<Node[]>([]);
  nodesRef.current = nodes;
  const remoteNotifWsRef = useRef<Map<number, () => void>>(new Map());
  const onStateInvalidateRef = useRef(onStateInvalidate);
  onStateInvalidateRef.current = onStateInvalidate;
  const onImageUpdatesChangeRef = useRef(onImageUpdatesChange);
  onImageUpdatesChangeRef.current = onImageUpdatesChange;
  // One-shot: the notifications_ready milestone reflects the first local settle.
  // Its spans instrument only that first fetch so later polls do not pollute the
  // report.
  const notificationsReadyRef = useRef(false);

  const fetchNotifications = async () => {
    try {
      const currentNodes = nodesRef.current;
      const localNode = currentNodes.find(n => n.type === 'local');
      // Skip offline nodes: polling a removed/unreachable node only yields 502s.
      const remoteNodes = currentNodes.filter(n => n.type === 'remote' && n.status !== 'offline');

      // Launch every request concurrently, but settle the local one first so the
      // notifications_ready milestone is not held back by the slowest remote.
      const localPromise = apiFetch('/notifications', { localOnly: true } as Parameters<typeof apiFetch>[1]);
      const remotePromises = remoteNodes.map(n => fetchForNode('/notifications', n.id));

      const all: NotificationItem[] = [];

      const instrument = !notificationsReadyRef.current;
      const headersSpan = instrument ? beginSpan('fetch_headers', { background: true }) : null;
      let bodySpan: ReturnType<typeof beginSpan> | null = null;
      try {
        const localRes = await localPromise;
        if (headersSpan !== null) endSpan(headersSpan, { detail: { status: localRes.status } });
        if (localRes.ok) {
          bodySpan = instrument ? beginSpan('body_decode', { background: true }) : null;
          const data = await localRes.json() as Omit<NotificationItem, 'nodeId' | 'nodeName'>[];
          if (bodySpan !== null) endSpan(bodySpan);
          bodySpan = null;
          data.forEach(n => all.push({ ...n, nodeId: localNode?.id ?? -1, nodeName: localNode?.name ?? 'Local' }));
        }
      } catch (e) {
        if (headersSpan !== null) endSpan(headersSpan, { outcome: 'error' });
        if (bodySpan !== null) endSpan(bodySpan, { outcome: 'error' });
        console.error('[Notifications] local fetch error:', e);
      } finally {
        if (!notificationsReadyRef.current) {
          notificationsReadyRef.current = true;
          markMilestone('notifications_ready');
        }
      }

      // Remotes settle in the background; they never gate the milestone above.
      const remoteNodeResults = await Promise.allSettled(remotePromises);
      for (let i = 0; i < remoteNodes.length; i++) {
        const result = remoteNodeResults[i];
        if (result?.status === 'fulfilled' && result.value.ok) {
          const data = await result.value.json() as Omit<NotificationItem, 'nodeId' | 'nodeName'>[];
          const rn = remoteNodes[i];
          data.forEach(n => all.push({ ...n, nodeId: rn.id, nodeName: rn.name }));
        }
      }

      all.sort((a, b) => b.timestamp - a.timestamp);
      setNotifications(all);
    } catch (e) {
      console.error('[Notifications] fetch error:', e);
    }
  };

  const fetchNotificationsRef = useRef(fetchNotifications);
  fetchNotificationsRef.current = fetchNotifications;

  // Local notification WebSocket with exponential-backoff reconnect.
  useEffect(() => {
    const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsBase = `${wsProtocol}//${window.location.host}`;
    let ws: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let isMounted = true;
    let retryCount = 0;
    const MAX_RETRY_DELAY_MS = 30000;

    const connect = () => {
      if (!isMounted) return;
      ws = new WebSocket(`${wsBase}/ws/notifications`);

      ws.onopen = () => {
        if (!isMounted) { ws?.close(); return; }
        setTickerConnected(true);
        retryCount = 0;
        window.dispatchEvent(new CustomEvent('sencho:notifications-connection', { detail: { connected: true } }));
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data as string);
          if (msg.type === 'notification' && msg.payload) {
            const localNode = nodesRef.current.find(n => n.type === 'local');
            const tagged: NotificationItem = {
              ...(msg.payload as Omit<NotificationItem, 'nodeId' | 'nodeName'>),
              nodeId: localNode?.id ?? -1,
              nodeName: localNode?.name ?? 'Local',
            };
            setNotifications(prev => [tagged, ...prev].sort((a, b) => b.timestamp - a.timestamp));
          } else if (msg.type === 'state-invalidate') {
            window.dispatchEvent(new CustomEvent('sencho:state-invalidate', { detail: msg }));
            onStateInvalidateRef.current();
            if (msg.scope === 'image-updates' && msg.action === 'stack-updated') {
              onImageUpdatesChangeRef.current();
            }
          }
        } catch (e) {
          console.error('[WS notifications] parse error', e);
        }
      };

      ws.onclose = (event) => {
        setTickerConnected(false);
        window.dispatchEvent(new CustomEvent('sencho:notifications-connection', { detail: { connected: false } }));
        if (!isMounted) return;
        const delay = Math.min(1000 * Math.pow(2, retryCount), MAX_RETRY_DELAY_MS);
        retryCount++;
        console.debug(`[WS notifications] closed (code=${event.code}), reconnecting in ${delay}ms`);
        reconnectTimer = setTimeout(connect, delay);
      };

      ws.onerror = (event) => { console.warn('[WS notifications] error event', event); };
    };

    connect();

    return () => {
      isMounted = false;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (ws && ws.readyState === WebSocket.OPEN) ws.close();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Re-fetch all notifications when the nodes list changes.
  useEffect(() => {
    fetchNotifications();
  }, [nodes]); // eslint-disable-line react-hooks/exhaustive-deps

  // Open/close per-remote-node WebSocket connections as the nodes list changes.
  useEffect(() => {
    // Skip offline nodes: an offline node leaves the active set, so the cleanup
    // loop below closes its socket instead of reconnecting to a dead 503 forever.
    const remoteNodes = nodes.filter(n => n.type === 'remote' && n.status !== 'offline');
    const currentIds = new Set(remoteNotifWsRef.current.keys());
    const newIds = new Set(remoteNodes.map(n => n.id));

    for (const id of currentIds) {
      if (!newIds.has(id)) {
        remoteNotifWsRef.current.get(id)?.();
        remoteNotifWsRef.current.delete(id);
      }
    }

    for (const rn of remoteNodes) {
      if (remoteNotifWsRef.current.has(rn.id)) continue;

      let ws: WebSocket | null = null;
      let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
      let active = true;
      let retryCount = 0;

      const connect = () => {
        if (!active) return;
        const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        ws = new WebSocket(`${wsProtocol}//${window.location.host}/ws/notifications?nodeId=${rn.id}`);

        ws.onopen = () => { if (!active) { ws?.close(); } else { retryCount = 0; } };

        ws.onmessage = (event) => {
          try {
            const msg = JSON.parse(event.data as string);
            if (msg.type === 'notification' && msg.payload) {
              const current = nodesRef.current.find(n => n.id === rn.id);
              setNotifications(prev =>
                [{ ...msg.payload as Omit<NotificationItem, 'nodeId' | 'nodeName'>, nodeId: rn.id, nodeName: current?.name ?? rn.name }, ...prev]
                  .sort((a, b) => b.timestamp - a.timestamp),
              );
            } else if (msg.type === 'state-invalidate') {
              window.dispatchEvent(new CustomEvent('sencho:state-invalidate', { detail: { ...msg, nodeId: rn.id } }));
              onStateInvalidateRef.current();
              if (msg.scope === 'image-updates' && msg.action === 'stack-updated') {
                onImageUpdatesChangeRef.current();
              }
            }
          } catch (e) {
            console.error(`[WS notifications:${rn.name}] parse error`, e);
          }
        };

        ws.onclose = () => {
          if (!active) return;
          const delay = Math.min(1000 * Math.pow(2, retryCount), 30000);
          retryCount++;
          reconnectTimer = setTimeout(connect, delay);
        };

        ws.onerror = (e) => console.warn(`[WS notifications:${rn.name}] error`, e);
      };

      connect();

      remoteNotifWsRef.current.set(rn.id, () => {
        active = false;
        if (reconnectTimer) clearTimeout(reconnectTimer);
        if (ws && ws.readyState === WebSocket.OPEN) ws.close();
      });
    }
  }, [nodes]); // eslint-disable-line react-hooks/exhaustive-deps

  // Cleanup all remote notification WebSocket connections on unmount.
  useEffect(() => {
    return () => {
      for (const cleanup of remoteNotifWsRef.current.values()) cleanup();
      remoteNotifWsRef.current.clear();
    };
  }, []);

  // Safety-net poll: reconciles the list every 60 s.
  useEffect(() => {
    const id = setInterval(() => { fetchNotificationsRef.current(); }, 60_000);
    return () => clearInterval(id);
  }, []);

  const markAllRead = async () => {
    try {
      const localNode = nodesRef.current.find(n => n.type === 'local');
      const unreadNodeIds = [...new Set(notifications.filter(n => !n.is_read && n.nodeId != null).map(n => n.nodeId as number))];
      if (unreadNodeIds.length === 0) return;

      const results = await Promise.allSettled(unreadNodeIds.map(nodeId =>
        nodeId === localNode?.id
          ? apiFetch('/notifications/read', { method: 'POST', localOnly: true } as Parameters<typeof apiFetch>[1])
          : fetchForNode('/notifications/read', nodeId, { method: 'POST' }),
      ));

      const succeededNodeIds = new Set<number>();
      let hadFailure = false;
      for (let i = 0; i < results.length; i++) {
        const result = results[i];
        const nodeId = unreadNodeIds[i];
        if (result.status === 'fulfilled' && result.value.ok) {
          succeededNodeIds.add(nodeId);
        } else {
          hadFailure = true;
        }
      }

      if (succeededNodeIds.size > 0) {
        setNotifications(prev => prev.map(n =>
          n.nodeId != null && succeededNodeIds.has(n.nodeId) ? { ...n, is_read: 1 } : n,
        ));
      }

      if (hadFailure) {
        toast.error('Some notifications could not be marked as read');
      }

      void fetchNotificationsRef.current();
    } catch (e: unknown) {
      const err = e as { message?: string; error?: string };
      toast.error(err?.message || err?.error || 'Failed to mark notifications as read');
    }
  };

  const deleteNotification = async (notif: NotificationItem) => {
    try {
      const localNode = nodesRef.current.find(n => n.type === 'local');
      if (notif.nodeId === localNode?.id) {
        await apiFetch(`/notifications/${notif.id}`, { method: 'DELETE', localOnly: true } as Parameters<typeof apiFetch>[1]);
      } else if (notif.nodeId != null) {
        await fetchForNode(`/notifications/${notif.id}`, notif.nodeId, { method: 'DELETE' });
      }
      setNotifications(prev => prev.filter(n => !(n.id === notif.id && n.nodeId === notif.nodeId)));
    } catch (e: unknown) {
      const err = e as { message?: string; error?: string };
      toast.error(err?.message || err?.error || 'Failed to delete notification');
    }
  };

  const clearAllNotifications = async () => {
    try {
      const localNode = nodesRef.current.find(n => n.type === 'local');
      const uniqueNodeIds = [...new Set(notifications.filter(n => n.nodeId != null).map(n => n.nodeId as number))];
      await Promise.allSettled(uniqueNodeIds.map(nodeId =>
        nodeId === localNode?.id
          ? apiFetch('/notifications', { method: 'DELETE', localOnly: true } as Parameters<typeof apiFetch>[1])
          : fetchForNode('/notifications', nodeId, { method: 'DELETE' }),
      ));
      setNotifications([]);
    } catch (e: unknown) {
      const err = e as { message?: string; error?: string };
      toast.error(err?.message || err?.error || 'Failed to clear notifications');
    }
  };

  return {
    notifications,
    tickerConnected,
    markAllRead,
    deleteNotification,
    clearAllNotifications,
  } as const;
}
