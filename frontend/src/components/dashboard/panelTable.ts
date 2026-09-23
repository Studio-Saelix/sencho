/**
 * Header row and cell classes for the shared Table primitives inside a panel.
 * Columns sit a compact gutter apart, while the outer cells keep the panel
 * header's 20px inset so text lines up with the title above it.
 */
const PANEL_CELL_GUTTERS = '[&>*]:px-2 [&>*:first-child]:pl-5 [&>*:last-child]:pr-5';
export const PANEL_TABLE_HEADER_ROW = `border-t border-b-0 border-border/60 hover:bg-transparent ${PANEL_CELL_GUTTERS}`;
export const PANEL_TABLE_HEAD =
  'h-auto whitespace-nowrap py-[var(--density-cell-y)] font-mono text-[10px] font-normal uppercase tracking-[0.22em] text-stat-subtitle';
export const PANEL_TABLE_ROW = `border-t border-b-0 border-border/40 hover:bg-transparent ${PANEL_CELL_GUTTERS}`;
/** A row that drills somewhere: the whole row takes a pointer click (see RowAction for keyboard access). */
export const PANEL_TABLE_ROW_ACTIONABLE = 'cursor-pointer transition-colors hover:bg-accent/5';
