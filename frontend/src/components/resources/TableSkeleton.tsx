import { TableBody, TableRow, TableCell } from '@/components/ui/table';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

/** Shared loading placeholder for the Resources page's tabbed tables (Images, Volumes, Rollback). */
export function TableSkeleton({ cols, rows = 5 }: { cols: number; rows?: number }) {
    return (
        <TableBody>
            {Array.from({ length: rows }).map((_, r) => (
                <TableRow key={r} className="animate-in fade-in-0" style={{ animationDelay: `${r * 40}ms` }}>
                    {Array.from({ length: cols }).map((_, c) => (
                        <TableCell key={c}>
                            <Skeleton className={cn('h-4', c === 0 ? 'w-24' : c === 1 ? 'w-48' : 'w-16')} />
                        </TableCell>
                    ))}
                </TableRow>
            ))}
        </TableBody>
    );
}
