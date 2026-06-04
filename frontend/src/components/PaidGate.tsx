import type { ReactNode } from 'react';
import { useLicense } from '@/context/LicenseContext';

/**
 * Thin wrapper that renders its children only for licensees on the paid
 * plan. Community-tier users see nothing in this slot. Backend tier
 * guards (`requirePaid`) remain the authoritative enforcement; this
 * component only controls UI visibility.
 *
 * Use only when wrapping a discrete fragment that has no neighboring
 * context for Community users. Where possible, prefer a parent-level
 * `useLicense().isPaid` check that lifts the visibility decision out
 * of the rendering tree entirely.
 */
export function PaidGate({ children }: { children: ReactNode }) {
    const { isPaid } = useLicense();
    return isPaid ? <>{children}</> : null;
}
