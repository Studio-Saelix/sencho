import { createContext, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { apiFetch } from '@/lib/api';
import { useAuth } from './AuthContext';

export type BuildChannel = 'stable' | 'dev' | 'preview' | 'unknown';
export type ImageChannel = 'community' | 'hardened' | 'unknown';
export type BuildInfoStatus = 'loading' | 'ready' | 'error';

/** Canonical runtime build identity of the control instance. Mirrors the
 *  /api/build-info response: imageRef and revision are nulled for hardened
 *  images when the viewer is not an admin, with `restricted` marking that
 *  redaction (the UI shows "Restricted", never "Unknown", when set).
 *  `restricted === true` implies `imageRef === null && revision === null`. */
export interface BuildInfo {
  version: string | null;
  channel: BuildChannel;
  imageChannel: ImageChannel;
  imageRef: string | null;
  imageId: string | null;
  revision: string | null;
  restricted: boolean;
}

export interface BuildInfoContextType {
  buildInfo: BuildInfo | null;
  status: BuildInfoStatus;
  retry: () => void;
}

// eslint-disable-next-line react-refresh/only-export-components
export const BuildInfoContext = createContext<BuildInfoContextType | undefined>(undefined);

/** Single owner of the control-instance build identity. Mounted inside the
 *  authenticated subtree. One shared fetch (localOnly, so it always targets the
 *  local hub); permission-filtered state is cleared the moment the auth identity
 *  or role changes, and stale in-flight completions from a prior session are
 *  rejected by a generation counter. Focus retries an error so it never sticks
 *  failed; consumers show a placeholder while loading and "Unknown" on error. */
export function BuildInfoProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();

  const [buildInfo, setBuildInfo] = useState<BuildInfo | null>(null);
  const [status, setStatus] = useState<BuildInfoStatus>('loading');

  const generationRef = useRef(0);
  const statusRef = useRef<BuildInfoStatus>('loading');
  const identityRef = useRef<string | null>(null);

  const load = useCallback(async () => {
    const gen = ++generationRef.current;
    setStatus('loading');
    try {
      const res = await apiFetch('/build-info', { localOnly: true });
      if (gen !== generationRef.current) return;
      if (res.ok) {
        const data = (await res.json()) as BuildInfo;
        if (gen !== generationRef.current) return;
        setBuildInfo(data);
        setStatus('ready');
      } else {
        console.error(`[BuildInfo] fetch returned ${res.status}`);
        setStatus('error');
      }
    } catch (err) {
      if (gen !== generationRef.current) return;
      console.error('[BuildInfo] fetch failed', err);
      setStatus('error');
    }
  }, []);

  // Reload whenever the signed-in identity or role changes. Clearing state
  // synchronously (before the replacement fetch resolves) guarantees a
  // hardened admin's reference never surfaces in a viewer session.
  useEffect(() => {
    const identity = user ? `${user.username}:${user.role}` : null;
    if (identity !== identityRef.current) {
      identityRef.current = identity;
      setBuildInfo(null);
      setStatus('loading');
      void load();
    }
  }, [user, load]);

  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  // A transient failure (auth expiry, hub restart) should not stick: retry the
  // moment the tab regains focus.
  useEffect(() => {
    const onFocus = () => {
      if (statusRef.current === 'error') void load();
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [load]);

  return (
    <BuildInfoContext.Provider value={{ buildInfo, status, retry: () => void load() }}>
      {children}
    </BuildInfoContext.Provider>
  );
}