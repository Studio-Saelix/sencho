import { Globe, ShipWheel } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { useLicense, type LicenseTier } from '@/context/LicenseContext';

interface TierBadgeProps {
    tier?: LicenseTier;
    className?: string;
}

const tierConfig = {
    community: { icon: Globe, label: 'Community' },
    paid: { icon: ShipWheel, label: 'Admiral' },
} as const;

export function TierBadge({ tier, className }: TierBadgeProps) {
    const { license } = useLicense();
    const resolvedTier = tier ?? license?.tier ?? 'community';
    const { icon: Icon, label } = resolvedTier === 'paid' ? tierConfig.paid : tierConfig.community;

    return (
        <Badge variant="secondary" className={`gap-1 text-[10px] font-semibold uppercase px-1.5 py-0 ${className || ''}`}>
            <Icon className="w-2.5 h-2.5" />
            {label}
        </Badge>
    );
}
