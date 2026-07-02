import { useState, type ReactNode } from 'react';
import { Check, Plus, BellOff } from 'lucide-react';
import {
  ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator,
  ContextMenuSub, ContextMenuSubContent, ContextMenuSubTrigger, ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { LabelDot } from '@/components/LabelPill';
import { MAX_LABELS_PER_NODE } from '@/components/label-types';
import { cn } from '@/lib/utils';
import type { MenuGroup, MenuItem, StackMenuCtx } from './sidebar-types';
import { useStackMenuItems } from '@/hooks/useStackMenuItems';
import { LabelInlineCreateForm } from './LabelInlineCreateForm';

interface StackContextMenuProps {
  file: string;
  ctx: StackMenuCtx;
  children: ReactNode;
}

function GroupHeader({ id }: { id: string }) {
  return (
    <div className={cn(
      'px-2 pt-2 pb-1 font-mono text-[9px] tracking-[0.22em] uppercase',
      id === 'destructive' ? 'text-destructive/60' : 'text-stat-subtitle',
    )}>
      {id}
    </div>
  );
}

function LabelsSub({ item, ctx }: { item: MenuItem; ctx: StackMenuCtx }) {
  const [creating, setCreating] = useState(false);
  return (
    <ContextMenuSub onOpenChange={open => { if (!open) setCreating(false); }}>
      <ContextMenuSubTrigger>
        <item.icon className="h-4 w-4 mr-2" strokeWidth={1.5} />
        {item.label}
      </ContextMenuSubTrigger>
      <ContextMenuSubContent className="min-w-[200px]">
        {creating ? (
          <LabelInlineCreateForm
            onSubmit={async (name, color) => {
              await ctx.createAndAssignLabel(name, color);
              setCreating(false);
            }}
            onCancel={() => setCreating(false)}
          />
        ) : (
          <>
            {ctx.labels.length === 0 && (
              <ContextMenuItem disabled>
                <span className="text-xs text-muted-foreground">No labels yet</span>
              </ContextMenuItem>
            )}
            {ctx.labels.map(label => {
              const assigned = ctx.assignedLabelIds.includes(label.id);
              return (
                <ContextMenuItem key={label.id} onClick={() => ctx.toggleLabel(label.id)}>
                  <LabelDot color={label.color} />
                  <span className="flex-1 font-mono text-[12px] ml-2">{label.name}</span>
                  {assigned && <Check className="w-3.5 h-3.5 text-success ml-auto shrink-0" strokeWidth={1.5} />}
                </ContextMenuItem>
              );
            })}
            <ContextMenuSeparator />
            {ctx.canCreateLabels && ctx.labels.length < MAX_LABELS_PER_NODE && (
              <ContextMenuItem onSelect={e => { e.preventDefault(); setCreating(true); }}>
                <Plus className="w-3.5 h-3.5 mr-2 text-muted-foreground" strokeWidth={1.5} />
                <span className="text-xs">New label</span>
              </ContextMenuItem>
            )}
            <ContextMenuItem onClick={ctx.openLabelManager}>
              <span className="text-xs">Manage labels...</span>
            </ContextMenuItem>
            {ctx.canMuteNotifications && ctx.labels.length > 0 && (
              <>
                <ContextMenuSeparator />
                <ContextMenuSub>
                  <ContextMenuSubTrigger>
                    <BellOff className="w-3.5 h-3.5 mr-2" strokeWidth={1.5} />
                    <span className="text-xs">Mute label…</span>
                  </ContextMenuSubTrigger>
                  <ContextMenuSubContent className="min-w-[200px]">
                    {ctx.labels.map(label => (
                      <ContextMenuSub key={label.id}>
                        <ContextMenuSubTrigger>
                          <LabelDot color={label.color} />
                          <span className="font-mono text-[12px] ml-2">{label.name}</span>
                        </ContextMenuSubTrigger>
                        <ContextMenuSubContent>
                          <ContextMenuItem onClick={() => ctx.muteLabelAll(label.id, label.name)}>
                            <span className="text-xs">Mute notifications for this label</span>
                          </ContextMenuItem>
                          <ContextMenuItem onClick={() => ctx.muteLabelExternal(label.id, label.name)}>
                            <span className="text-xs">Mute external alerts for this label</span>
                          </ContextMenuItem>
                          <ContextMenuItem onClick={() => ctx.muteLabelLowPriority(label.id, label.name)}>
                            <span className="text-xs">Mute low-priority stack alerts</span>
                          </ContextMenuItem>
                          <ContextMenuSeparator />
                          <ContextMenuItem onClick={() => ctx.openLabelMuteRules(label.id, label.name)}>
                            <span className="text-xs">Manage label mute rules</span>
                          </ContextMenuItem>
                        </ContextMenuSubContent>
                      </ContextMenuSub>
                    ))}
                  </ContextMenuSubContent>
                </ContextMenuSub>
              </>
            )}
          </>
        )}
      </ContextMenuSubContent>
    </ContextMenuSub>
  );
}

function SimpleSub({ item, MenuSub, MenuSubTrigger, MenuSubContent, MenuItem }: {
  item: MenuItem;
  MenuSub: typeof ContextMenuSub;
  MenuSubTrigger: typeof ContextMenuSubTrigger;
  MenuSubContent: typeof ContextMenuSubContent;
  MenuItem: typeof ContextMenuItem;
}) {
  return (
    <MenuSub>
      <MenuSubTrigger>
        <item.icon className="h-4 w-4 mr-2" strokeWidth={1.5} />
        {item.label}
      </MenuSubTrigger>
      <MenuSubContent className="min-w-[220px]">
        {item.subItems?.map((sub) => (
          <MenuItem key={sub.id} onClick={() => sub.onSelect()}>
            <span className="text-xs">{sub.label}</span>
          </MenuItem>
        ))}
      </MenuSubContent>
    </MenuSub>
  );
}

function renderItem(item: MenuItem, ctx: StackMenuCtx) {
  if (item.id === 'labels') return <LabelsSub key={item.id} item={item} ctx={ctx} />;
  if (item.subItems?.length) {
    return (
      <SimpleSub
        key={item.id}
        item={item}
        MenuSub={ContextMenuSub}
        MenuSubTrigger={ContextMenuSubTrigger}
        MenuSubContent={ContextMenuSubContent}
        MenuItem={ContextMenuItem}
      />
    );
  }
  return (
    <ContextMenuItem
      key={item.id}
      onSelect={() => item.onSelect()}
      disabled={item.disabled}
      className={item.destructive ? 'text-destructive focus:text-destructive' : undefined}
    >
      <item.icon className="h-4 w-4 mr-2" strokeWidth={1.5} />
      <span className="flex-1">{item.label}</span>
      {item.shortcut && (
        <span className="ml-3 font-mono text-[10px] leading-3 tracking-[0.18em] text-stat-subtitle">{item.shortcut}</span>
      )}
    </ContextMenuItem>
  );
}

function renderGroup(group: MenuGroup, ctx: StackMenuCtx, showSep: boolean) {
  return (
    <div key={group.id}>
      {showSep && <ContextMenuSeparator />}
      <GroupHeader id={group.id} />
      {group.items.map(item => renderItem(item, ctx))}
    </div>
  );
}

export function StackContextMenu({ file, ctx, children }: StackContextMenuProps) {
  const groups = useStackMenuItems(file, ctx);
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent>
        {groups.map((g, i) => renderGroup(g, ctx, i > 0))}
      </ContextMenuContent>
    </ContextMenu>
  );
}
