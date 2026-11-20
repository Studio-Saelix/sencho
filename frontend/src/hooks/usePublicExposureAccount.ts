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

/**
 * The sentence to show for a failed verb. The control instance writes every
 * route message itself (with any Cloudflare detail already redacted), so it is
 * shown as is: it carries the specifics (an expiry date, a record name, a
 * Cloudflare code) a fixed sentence per code would drop. A rate limit names
 * its wait.
 */
export function publicExposureErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof PublicExposureApiError) {
    if (error.code === 'CLOUDFLARE_RATE_LIMITED' && error.retryAfterSeconds !== undefined) {
      return `${error.message} Try again in ${error.retryAfterSeconds} s.`;
    }
    return error.message || fallback;
  }
  return (error as Error)?.message || fallback;
}

/** True when the operator may see the account: an Admin signed into this instance with the experimental flag on. */
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
 * The one shared hook behind every public exposure verb. The caller calls it
 * once and hands the result to the card, which hands it to the sheet, so a
 * verb runs the same way wherever it is offered. While `enabled` (the
 * experimental flag and Admin), it fetches on mount and again whenever
 * `enabled` turns on; with `enabled: false` it makes no request. Each verb
 * replaces the view from its own answer (a refused DNS check or disconnect
 * refetches, since either may still have changed a zone). It never polls.
 */
export function usePublicExposureAccount(enabled = true): PublicExposureAccount {
  const [view, setView] = useState<PublicExposureAccountView | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pending, setPending] = useState<PublicExposurePending>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const load = useCallback(async ({ quiet }: { quiet: boolean }) => {
    try {
      const next = await publicExposureApi.getAccount();
      if (!mounted.current) return;
      setView(next);
      setLoadError(null);
    } catch (error: unknown) {
      if (!mounted.current) return;
      const message = publicExposureErrorMessage(error, 'Could not load the Cloudflare connection.');
      setLoadError(message);
      // After a verb's own failure toast, a failed refetch does not add a second one.
      if (!quiet) toast.error(message);
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, []);

  const reload = useCallback(() => load({ quiet: false }), [load]);

  useEffect(() => {
    if (!enabled) return;
    // A late enable (the experimental flag resolves after mount) starts a fresh first load.
    setLoading(true);
    void load({ quiet: false });
  }, [load, enabled]);

  const run = useCallback(async <T,>(kind: Exclude<PublicExposurePending, null>, action: () => Promise<T>): Promise<T> => {
    setPending(kind);
    try {
      return await action();
    } finally {
      if (mounted.current) setPending(null);
    }
  }, []);

  const connect = useCallback((token: string, accountId: string) => run('connect', async () => {
    const replacing = view?.connected === true;
    try {
      const next = await publicExposureApi.connect(token, accountId);
      if (mounted.current) setView(next);
      toast.success(replacing ? 'Cloudflare token replaced.' : 'Cloudflare account connected.');
      return null;
    } catch (error: unknown) {
      return publicExposureErrorMessage(error, 'Could not connect the Cloudflare account.');
    }
  }), [run, view]);

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
      const zone = next.connected ? next.zones.find((z) => z.zoneRef === zoneRef) : undefined;
      if (zone?.cleanupPending) {
        toast.warning(`The check did not finish. A permission-check record may be left in ${zone.name}. ${zone.cleanupPending.note ?? 'A later Recheck deletes it.'}`);
      }
    } catch (error: unknown) {
      toast.error(publicExposureErrorMessage(error, 'Could not check DNS write.'));
      await load({ quiet: true });
    }
  }), [run, load]);

  const disconnect = useCallback(() => run('disconnect', async () => {
    try {
      const { leftInCloudflare } = await publicExposureApi.disconnect();
      if (mounted.current) setView({ connected: false });
      if (leftInCloudflare.length > 0) {
        // The disconnect went through, but a record may still be in Cloudflare: say so instead of reporting a clean success.
        toast.warning(`Cloudflare account disconnected, but a permission-check record may still be in Cloudflare: ${leftInCloudflare.join(', ')}. Delete ${leftInCloudflare.length === 1 ? 'it' : 'them'} there.`);
      } else {
        toast.success('Cloudflare account disconnected.');
      }
      return true;
    } catch (error: unknown) {
      toast.error(publicExposureErrorMessage(error, 'Could not disconnect the Cloudflare account.'));
      await load({ quiet: true });
      return false;
    }
  }), [run, load]);

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
