import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from 'react';
import { apiFetch } from '@/lib/api';

export type LicenseTier = 'community' | 'paid';
export type LicenseStatus = 'community' | 'trial' | 'active' | 'expired' | 'disabled';

export interface LicenseInfo {
    tier: LicenseTier;
    status: LicenseStatus;
    customerName: string | null;
    productName: string | null;
    maskedKey: string | null;
    validUntil: string | null;
    trialDaysRemaining: number | null;
    instanceId: string;
    portalUrl: string | null;
    isLifetime: boolean;
}

interface LicenseContextType {
    license: LicenseInfo | null;
    isPaid: boolean;
    loading: boolean;
    refresh: () => Promise<void>;
    activate: (licenseKey: string) => Promise<{ success: boolean; error?: string }>;
    deactivate: () => Promise<{ success: boolean; error?: string }>;
}

const LicenseContext = createContext<LicenseContextType | undefined>(undefined);

export function LicenseProvider({ children }: { children: ReactNode }) {
    const [license, setLicense] = useState<LicenseInfo | null>(null);
    const [loading, setLoading] = useState(true);

    const refresh = useCallback(async () => {
        try {
            const res = await apiFetch('/license', { localOnly: true });
            if (res.ok) {
                const data = await res.json();
                setLicense(data);
            }
        } catch {
            // Silently fail - license info is non-critical
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        refresh();
    }, [refresh]);

    const activate = useCallback(async (licenseKey: string): Promise<{ success: boolean; error?: string }> => {
        try {
            const res = await apiFetch('/license/activate', {
                method: 'POST',
                localOnly: true,
                body: JSON.stringify({ license_key: licenseKey }),
            });
            const data = await res.json();
            if (res.ok && data.success) {
                setLicense(data.license);
                return { success: true };
            }
            return { success: false, error: data.error || 'Activation failed' };
        } catch {
            return { success: false, error: 'Network error. Please try again.' };
        }
    }, []);

    const deactivate = useCallback(async (): Promise<{ success: boolean; error?: string }> => {
        try {
            const res = await apiFetch('/license/deactivate', {
                method: 'POST',
                localOnly: true,
            });
            const data = await res.json();
            if (res.ok && data.success) {
                setLicense(data.license);
                return { success: true };
            }
            return { success: false, error: data.error || 'Deactivation failed' };
        } catch {
            return { success: false, error: 'Network error. Please try again.' };
        }
    }, []);

    const isPaid = license?.tier === 'paid';

    return (
        <LicenseContext.Provider value={{ license, isPaid, loading, refresh, activate, deactivate }}>
            {children}
        </LicenseContext.Provider>
    );
}

// eslint-disable-next-line react-refresh/only-export-components
export function useLicense(): LicenseContextType {
    const context = useContext(LicenseContext);
    if (context === undefined) {
        throw new Error('useLicense must be used within a LicenseProvider');
    }
    return context;
}
