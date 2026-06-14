/**
 * Shared mobile chrome: the chip row (App Store categories, Resources filters)
 * and the sub-tab scroller (Resources tabs, Audit Stream/Table). Both render a
 * value/label[/count] list, mark the active item, and report selection.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MobileChipRow, MobileSubTabs } from './mobile-ui';

describe('MobileChipRow', () => {
  const chips = [
    { value: 'All', label: 'All', count: 124 },
    { value: 'Media', label: 'Media', count: 28 },
    { value: 'Dev', label: 'Dev', count: 34 },
  ];

  it('renders every category chip with its count', () => {
    render(<MobileChipRow chips={chips} active="All" onSelect={vi.fn()} />);
    expect(screen.getByRole('button', { name: /Media/ })).toHaveTextContent('28');
    expect(screen.getAllByRole('button')).toHaveLength(3);
  });

  it('filters to the chosen category on click', () => {
    const onSelect = vi.fn();
    render(<MobileChipRow chips={chips} active="All" onSelect={onSelect} />);
    fireEvent.click(screen.getByRole('button', { name: /Dev/ }));
    expect(onSelect).toHaveBeenCalledWith('Dev');
  });

  it('cyan-fills the active chip only', () => {
    render(<MobileChipRow chips={chips} active="Media" onSelect={vi.fn()} />);
    expect(screen.getByRole('button', { name: /Media/ }).className).toContain('bg-brand');
    expect(screen.getByRole('button', { name: /Dev/ }).className).not.toContain('bg-brand');
  });
});

describe('MobileSubTabs', () => {
  const tabs = [
    { value: 'images', label: 'Images', count: 42 },
    { value: 'volumes', label: 'Volumes', count: 18 },
  ];

  it('marks the active tab and reports selection', () => {
    const onSelect = vi.fn();
    render(<MobileSubTabs tabs={tabs} active="images" onSelect={onSelect} ariaLabel="Resource sections" />);
    expect(screen.getByRole('tab', { name: /Images/ })).toHaveAttribute('aria-selected', 'true');
    fireEvent.click(screen.getByRole('tab', { name: /Volumes/ }));
    expect(onSelect).toHaveBeenCalledWith('volumes');
  });
});
