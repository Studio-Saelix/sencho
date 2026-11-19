import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from '@/components/ui/toast-store';
import { useAuth } from '@/context/AuthContext';
import { useExperimental } from '@/hooks/useExperimental';
import {
  PublicExposureApiError,
  publicExposureApi,
  type PublicExposureAccountView,
} from '@/lib/publicExposureApi';

export type PublicExposurePending = 'connect' | 'recheck' | 'dns_check' | 'disconnect' | 'zone' | null;

/** One operator-facing sentence per route error code. A code the UI does not know falls back to the server's own message. */
const ERROR_COPY: Record<string, string> = {
  TOKEN_INVALID: 'Cloudflare rejects this token. Check that it was copied whole.',
  TOKEN_INACTIVE: 'This token is disabled or expired in Cloudflare.',
  TOKEN_LOCATION_REFUSED: "Cloudflare refuses this token from this control instance's address. Allow its address on the token in Cloudflare.",
  ACCOUNT_NOT_ACCESSIBLE: 'This token cannot reach that account. Check the account id and the token\'s account resources.',
  CREDENTIAL_UNREADABLE: 'The stored token cannot be read on this control instance. Replace it.',
  CLOUDFLARE_UNREACHABLE: 'Could not reach api.cloudflare.com. Nothing was changed.',
  CLOUDFLARE_RATE_LIMITED: 'Cloudflare is limiting requests. Try again shortly.',
  UNEXPECTED_RESPONSE: 'Cloudflare sent a response Sencho could not read.',
  ACCOUNT_CHANGE_NEEDS_DISCONNECT: 'This token is for a different Cloudflare account. Disconnect the current account first.',
  ACCOUNT_BUSY: 'Another Cloudflare account action is running. Try again when it finishes.',
  ENDPOINTS_EXIST: 'Nodes still use this Cloudflare account. Remove their Cloudflare Tunnel endpoints first.',
  NOT_CONNECTED: 'No Cloudflare account is connected.',
  ZONE_NOT_ENABLED: 'Enable the zone before checking DNS write.',
  ZONE_NOT_FOUND: 'That zone is not in the connected account. Recheck to refresh the zone list.',
};

/** The sentence to show for a failed verb. Codes that name a record (conflict, cleanup) keep the server's sentence. */
export function publicExposureErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof PublicExposureApiError) {
    if (error.code === 'CLOUDFLARE_RATE_LIMITED' && error.retryAfterSeconds) {
      return `Cloudflare is limiting requests. Try again in ${error.retryAfterSeconds} s.`;
    }
    if (error.code && ERROR_COPY[error.code]) return ERROR_COPY[error.code];
    return error.message || fallback;
  }
  return (error as Error)?.message || fallback;
}

/** True when the operator may see the account: an Admin on a control instance with the experimental flag on. */
export function useShowCloudflareAccountCard(): boolean {
  const { isAdmin } = useAuth();
  const { experimental } = useExperimental();
  return experimental && isAdmin;
}

export interface PublicExposureAccount {
  view: PublicExposureAccountView | null;
  /** True only until the first answer; a refetch keeps the last view on screen. */
  loading: boolean;
  loadError: string | null;
  pending: PublicExposurePending;
  reload: () => Promise<void>;
  /** Resolves to the error message to show beside the form, or null on success. */
  connect: (token: string, accountId: string) => Promise<string | null>;
  recheck: () => Promise<void>;
  dnsCheck: (zoneRef: string) => Promise<void>;
  disconnect: () => Promise<boolean>;
  setZone: (zoneRef: string, enabled: boolean, allowedSuffixes: string[]) => Promise<string | null>;
}

/**
 * The one shared hook behind every public exposure verb. The card and the
 * sheet both read it, so a verb runs the same way wherever it is offered.
 * It fetches once on mount and after each verb; it never polls. Mount it only
 * where the operator may see the account (experimental flag and Admin).
 */
export function usePublicExposureAccount(): PublicExposureAccount {
  const [view, setView] = useState<PublicExposureAccountView | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pending, setPending] = useState<PublicExposurePending>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const reload = useCallback(async () => {
    try {
      const next = await publicExposureApi.getAccount();
      if (!mounted.current) return;
      setView(next);
      setLoadError(null);
    } catch (error: unknown) {
      if (!mounted.current) return;
      const message = publicExposureErrorMessage(error, 'Could not load the Cloudflare connection.');
      setLoadError(message);
      toast.error(message);
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const run = useCallback(async <T,>(kind: Exclude<PublicExposurePending, null>, action: () => Promise<T>): Promise<T> => {
    setPending(kind);
    try {
      return await action();
    } finally {
      if (mounted.current) setPending(null);
    }
  }, []);

  const connect = useCallback((token: string, accountId: string) => run('connect', async () => {
    try {
      const next = await publicExposureApi.connect(token, accountId);
      if (mounted.current) setView(next);
      toast.success('Cloudflare account connected.');
      return null;
    } catch (error: unknown) {
      return publicExposureErrorMessage(error, 'Could not connect the Cloudflare account.');
    }
  }), [run]);

  const recheck = useCallback(() => run('recheck', async () => {
    try {
      const next = await publicExposureApi.recheck();
      if (mounted.current) setView(next);
    } catch (error: unknown) {
      toast.error(publicExposureErrorMessage(error, 'Could not recheck the Cloudflare account.'));
    }
  }), [run]);

  const dnsCheck = useCallback((zoneRef: string) => run('dns_check', async () => {
    try {
      const next = await publicExposureApi.dnsCheck(zoneRef);
      if (mounted.current) setView(next);
    } catch (error: unknown) {
      toast.error(publicExposureErrorMessage(error, 'Could not check DNS write.'));
      // A refused check may still have changed a zone's state or journal.
      await reload();
    }
  }), [run, reload]);

  const disconnect = useCallback(() => run('disconnect', async () => {
    try {
      await publicExposureApi.disconnect();
      if (mounted.current) setView({ connected: false });
      toast.success('Cloudflare account disconnected.');
      return true;
    } catch (error: unknown) {
      toast.error(publicExposureErrorMessage(error, 'Could not disconnect the Cloudflare account.'));
      await reload();
      return false;
    }
  }), [run, reload]);

  const setZone = useCallback((zoneRef: string, zoneEnabled: boolean, allowedSuffixes: string[]) => run('zone', async () => {
    try {
      const next = await publicExposureApi.setZone(zoneRef, zoneEnabled, allowedSuffixes);
      if (mounted.current) setView(next);
      return null;
    } catch (error: unknown) {
      const message = publicExposureErrorMessage(error, 'Could not update the zone.');
      toast.error(message);
      return message;
    }
  }), [run]);

  return { view, loading, loadError, pending, reload, connect, recheck, dnsCheck, disconnect, setZone };
}
