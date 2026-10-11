import { MoreHorizontal } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { createMuteFromNotification } from '@/lib/muteRules';
import type { NotificationItem } from '@/components/dashboard/types';

/**
 * Mute shortcuts for one notification row. Shared by the bell and Home's
 * Recent alerts so both create the same rules through one handler. Creating a
 * rule is an admin action, so callers render this only for an admin.
 *
 * Clicks are stopped at the trigger and the menu: the menu content is portaled
 * but React still bubbles its events to the row, and a row may navigate on click.
 */
export function NotificationMuteMenu({ notif }: { notif: NotificationItem }) {
    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6"
                    title="Mute options"
                    aria-label="Mute options"
                    onClick={(e) => e.stopPropagation()}
                >
                    <MoreHorizontal className="h-3 w-3" strokeWidth={1.5} />
                </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52" onClick={(e) => e.stopPropagation()}>
                {notif.category ? (
                    <DropdownMenuItem onClick={() => void createMuteFromNotification(notif, 'category')}>
                        Mute this category
                    </DropdownMenuItem>
                ) : null}
                <DropdownMenuItem onClick={() => void createMuteFromNotification(notif, 'similar')}>
                    Mute notifications like this
                </DropdownMenuItem>
                {notif.stack_name ? (
                    <DropdownMenuItem onClick={() => void createMuteFromNotification(notif, 'stack')}>
                        Mute this stack
                    </DropdownMenuItem>
                ) : null}
            </DropdownMenuContent>
        </DropdownMenu>
    );
}
