import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { GitOpsDriftItem } from '@/types/gitops';
import GitOpsDriftRow from './GitOpsDriftRow';

/**
 * The invocation class is the first drift item whose two sides are the same
 * kind of thing under two different identity kinds: what the generation was
 * applied with, and what the node reported. Both have to render as a file list,
 * or the row shows one side as a file order and the other as something the
 * reader has to decode.
 */
const invocationItem: GitOpsDriftItem = {
  class: 'invocation',
  expected: {
    kind: 'invocation',
    authored: {
      composeFileOrder: ['compose.yaml', 'compose.override.yaml'],
      projectName: 'web',
      projectDirectory: '.',
      envFileOrder: [],
    },
  },
  observed: {
    kind: 'observed_invocation',
    observed: {
      composeFileOrder: ['compose.override.yaml', 'compose.yaml'],
      projectName: 'web',
      projectDirectory: '.',
      envFileOrder: [],
    },
    observedAt: 1_700_000_000_000,
  },
  freshnessAt: 1_700_000_000_000,
  owner: 'ComposeService',
  reason: 'the compose invocation on this node is not the one this generation was applied with',
  configuredPolicy: null,
  affectedTargets: [{ nodeId: 1, stackName: 'web' }],
  action: 'none',
};

describe('GitOpsDriftRow', () => {
  it('shows both sides of an invocation item as the file orders they are', () => {
    render(<GitOpsDriftRow item={invocationItem} />);
    expect(screen.getByText('invocation')).toBeInTheDocument();
    expect(screen.getByText('ComposeService')).toBeInTheDocument();
    expect(screen.getByText('compose.yaml, compose.override.yaml')).toBeInTheDocument();
    // The observed side is the same order reversed, so a reader sees which
    // one moved without the two sides reading as different kinds of thing.
    expect(screen.getByText('compose.override.yaml, compose.yaml')).toBeInTheDocument();
    expect(screen.getByText('expected')).toBeInTheDocument();
    expect(screen.getByText('→ observed')).toBeInTheDocument();
  });

  it('names the reason rather than leaving the reader to infer the difference', () => {
    render(<GitOpsDriftRow item={invocationItem} />);
    expect(screen.getByText(/compose invocation on this node is not the one/)).toBeInTheDocument();
  });

  it('renders a runtime item without an invocation side appearing', () => {
    render(<GitOpsDriftRow item={{
      ...invocationItem,
      class: 'runtime',
      expected: { kind: 'generation', id: 'gen-12345678' },
      observed: { kind: 'generation', id: 'gen-87654321' },
    }} />);
    expect(screen.getByText('runtime')).toBeInTheDocument();
    expect(screen.getByText('generation gen-1234')).toBeInTheDocument();
    expect(screen.getByText('generation gen-8765')).toBeInTheDocument();
  });
});
