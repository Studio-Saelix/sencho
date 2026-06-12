import { useState, type ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';
import { useAuth } from '@/context/AuthContext';
import { useLicense } from '@/context/LicenseContext';
import { useNodes } from '@/context/NodeContext';
import {
  SETTINGS_GROUPS,
  SETTINGS_ITEMS,
  getSettingsItem,
  getSettingsGroup,
  isItemVisible,
  isItemLocked,
} from '@/components/settings';
import type { SectionId } from '@/components/settings';
import { SettingsSectionContent } from '@/components/settings/SettingsSectionContent';
import { BackChip, Kicker, Masthead } from './mobile-ui';

interface MobileSettingsProps {
  headerActions: ReactNode;
}

const NOOP = () => {};

export function MobileSettings({ headerActions }: MobileSettingsProps) {
  const { isAdmin } = useAuth();
  const { isPaid } = useLicense();
  const { activeNode } = useNodes();
  const isRemote = activeNode?.type === 'remote';
  const nodeName = activeNode?.name ?? 'local';
  const visibility = { isRemote, isAdmin, isPaid };

  const visibleItems = SETTINGS_ITEMS.filter(
    item => isItemVisible(item, visibility) && !isItemLocked(item, visibility),
  );
  const groups = SETTINGS_GROUPS
    .map(group => ({ ...group, items: visibleItems.filter(item => item.group === group.id) }))
    .filter(group => group.items.length > 0);

  const [selected, setSelected] = useState<SectionId | null>(null);
  // If the active node changes and hides the open section, fall back to the list.
  const activeSection = selected && visibleItems.some(i => i.id === selected) ? selected : null;
  const item = activeSection ? getSettingsItem(activeSection) : null;

  if (activeSection && item) {
    const group = getSettingsGroup(item.group);
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="px-2 pt-1">
          <BackChip label="Settings" onClick={() => setSelected(null)} />
        </div>
        <div className="relative border-b border-hairline px-4 pb-[15px] pt-1">
          <span aria-hidden className="absolute left-0 top-1 bottom-[15px] w-[3px] bg-brand" />
          <div className="mb-1"><Kicker>{`settings · ${group?.label ?? ''} · ${item.label}`}</Kicker></div>
          <span className="font-display italic text-[30px] leading-[34px] text-stat-value">{item.label}</span>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden px-4 pb-8 pt-4 flex flex-col gap-6">
          <SettingsSectionContent sectionId={activeSection} onDirtyChange={NOOP} showDescription />
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <Masthead
        kicker={`settings · ${nodeName}`}
        state="Settings"
        stateTone="brand"
        live={false}
        right={headerActions}
      />
      <div className="flex-1 min-h-0 overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden p-[14px] [&>*+*]:mt-[14px]">
        {groups.map(group => (
          <div
            key={group.id}
            className="overflow-hidden rounded-[12px] border border-card-border border-t-card-border-top bg-card shadow-card-bevel"
          >
            <div className="border-b border-hairline px-[13px] py-2.5">
              <Kicker>{group.kicker ? `${group.label} · ${group.kicker}` : group.label}</Kicker>
            </div>
            {group.items.map((it, idx) => (
              <button
                key={it.id}
                type="button"
                onClick={() => setSelected(it.id)}
                className={`flex min-h-11 w-full items-center gap-3 px-[13px] py-3 text-left ${idx > 0 ? 'border-t border-hairline' : ''}`}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[15px] text-stat-value">{it.label}</span>
                  <span className="block truncate font-mono text-[11px] text-stat-icon">{it.description}</span>
                </span>
                <ChevronRight className="h-4 w-4 shrink-0 text-stat-icon" strokeWidth={1.6} />
              </button>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
