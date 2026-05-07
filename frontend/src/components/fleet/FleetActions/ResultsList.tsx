import { CheckCircle2, XCircle, MinusCircle } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';

export interface ResultRow {
  key: string;
  label: string;
  success: boolean;
  error?: string;
  /** Optional secondary rows nested under this row (e.g. per-stack results
   *  underneath a per-node row in the fleet-stop view). */
  sub?: ResultRow[];
}

interface ResultsListProps {
  title?: string;
  results: ResultRow[];
  /** Override the empty-state message when there is nothing to render yet. */
  emptyHint?: string;
}

function Row({ row, indent = 0 }: { row: ResultRow; indent?: number }) {
  const Icon = row.success ? CheckCircle2 : XCircle;
  const tone = row.success ? 'text-success' : 'text-destructive';
  return (
    <>
      <div
        className="flex items-start gap-2 py-1 text-sm"
        style={indent ? { paddingLeft: `${indent * 16}px` } : undefined}
      >
        <Icon className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${tone}`} strokeWidth={1.5} />
        <span className="font-mono text-xs text-stat-value">{row.label}</span>
        {row.error && (
          <span className="text-xs text-stat-subtitle truncate">· {row.error}</span>
        )}
      </div>
      {row.sub?.map((child) => <Row key={child.key} row={child} indent={indent + 1} />)}
    </>
  );
}

export function ResultsList({ title, results, emptyHint }: ResultsListProps) {
  const succeeded = results.filter(r => r.success).length;
  const failed = results.length - succeeded;
  return (
    <Card className="bg-card shadow-card-bevel mt-4">
      <CardContent className="p-4">
        <div className="flex items-center gap-2 mb-3">
          <span className="text-xs font-medium uppercase tracking-wide text-stat-subtitle">
            {title ?? 'Results'}
          </span>
          {results.length > 0 ? (
            <>
              <Badge variant="outline" className="text-[10px] font-normal py-0 px-1.5 text-success">
                {succeeded} ok
              </Badge>
              {failed > 0 && (
                <Badge variant="outline" className="text-[10px] font-normal py-0 px-1.5 text-destructive">
                  {failed} failed
                </Badge>
              )}
            </>
          ) : (
            <span className="text-xs text-stat-subtitle inline-flex items-center gap-1">
              <MinusCircle className="h-3 w-3" strokeWidth={1.5} />
              {emptyHint ?? 'No results yet.'}
            </span>
          )}
        </div>
        <div className="space-y-0">
          {results.map((row) => <Row key={row.key} row={row} />)}
        </div>
      </CardContent>
    </Card>
  );
}
