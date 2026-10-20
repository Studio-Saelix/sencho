import { TableBody, TableRow, TableCell } from '@/components/ui/table';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
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

/** Distinct from the empty state: the request failed, so say so and offer the retry. */
export function TableLoadError({ cols, noun, onRetry }: { cols: number; noun: string; onRetry: () => void }) {
    return (
        <TableBody>
            <TableRow className="hover:bg-transparent">
                <TableCell colSpan={cols} className="py-8 text-center">
                    <p className="mb-3 text-sm text-muted-foreground">Could not load {noun}.</p>
                    <Button variant="outline" size="sm" onClick={onRetry}>Retry</Button>
                </TableCell>
            </TableRow>
        </TableBody>
    );
}
