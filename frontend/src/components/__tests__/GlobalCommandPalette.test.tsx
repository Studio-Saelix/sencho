import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { Home, Radar } from 'lucide-react';
import type { Node } from '@/context/NodeContext';
import type { StackHit, FailedNode } from '@/hooks/useCrossNodeStackSearch';
import type { TopBarNavItem } from '../TopBar';

let hookReturn: { hits: StackHit[]; failedNodes: FailedNode[]; loading: boolean };
vi.mock('@/hooks/useCrossNodeStackSearch', () => ({
  useCrossNodeStackSearch: () => hookReturn,
}));

const setActiveNodeMock = vi.fn();
let nodesValue: { nodes: Node[]; activeNode: Node | null; setActiveNode: (n: Node) => void };
vi.mock('@/context/NodeContext', () => ({
  useNodes: () => nodesValue,
}));

import {
  GlobalCommandPaletteProvider,
  GlobalCommandPaletteTrigger,
  GlobalCommandPalette,
} from '../GlobalCommandPalette';

// cmdk scrolls the active item into view; jsdom has no scrollIntoView.
Element.prototype.scrollIntoView = () => {};

function node(id: number, name: string, status: Node['status'] = 'online'): Node {
  return {
    id,
    name,
    type: id === 1 ? 'local' : 'remote',
    compose_dir: '/compose',
    is_default: id === 1,
    status,
    created_at: 0,
  };
}

const navItems: TopBarNavItem[] = [
  { value: 'dashboard', label: 'Home', icon: Home },
  { value: 'fleet', label: 'Fleet', icon: Radar },
];

const onNavigate = vi.fn();
const onSelectStack = vi.fn();

function renderPalette() {
  return render(
    <GlobalCommandPaletteProvider>
      <GlobalCommandPaletteTrigger />
      <GlobalCommandPalette navItems={navItems} onNavigate={onNavigate} onSelectStack={onSelectStack} />
    </GlobalCommandPaletteProvider>,
  );
}

function open() {
  fireEvent.click(screen.getByLabelText('Open search (Ctrl+K)'));
}

function type(value: string) {
  fireEvent.change(screen.getByPlaceholderText('Search the app...'), { target: { value } });
}

beforeEach(() => {
  hookReturn = { hits: [], failedNodes: [], loading: false };
  nodesValue = {
    nodes: [node(1, 'local'), node(2, 'opsix')],
    activeNode: node(1, 'local'),
    setActiveNode: setActiveNodeMock,
  };
  onNavigate.mockReset();
  onSelectStack.mockReset();
  setActiveNodeMock.mockReset();
});

describe('GlobalCommandPalette', () => {
  it('opens on trigger click and lists Pages and Nodes', () => {
    renderPalette();
    open();
    expect(screen.getByText('Home')).toBeInTheDocument();
    expect(screen.getByText('Fleet')).toBeInTheDocument();
    expect(screen.getByText('local')).toBeInTheDocument();
    expect(screen.getByText('opsix')).toBeInTheDocument();
  });

  it('filters pages and nodes by substring (palette owns matching)', () => {
    renderPalette();
    open();
    type('fleet');
    expect(screen.getByText('Fleet')).toBeInTheDocument();
    expect(screen.queryByText('Home')).not.toBeInTheDocument();
    // 'fleet' matches no node name.
    expect(screen.queryByText('local')).not.toBeInTheDocument();
    expect(screen.queryByText('opsix')).not.toBeInTheDocument();
  });

  it('surfaces a single unreachable node, even with zero hits', () => {
    hookReturn = {
      hits: [],
      failedNodes: [{ nodeId: 2, nodeName: 'opsix', reason: 'list returned HTTP 502' }],
      loading: false,
    };
    renderPalette();
    open();
    type('zzz');
    expect(screen.getByText(/1 node unreachable/i)).toBeInTheDocument();
  });

  it('pluralises the unreachable-node count', () => {
    hookReturn = {
      hits: [],
      failedNodes: [
        { nodeId: 2, nodeName: 'opsix', reason: 'down' },
        { nodeId: 3, nodeName: 'edge', reason: 'down' },
      ],
      loading: false,
    };
    renderPalette();
    open();
    type('zzz');
    expect(screen.getByText(/2 nodes unreachable/i)).toBeInTheDocument();
  });

  it('shows stack hits and the unreachable line together (partial results)', () => {
    hookReturn = {
      hits: [{ nodeId: 2, nodeName: 'opsix', file: 'db.yml', status: 'running' }],
      failedNodes: [{ nodeId: 3, nodeName: 'edge', reason: 'down' }],
      loading: false,
    };
    renderPalette();
    open();
    type('db');
    expect(screen.getByText('db.yml')).toBeInTheDocument();
    expect(screen.getByText(/1 node unreachable/i)).toBeInTheDocument();
    // "No results." is suppressed: there are hits, and a node failed.
    expect(screen.queryByText('No results.')).not.toBeInTheDocument();
  });

  it('renders stack hits and caps the list with an overflow line', () => {
    const hits: StackHit[] = Array.from({ length: 55 }, (_, i) => ({
      nodeId: 2,
      nodeName: 'opsix',
      file: `s${i}.yml`,
      status: 'running',
    }));
    hookReturn = { hits, failedNodes: [], loading: false };
    renderPalette();
    open();
    type('s');
    expect(screen.getByText('Showing first 50 of 55')).toBeInTheDocument();
    expect(screen.getByText('s0.yml')).toBeInTheDocument();
    expect(screen.queryByText('s54.yml')).not.toBeInTheDocument();
  });

  it('navigates and closes when a page is selected', async () => {
    renderPalette();
    open();
    fireEvent.click(screen.getByText('Fleet'));
    expect(onNavigate).toHaveBeenCalledWith('fleet');
    // The animated dialog stays mounted briefly in jsdom; assert it left the
    // open state rather than depending on unmount timing.
    await waitFor(() => {
      const dialog = screen.queryByRole('dialog');
      expect(dialog?.getAttribute('data-state') ?? 'unmounted').not.toBe('open');
    });
  });

  it('closes the palette when Escape is pressed in the search input', async () => {
    renderPalette();
    open();
    const input = screen.getByPlaceholderText('Search the app...');
    fireEvent.keyDown(input, { key: 'Escape' });
    // Behavioral smoke test only: in jsdom Radix's dismissable layer already
    // closes a single-layer dialog on Escape, so this cannot isolate the
    // palette's own Escape handler from that fallback. The deterministic-close
    // regression the handler fixes (Escape dropped during streaming re-renders)
    // is guarded by the Playwright command-palette spec.
    await waitFor(() => {
      const dialog = screen.queryByRole('dialog');
      expect(dialog?.getAttribute('data-state') ?? 'unmounted').not.toBe('open');
    });
  });

  it('disables an offline node row', () => {
    nodesValue = {
      nodes: [node(1, 'local'), node(2, 'opsix', 'offline')],
      activeNode: node(1, 'local'),
      setActiveNode: setActiveNodeMock,
    };
    renderPalette();
    open();
    const row = screen.getByText('opsix').closest('[cmdk-item]');
    expect(row).toHaveAttribute('data-disabled', 'true');
  });

  it('shows "No results." when nothing matches and nothing is loading', () => {
    renderPalette();
    open();
    type('zzzz');
    expect(screen.getByText('No results.')).toBeInTheDocument();
  });

  it('shows "Searching..." while stacks load and nothing else matches', () => {
    hookReturn = { hits: [], failedNodes: [], loading: true };
    renderPalette();
    open();
    type('zzzz');
    expect(screen.getByText('Searching...')).toBeInTheDocument();
  });
});
