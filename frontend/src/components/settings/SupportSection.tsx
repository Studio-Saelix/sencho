import { useLicense } from '@/context/LicenseContext';
import { TierBadge } from '@/components/TierBadge';
import { Book, Bug, Mail, ExternalLink } from 'lucide-react';
import { SettingsSection } from './SettingsSection';

interface ResourceLinkProps {
    icon: React.ReactNode;
    title: string;
    blurb: string;
    href: string;
    external?: boolean;
}

function ResourceLink({ icon, title, blurb, href, external = true }: ResourceLinkProps) {
    return (
        <a
            href={href}
            target={external ? '_blank' : undefined}
            rel={external ? 'noopener noreferrer' : undefined}
            className="flex items-center gap-3 p-3 rounded-md border border-card-border bg-card hover:border-brand/30 transition-colors"
        >
            <div className="w-9 h-9 rounded-md bg-glass flex items-center justify-center shrink-0 text-stat-subtitle">
                {icon}
            </div>
            <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-stat-value">{title}</p>
                <p className="text-xs text-stat-subtitle">{blurb}</p>
            </div>
            <ExternalLink className="w-4 h-4 text-stat-subtitle shrink-0" />
        </a>
    );
}

export function SupportSection() {
    const { isPaid } = useLicense();

    return (
        <div className="flex flex-col gap-10">
            <SettingsSection title="Self-serve">
                <div className="pt-3 grid gap-3">
                    <ResourceLink
                        icon={<Book className="w-4 h-4" />}
                        title="Documentation"
                        blurb="Guides, reference, and tutorials"
                        href="https://docs.sencho.io"
                    />
                    <ResourceLink
                        icon={<Bug className="w-4 h-4" />}
                        title="GitHub Issues"
                        blurb="Report bugs and request features"
                        href="https://github.com/studio-saelix/sencho/issues"
                    />
                </div>
            </SettingsSection>

            {isPaid && (
                <SettingsSection
                    title="Priority support"
                    kicker={<TierBadge />}
                >
                    <div className="pt-3 grid gap-3">
                        <ResourceLink
                            icon={<Mail className="w-4 h-4" />}
                            title="Priority email support"
                            blurb="Monday to Friday, 09:00 to 17:00 America/New_York. We aim to first-respond within one business day. This is not a contractual SLA or 24/7 service."
                            href="mailto:support@sencho.io"
                            external={false}
                        />
                    </div>
                </SettingsSection>
            )}
        </div>
    );
}
