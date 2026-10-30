import { CheckCircle2, XCircle } from 'lucide-react';

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
  results: ResultRow[];
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

/** Per-node outcome rows. The Answer above carries the counts; this is the evidence behind it. */
export function ResultsList({ results }: ResultsListProps) {
  return (
    <div className="rounded border border-card-border/60 bg-card/40 px-3 py-2">
      {results.map((row) => <Row key={row.key} row={row} />)}
    </div>
  );
}
