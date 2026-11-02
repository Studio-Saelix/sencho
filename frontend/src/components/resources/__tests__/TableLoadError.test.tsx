/**
 * The Resources table's error row: a failed read says why when the cause is one
 * the operator can act on, and never reads as an empty table.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TableLoadError } from '../TableSkeleton';

describe('TableLoadError', () => {
  it('names the reason a node did not answer and offers Retry', async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    render(
      <table>
        <TableLoadError cols={4} noun="images" onRetry={onRetry} reason='"edge-1" did not answer in time.' />
      </table>,
    );

    expect(screen.getByText('Could not load images.')).toBeInTheDocument();
    expect(screen.getByText('"edge-1" did not answer in time.')).toBeInTheDocument();
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
