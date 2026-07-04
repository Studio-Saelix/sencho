import { useState } from 'react';
import { MoreVertical, Check, Plus, BellOff } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator,
  DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { LabelDot } from '@/components/LabelPill';
import { MAX_LABELS_PER_NODE } from '@/components/label-types';
import { cn } from '@/lib/utils';
import type { MenuGroup, MenuItem, StackMenuCtx } from './sidebar-types';
import { useStackMenuItems } from '@/hooks/useStackMenuItems';
import { LabelInlineCreateForm } from './LabelInlineCreateForm';

interface StackKebabMenuProps {
  file: string;
  ctx: StackMenuCtx;
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
    <DropdownMenuSub onOpenChange={open => { if (!open) setCreating(false); }}>
      <DropdownMenuSubTrigger>
        <item.icon className="h-4 w-4 mr-2" strokeWidth={1.5} />
        {item.label}
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="min-w-[200px]">
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
              <DropdownMenuItem disabled>
                <span className="text-xs text-muted-foreground">No labels yet</span>
              </DropdownMenuItem>
            )}
            {ctx.labels.map(label => {
              const assigned = ctx.assignedLabelIds.includes(label.id);
              return (
                <DropdownMenuItem key={label.id} onSelect={(e) => { e.preventDefault(); ctx.toggleLabel(label.id); }}>
                  <LabelDot color={label.color} />
                  <span className="flex-1 font-mono text-[12px] ml-2">{label.name}</span>
                  {assigned && <Check className="w-3.5 h-3.5 text-success ml-auto shrink-0" strokeWidth={1.5} />}
                </DropdownMenuItem>
              );
            })}
            <DropdownMenuSeparator />
            {ctx.canCreateLabels && ctx.labels.length < MAX_LABELS_PER_NODE && (
              <DropdownMenuItem onSelect={e => { e.preventDefault(); setCreating(true); }}>
                <Plus className="w-3.5 h-3.5 mr-2 text-muted-foreground" strokeWidth={1.5} />
                <span className="text-xs">New label</span>
              </DropdownMenuItem>
            )}
            <DropdownMenuItem onClick={ctx.openLabelManager}>
              <span className="text-xs">Manage labels...</span>
            </DropdownMenuItem>
            {ctx.canMuteNotifications && ctx.labels.length > 0 && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger>
                    <BellOff className="w-3.5 h-3.5 mr-2" strokeWidth={1.5} />
                    <span className="text-xs">Mute label…</span>
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent className="min-w-[200px]">
                    {ctx.labels.map(label => (
                      <DropdownMenuSub key={label.id}>
                        <DropdownMenuSubTrigger>
                          <LabelDot color={label.color} />
                          <span className="font-mono text-[12px] ml-2">{label.name}</span>
                        </DropdownMenuSubTrigger>
                        <DropdownMenuSubContent>
                          <DropdownMenuItem onSelect={() => ctx.muteLabelAll(label.id, label.name)}>
                            <span className="text-xs">Mute notifications for this label</span>
                          </DropdownMenuItem>
                          <DropdownMenuItem onSelect={() => ctx.muteLabelExternal(label.id, label.name)}>
                            <span className="text-xs">Mute external alerts for this label</span>
                          </DropdownMenuItem>
                          <DropdownMenuItem onSelect={() => ctx.muteLabelLowPriority(label.id, label.name)}>
                            <span className="text-xs">Mute low-priority stack alerts</span>
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem onSelect={() => ctx.openLabelMuteRules(label.id, label.name)}>
                            <span className="text-xs">Manage label mute rules</span>
                          </DropdownMenuItem>
                        </DropdownMenuSubContent>
                      </DropdownMenuSub>
                    ))}
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
              </>
            )}
          </>
        )}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

function SimpleSub({ item, MenuSub, MenuSubTrigger, MenuSubContent, MenuItem }: {
  item: MenuItem;
  MenuSub: typeof DropdownMenuSub;
  MenuSubTrigger: typeof DropdownMenuSubTrigger;
  MenuSubContent: typeof DropdownMenuSubContent;
  MenuItem: typeof DropdownMenuItem;
}) {
  return (
    <MenuSub>
      <MenuSubTrigger>
        <item.icon className="h-4 w-4 mr-2" strokeWidth={1.5} />
        {item.label}
      </MenuSubTrigger>
      <MenuSubContent className="min-w-[220px]">
        {item.subItems?.map((sub) => (
          <MenuItem key={sub.id} onSelect={() => sub.onSelect()}>
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
        MenuSub={DropdownMenuSub}
        MenuSubTrigger={DropdownMenuSubTrigger}
        MenuSubContent={DropdownMenuSubContent}
        MenuItem={DropdownMenuItem}
      />
    );
  }
  return (
    <DropdownMenuItem
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
    </DropdownMenuItem>
  );
}

function renderGroup(group: MenuGroup, ctx: StackMenuCtx, showSep: boolean) {
  return (
    <div key={group.id}>
      {showSep && <DropdownMenuSeparator />}
      <GroupHeader id={group.id} />
      {group.items.map(item => renderItem(item, ctx))}
    </div>
  );
}

export function StackKebabMenu({ file, ctx }: StackKebabMenuProps) {
  const groups = useStackMenuItems(file, ctx);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="h-6 w-6">
          <MoreVertical className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {groups.map((g, i) => renderGroup(g, ctx, i > 0))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
