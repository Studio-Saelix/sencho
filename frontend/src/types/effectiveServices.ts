/**
 * Per-service facts from the fully-merged effective Compose model, as
 * returned by `GET /api/stacks/:stackName/effective-services`. Mirrors
 * `backend/src/services/effectiveServiceModel.ts`; service-scoped update
 * gating (multi-service headers, eligible-for-update, rebuild vs update
 * wording, expected replica count) reads these fields.
 */
export interface EffectiveServiceSpec {
    name: string;
    declaredImage: string | null;
    hasBuild: boolean;
    /** May be 0 (explicit `scale: 0` or `deploy.replicas: 0`); defaults to 1 when neither is set. */
    expectedReplicas: number;
    dependsOn: string[];
    hasHealthcheck: boolean;
}

export type EffectiveServiceModelResult =
    | { renderable: true; services: EffectiveServiceSpec[] }
    | { renderable: false; code: 'effective_model_render_failed'; error: string };
