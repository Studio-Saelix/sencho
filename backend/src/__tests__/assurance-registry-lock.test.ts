/**
 * The compatibility lock: ids are permanent and a semantic change is a
 * deliberate edit.
 *
 * This file is meant to be boring to read and annoying to change. Adding a rule
 * appends to the lock at version 1; bumping what a rule detects, its default
 * severity, its finding class, or whether it affects the verdict means editing
 * its row here with the version bump. No locked id may disappear.
 */
import { describe, it, expect } from 'vitest';
import { ASSURANCE_RULES } from '../services/assurance/ruleRegistry';

interface LockRow {
  id: string;
  version: number;
  defaultSeverity: string;
  findingClass: string;
  affectsVerdict: boolean;
  status: string;
}

const LOCK: readonly (readonly [string, number, string, string, boolean, string])[] = [
  ['render-failed', 1, 'blocker', 'technical-blocker', true, 'active'],
  ['env-unset', 1, 'high', 'reliability', true, 'active'],
  ['env-literal-dollar', 1, 'high', 'reliability', true, 'active'],
  ['env-file-missing', 1, 'high', 'technical-blocker', true, 'active'],
  ['port-conflict-node', 1, 'blocker', 'technical-blocker', true, 'active'],
  ['port-conflict-internal', 1, 'blocker', 'technical-blocker', true, 'active'],
  ['port-exposed-all-interfaces', 1, 'high', 'exposure', true, 'active'],
  ['bind-path-missing', 1, 'high', 'reliability', true, 'active'],
  ['bind-path-permission', 1, 'warning', 'reliability', true, 'active'],
  ['docker-socket-mount', 1, 'high', 'security', true, 'active'],
  ['docker-socket-proxy', 1, 'info', 'information', true, 'active'],
  ['docker-socket-proxy-writable', 1, 'high', 'security', true, 'active'],
  ['docker-socket-proxy-published', 1, 'high', 'security', true, 'active'],
  ['docker-socket-proxy-mutating', 1, 'warning', 'security', true, 'active'],
  ['docker-socket-proxy-exposure', 1, 'warning', 'security', true, 'active'],
  ['docker-socket-proxy-client', 1, 'info', 'information', false, 'active'],
  ['privileged', 1, 'high', 'security', true, 'active'],
  ['network-mode-host', 1, 'high', 'security', true, 'active'],
  ['uid-gid-risk', 1, 'warning', 'reliability', true, 'active'],
  ['image-latest', 1, 'warning', 'change-risk', true, 'active'],
  ['no-restart-policy', 1, 'warning', 'reliability', true, 'active'],
  ['no-healthcheck', 1, 'warning', 'reliability', true, 'active'],
  ['healthcheck-disabled', 1, 'warning', 'reliability', true, 'active'],
  ['healthcheck-inherited', 1, 'info', 'information', false, 'active'],
  ['healthcheck-unverifiable', 1, 'info', 'information', true, 'active'],
  ['healthcheck-inconsistent', 1, 'warning', 'reliability', true, 'active'],
  ['deploy-swarm-only', 1, 'warning', 'portability', true, 'active'],
  ['node-state-unavailable', 1, 'info', 'information', true, 'active'],
  ['compose-version-mismatch', 1, 'info', 'information', false, 'active'],
  ['external-network-missing', 1, 'blocker', 'technical-blocker', true, 'active'],
  ['external-volume-missing', 1, 'blocker', 'technical-blocker', true, 'active'],
  ['new-network', 1, 'info', 'information', true, 'active'],
  ['new-volume', 1, 'info', 'information', true, 'active'],
  ['anonymous-volume', 1, 'info', 'information', true, 'active'],
  ['container-name-internal-dup', 1, 'blocker', 'technical-blocker', true, 'active'],
  ['container-name-collision', 1, 'blocker', 'technical-blocker', true, 'active'],
  ['exposure-internal-published', 1, 'high', 'exposure', true, 'active'],
  ['exposure-internal-tunneled', 1, 'high', 'exposure', true, 'active'],
  ['sensitive-service-broad-exposure', 1, 'high', 'exposure', true, 'active'],
  ['tunnel-exposure', 1, 'info', 'information', false, 'active'],
  ['exposure-unclassified', 1, 'warning', 'exposure', true, 'active'],
  ['exposure-port-vs-dossier', 1, 'warning', 'exposure', true, 'active'],
  ['reverse-proxy-undocumented', 1, 'warning', 'exposure', true, 'active'],
  ['effective-model-expanded', 1, 'info', 'information', true, 'active'],
  ['self-managed-stack', 1, 'warning', 'change-risk', true, 'active'],
  ['broad-host-bind-mount', 1, 'high', 'security', false, 'catalog'],
  ['public-database-port', 1, 'high', 'exposure', false, 'catalog'],
  ['root-user', 1, 'warning', 'security', false, 'catalog'],
  ['plaintext-secret', 1, 'high', 'security', false, 'catalog'],
  ['no-resource-limits', 1, 'info', 'reliability', false, 'catalog'],
  ['image-not-digest-pinned', 1, 'info', 'change-risk', false, 'catalog'],
  ['writable-root-filesystem', 1, 'warning', 'security', false, 'catalog'],
  ['default-capabilities', 1, 'warning', 'security', false, 'catalog'],
];

const locked = new Map<string, LockRow>(LOCK.map(row => [
  row[0],
  { id: row[0], version: row[1], defaultSeverity: row[2], findingClass: row[3], affectsVerdict: row[4], status: row[5] },
]));

describe('assurance registry lock', () => {
  it('matches every locked entry exactly', () => {
    const actual = ASSURANCE_RULES.map(rule => ({
      id: rule.id,
      version: rule.version,
      defaultSeverity: rule.defaultSeverity,
      findingClass: rule.findingClass,
      affectsVerdict: rule.affectsVerdict,
      status: rule.status,
    }));
    expect(actual).toEqual([...locked.values()]);
  });

  it('never drops a locked id', () => {
    const live: ReadonlySet<string> = new Set(ASSURANCE_RULES.map(rule => rule.id));
    const missing = [...locked.keys()].filter(id => !live.has(id));
    expect(missing).toEqual([]);
  });

  it('never reuses a locked id for a different rule', () => {
    for (const rule of ASSURANCE_RULES) {
      const row = locked.get(rule.id);
      expect(row, `${rule.id} is not in the lock`).toBeDefined();
      expect(rule.version).toBeGreaterThanOrEqual(1);
    }
  });
});
