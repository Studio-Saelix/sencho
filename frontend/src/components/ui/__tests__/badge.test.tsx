/**
 * Badge has a default size and a compact one for dense rows and inline
 * metadata pills. Lock the size classes so dense surfaces stop re-typing the
 * recipe, and so a caller can still override the height.
 */
import { it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Badge } from '../badge';

it('renders the default size when none is given', () => {
  render(<Badge>Default</Badge>);
  const badge = screen.getByText('Default');
  expect(badge).toHaveClass('px-2.5', 'py-0.5', 'text-xs');
  expect(badge).not.toHaveClass('h-4');
});

it('renders the compact size for dense rows', () => {
  render(<Badge size="compact">Compact</Badge>);
  const badge = screen.getByText('Compact');
  expect(badge).toHaveClass('h-4', 'px-1.5', 'py-0', 'text-[10px]', 'shrink-0');
  expect(badge).not.toHaveClass('px-2.5', 'text-xs');
});

it('lets a caller override the compact height', () => {
  render(<Badge size="compact" className="h-5">Taller</Badge>);
  const badge = screen.getByText('Taller');
  expect(badge).toHaveClass('h-5');
  expect(badge).not.toHaveClass('h-4');
});
