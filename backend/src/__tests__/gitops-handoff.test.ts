/**
 * The accepted-generation contract: a portable, content-only projection of
 * a gitops_generations row, plus the target-dispatch boundary.
 */
import { describe, it, expect } from 'vitest';
import {
  buildAcceptedGeneration,
  BlueprintTargetAdapter,
  type AcceptedGeneration,
} from '../services/gitops/handoff';
import type { GitOpsGenerationRow } from '../services/gitops/types';

function baseRow(overrides: Partial<GitOpsGenerationRow> = {}): GitOpsGenerationRow {
  return {
    id: 'gen-1',
    application_id: 'app-1',
    commit_sha: 'a'.repeat(40),
    repo_url: 'https://github.com/example/repo.git',
    configured_ref: 'main',
    resolved_ref_kind: 'branch',
    repo_identity_json: '{"host":"github.com","pathname":"/example/repo.git"}',
    manifest_version: 4,
    candidate_dir: 'generations/candidate-a',
    applied_dir: 'generations/applied-a-0',
    expected_invocation_json: '{}',
    materialization_fingerprint: 'f'.repeat(64),
    validation_ok: 1,
    plan_blocked: 0,
    change_plan_fingerprint: 'fp-1',
    operation_id: 'op-1',
    trigger: 'manual',
    actor: 'tester',
    previous_generation_id: null,
    redacted_limitations_json: '[]',
    portable_manifest_json: null,
    compose_inputs_json: null,
    source_policy_evidence_json: null,
    security_policy_evidence_json: null,
    support_requirements_json: null,
    compatibility_requirements_json: null,
    created_at: 1,
    ...overrides,
  };
}

describe('buildAcceptedGeneration', () => {
  it('decodes identity and lineage fields directly from the row', () => {
    const gen = buildAcceptedGeneration(baseRow());
    expect(gen.contractVersion).toBe(1);
    expect(gen.generationId).toBe('gen-1');
    expect(gen.applicationId).toBe('app-1');
    expect(gen.repoIdentity).toEqual({ host: 'github.com', pathname: '/example/repo.git' });
    expect(gen.configuredRef).toBe('main');
    expect(gen.commitSha).toBe('a'.repeat(40));
    expect(gen.resolvedRefKind).toBe('branch');
    expect(gen.validationOk).toBe(true);
    expect(gen.trigger).toBe('manual');
    expect(gen.operationId).toBe('op-1');
  });

  it('records an explicit limitation for each missing portable field on a legacy row, never inventing evidence', () => {
    const gen = buildAcceptedGeneration(baseRow());
    expect(gen.portableManifest).toBeNull();
    expect(gen.composeInputs).toBeNull();
    expect(gen.sourcePolicyEvidence).toBeNull();
    expect(gen.limitations).toEqual(expect.arrayContaining([
      'portable_manifest_missing',
      'compose_inputs_missing',
      'source_policy_evidence_missing',
      'security_policy_evidence_missing',
      'support_requirements_missing',
      'compatibility_requirements_missing',
    ]));
  });

  it('decodes real evidence when the row carries it, recording no limitation for that field', () => {
    const gen = buildAcceptedGeneration(baseRow({
      portable_manifest_json: '{"files":[]}',
      compose_inputs_json: '{"composeFileOrder":["compose.yaml"]}',
    }));
    expect(gen.portableManifest).toEqual({ files: [] });
    expect(gen.composeInputs).toEqual({ composeFileOrder: ['compose.yaml'] });
    expect(gen.limitations).not.toContain('portable_manifest_missing');
    expect(gen.limitations).not.toContain('compose_inputs_missing');
  });

  it('refuses to build a contract from an unparseable repo identity', () => {
    expect(() => buildAcceptedGeneration(baseRow({ repo_identity_json: 'not json' }))).toThrow();
  });

  it('never populates secretCapability with a value, only its absence as capability metadata', () => {
    const gen = buildAcceptedGeneration(baseRow());
    expect(gen.secretCapability).toBeNull();
  });
});

// A future field on AcceptedGeneration named like a target-mode concept
// (selector, frozen target set, node id, rollout batch, target project
// name, local path, or secret value) must fail this compile, not merely
// this test run: the contract stays structurally content-only.
type AssertNoTargetModeFields<T> = T extends Record<
  'selector' | 'targetSet' | 'nodeId' | 'nodeIds' | 'rolloutBatch' | 'projectName' | 'candidateDir' | 'secretValue',
  unknown
> ? never : true;
const _structurallyContentOnly: AssertNoTargetModeFields<AcceptedGeneration> = true;
void _structurallyContentOnly;

describe('BlueprintTargetAdapter', () => {
  it('always returns a durable blocked result, never inspecting selectors or placement', async () => {
    const adapter = new BlueprintTargetAdapter();
    const gen = buildAcceptedGeneration(baseRow());
    const result = await adapter.dispatch(gen, { targetMode: 'blueprint', nodeId: null, bindingRevision: null });
    expect(result.status).toBe('blocked');
  });
});
