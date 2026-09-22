/**
 * Label/verdict rules for the GitOps portfolio surface (lib/gitopsPortfolio.ts).
 *
 * The masthead claims are what operators act on at a glance, so these tests pin
 * the honesty rules the issue demands: failure outranks everything, an
 * unproven portfolio never reads as healthy, and qualitatively-known
 * convergence stays a distinct statement from exact convergence.
 */
import { describe, expect, it } from 'vitest';
import { attentionLabel, portfolioMastheadState } from './gitopsPortfolio';

describe('portfolioMastheadState', () => {
  const summary = {
    failed: 0,
    attentionRequired: 0,
    inProgress: 0,
    converged: 2,
    convergedQualified: 1,
    unknown: 0,
    applications: 3,
  };

  it('is Converged only when every application is provably converged', () => {
    expect(portfolioMastheadState(summary, false).state).toBe('Converged');
  });

  it('keeps In progress visible instead of overclaiming convergence', () => {
    expect(portfolioMastheadState({ ...summary, inProgress: 1 }, false).state).toBe('In progress');
  });

  it('never reads qualified-only convergence as exact convergence', () => {
    const qualifiedOnly = { ...summary, converged: 0, convergedQualified: 3 };
    expect(portfolioMastheadState(qualifiedOnly, false).state).toBe('Converged · qualified');
    // Any exact convergence earns the plain verdict; the counts still show the
    // split in the metadata strip.
    expect(portfolioMastheadState({ ...qualifiedOnly, converged: 1 }, false).state).toBe('Converged');
  });

  it('reads unknown evidence as Partially known, not healthy', () => {
    expect(portfolioMastheadState({ ...summary, unknown: 1 }, false).state).toBe('Partially known');
  });

  it('reads pending decisions before progress', () => {
    expect(portfolioMastheadState({ ...summary, inProgress: 2, attentionRequired: 1 }, false).state).toBe('Needs attention');
  });

  it('reads failures before anything else', () => {
    expect(portfolioMastheadState({ ...summary, failed: 1, attentionRequired: 3 }, false).state).toBe('Needs action');
  });

  it('reads an empty portfolio with failed coverage as Unknown', () => {
    expect(portfolioMastheadState({ ...summary, applications: 0 }, true).state).toBe('Unknown');
    expect(portfolioMastheadState({ ...summary, applications: 0 }, false).state).toBe('No applications');
  });
});

describe('attentionLabel', () => {
  it('renders a known reason with its copy and tone', () => {
    expect(attentionLabel('source_failed').tone).toBe('destructive');
    expect(attentionLabel('source_failed').label).toBe('source failed');
  });

  it('renders a reason this build never heard of as its raw code, not a blank', () => {
    const future = attentionLabel('quantum_entanglement_required');
    expect(future.label).toBe('quantum entanglement required');
    expect(future.tone).toBe('warning');
    expect(future.line).toContain('does not know');
  });
});
