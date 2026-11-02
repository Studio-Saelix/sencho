/**
 * The Resources table's error row: a failed read says why when the cause is one
 * the operator can act on, and never reads as an empty table. On a phone the
 * tables scroll sideways, so the same copy is rendered as a block that wraps to
 * the viewport instead of a wide table cell.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TableLoadError, LoadErrorBlock } from '../TableSkeleton';

const REASON = '"edge-1" did not answer in time. Try again in a moment.';

describe('TableLoadError', () => {
  it('names the reason a node did not answer and offers Retry', async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    render(
      <table>
        <TableLoadError cols={4} noun="images" onRetry={onRetry} reason={REASON} />
      </table>,
    );

    expect(screen.getByText('Could not load images.')).toBeInTheDocument();
    expect(screen.getByText(REASON)).toBeInTheDocument();
    expect(screen.queryByText('No images found.')).toBeNull();
    await user.click(screen.getByRole('button', { name: /retry/i }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('keeps the short copy when there is no reason worth naming', () => {
    render(
      <table>
        <TableLoadError cols={4} noun="volumes" onRetry={vi.fn()} />
      </table>,
    );
    expect(screen.getByText('Could not load volumes.')).toBeInTheDocument();
  });
});

describe('LoadErrorBlock', () => {
  it('states the same failure outside a table, with the cause wrapping instead of clipping', async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    render(<LoadErrorBlock noun="images" onRetry={onRetry} reason={REASON} />);

    const headline = screen.getByText('Could not load images.');
    const reason = screen.getByText(REASON);
    // A wide table cell would lay the sentence out at the table's 640px width;
    // this block has no table ancestor and its cause may wrap mid-word.
    expect(headline.closest('table')).toBeNull();
    expect(reason.closest('table')).toBeNull();
    expect(reason).toHaveClass('break-words');

    await user.click(screen.getByRole('button', { name: /retry/i }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
