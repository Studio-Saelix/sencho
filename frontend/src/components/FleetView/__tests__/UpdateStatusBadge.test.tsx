import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import { UpdateStatusBadge } from '../UpdateStatusBadge';

describe('UpdateStatusBadge', () => {
  it('renders nothing for a null status', () => {
    const { container } = render(<UpdateStatusBadge status={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders the updating and completed states', () => {
    const { rerender } = render(<UpdateStatusBadge status="updating" />);
    expect(screen.getByText('Updating')).toBeInTheDocument();
    rerender(<UpdateStatusBadge status="completed" />);
    expect(screen.getByText('Updated')).toBeInTheDocument();
  });

  it('labels timeout and failed distinctly', () => {
    const { rerender } = render(<UpdateStatusBadge status="timeout" />);
    expect(screen.getByText('Timed out')).toBeInTheDocument();
    rerender(<UpdateStatusBadge status="failed" />);
    expect(screen.getByText('Failed')).toBeInTheDocument();
  });

  it('fires retry and dismiss handlers without bubbling the card click', () => {
    const onRetry = vi.fn();
    const onDismiss = vi.fn();
    render(<UpdateStatusBadge status="failed" error="pull error" onRetry={onRetry} onDismiss={onDismiss} />);

    fireEvent.click(screen.getByRole('button', { name: 'Retry update' }));
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
