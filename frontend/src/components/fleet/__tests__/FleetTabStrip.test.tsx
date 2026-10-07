import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Tabs } from '@/components/ui/tabs';
import { FleetTabStrip } from '../FleetTabStrip';
import { buildFleetTabs } from '../fleetTabs';
import type { FleetTab } from '@/lib/events';
import type { FleetTabLayout } from '@/hooks/use-fleet-tab-layout';

const ADMIN = buildFleetTabs({ isAdmin: true, containerLabels: true, routing: false });

function renderStrip(layout: FleetTabLayout, active: FleetTab = 'overview', tabs = ADMIN) {
  const onChange = vi.fn();
  render(
    <Tabs value={active} onValueChange={(v) => onChange(v)}>
      <FleetTabStrip layout={layout} tabs={tabs} active={active} onChange={onChange} />
    </Tabs>,
  );
  return onChange;
}

const tabNames = () => screen.getAllByRole('tab').map(t => t.textContent);

describe('FleetTabStrip flat', () => {
  it('is one row of every tab with no group labels, the monitoring tabs first', () => {
    renderStrip('flat');
    expect(screen.queryByText('Observe')).not.toBeInTheDocument();
    expect(screen.queryByText('Operate')).not.toBeInTheDocument();
    expect(tabNames()).toEqual(['Overview', 'Readiness', 'Map', 'Docker Labels', 'Snapshots', 'Blueprints', 'Federation', 'Actions', 'Secrets']);
  });

  it('switches tabs with one click, including a tab after the separator', async () => {
    const onChange = renderStrip('flat');
    await userEvent.click(screen.getByRole('tab', { name: 'Federation' }));
    expect(onChange).toHaveBeenCalledWith('federation');
  });

  it('draws no separator when only the monitoring tabs are available', () => {
    renderStrip('flat', 'overview', ADMIN.filter(t => t.group === 'observe'));
    expect(document.querySelectorAll('span.w-px')).toHaveLength(0);
  });
});

describe('FleetTabStrip compact', () => {
  it('keeps five tabs on the strip and the rest under More', async () => {
    renderStrip('compact');
    expect(tabNames()).toEqual(['Overview', 'Readiness', 'Map', 'Blueprints', 'Actions']);
    await userEvent.click(screen.getByRole('button', { name: 'More tabs' }));
    expect((await screen.findAllByRole('menuitem')).map(i => i.textContent)).toEqual(['Docker Labels', 'Snapshots', 'Federation', 'Secrets']);
  });

  it('opens a tab from More', async () => {
    const onChange = renderStrip('compact');
    await userEvent.click(screen.getByRole('button', { name: 'More tabs' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Snapshots' }));
    expect(onChange).toHaveBeenCalledWith('snapshots');
  });

  it('shows the active tab that lives under More as the More trigger', () => {
    renderStrip('compact', 'secrets');
    expect(screen.getByRole('button', { name: 'More tabs, Secrets selected' })).toHaveTextContent('Secrets');
  });

  it('has no More menu when nothing is hidden', () => {
    renderStrip('compact', 'overview', ADMIN.filter(t => ['overview', 'readiness', 'dependencies', 'deployments', 'actions'].includes(t.value)));
    expect(screen.queryByRole('button', { name: /More tabs/ })).not.toBeInTheDocument();
  });
});

describe('FleetTabStrip keyboard', () => {
  it('moves through the tabs with the arrow keys, across the separator', async () => {
    renderStrip('flat');
    screen.getByRole('tab', { name: 'Overview' }).focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'Readiness' })).toHaveFocus();
    screen.getByRole('tab', { name: 'Docker Labels' }).focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'Snapshots' })).toHaveFocus();
    await userEvent.keyboard('{End}');
    expect(screen.getByRole('tab', { name: 'Secrets' })).toHaveFocus();
    await userEvent.keyboard('{Home}');
    expect(screen.getByRole('tab', { name: 'Overview' })).toHaveFocus();
  });

  it('keeps the compact More button out of the tab list, and still has a tab stop when the active tab is hidden', () => {
    renderStrip('compact', 'secrets');
    const stops = screen.getAllByRole('tab').filter(t => t.getAttribute('tabindex') === '0');
    expect(stops.length).toBeLessThanOrEqual(1);
    expect(screen.getByRole('button', { name: /More tabs/ }).closest('[role="tablist"]')).toBeNull();
  });
});

describe('FleetTabStrip separator', () => {
  const separators = () => document.querySelectorAll('span.w-px');

  it('puts one separator between the last monitoring tab and the first fleet-changing tab', () => {
    renderStrip('flat');
    expect(separators()).toHaveLength(1);
    expect(separators()[0].previousElementSibling).toHaveTextContent('Docker Labels');
    expect(separators()[0].nextElementSibling).toHaveTextContent('Snapshots');
  });

  it('still lands between the groups when the admin and label tabs are absent', () => {
    renderStrip('flat', 'overview', buildFleetTabs({ isAdmin: false, containerLabels: false, routing: false }));
    expect(separators()).toHaveLength(1);
    expect(separators()[0].previousElementSibling).toHaveTextContent('Map');
    expect(separators()[0].nextElementSibling).toHaveTextContent('Blueprints');
  });
});

describe('FleetTabStrip layout changes', () => {
  afterEach(() => { Element.prototype.scrollIntoView = undefined as unknown as Element['scrollIntoView']; });

  it('keeps the selected tab selected when the layout changes underneath it', () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <Tabs value="federation" onValueChange={onChange}>
        <FleetTabStrip layout="flat" tabs={ADMIN} active="federation" onChange={onChange} />
      </Tabs>,
    );
    expect(screen.getByRole('tab', { name: 'Federation' })).toHaveAttribute('aria-selected', 'true');
    rerender(
      <Tabs value="federation" onValueChange={onChange}>
        <FleetTabStrip layout="compact" tabs={ADMIN} active="federation" onChange={onChange} />
      </Tabs>,
    );
    expect(screen.getByRole('button', { name: 'More tabs, Federation selected' })).toBeInTheDocument();
    rerender(
      <Tabs value="federation" onValueChange={onChange}>
        <FleetTabStrip layout="flat" tabs={ADMIN} active="federation" onChange={onChange} />
      </Tabs>,
    );
    expect(screen.getByRole('tab', { name: 'Federation' })).toHaveAttribute('aria-selected', 'true');
  });

  it('scrolls the active tab into view when it changes', () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    const onChange = vi.fn();
    const { rerender } = render(
      <Tabs value="overview" onValueChange={onChange}>
        <FleetTabStrip layout="flat" tabs={ADMIN} active="overview" onChange={onChange} />
      </Tabs>,
    );
    scrollIntoView.mockClear();
    rerender(
      <Tabs value="secrets" onValueChange={onChange}>
        <FleetTabStrip layout="flat" tabs={ADMIN} active="secrets" onChange={onChange} />
      </Tabs>,
    );
    expect(scrollIntoView).toHaveBeenCalledWith({ inline: 'nearest', block: 'nearest' });
  });

  it('marks the current tab in the More menu', async () => {
    renderStrip('compact', 'snapshots');
    await userEvent.click(screen.getByRole('button', { name: /More tabs/ }));
    expect(await screen.findByRole('menuitem', { name: 'Snapshots' })).toHaveAttribute('aria-current', 'true');
    expect(screen.getByRole('menuitem', { name: 'Federation' })).not.toHaveAttribute('aria-current');
  });
});
