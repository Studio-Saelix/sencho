/**
 * The Pinned pill is compact by default and carries a muted tone. The node
 * details and updates sheets render it one step taller, so a caller's height
 * must win over the compact one.
 */
import { it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { PinnedUpdateBadge } from '../PinnedUpdateBadge';

it('renders compact with the muted tone by default', () => {
  render(<PinnedUpdateBadge reason="Pinned to a tag" />);
  const badge = screen.getByText('Pinned').closest('div');
  expect(badge).toHaveClass('h-4', 'shrink-0', 'bg-muted', 'text-muted-foreground');
  expect(badge).toHaveAttribute('title', 'Pinned to a tag');
});

it('lets the caller render it taller', () => {
  render(<PinnedUpdateBadge reason="Pinned to a tag" className="h-5 bg-muted" />);
  const badge = screen.getByText('Pinned').closest('div');
  expect(badge).toHaveClass('h-5', 'bg-muted');
  expect(badge).not.toHaveClass('h-4');
});
