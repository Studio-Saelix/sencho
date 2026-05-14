import { parse as parseYaml } from 'yaml';
import type { BlueprintClassification } from './DatabaseService';

export interface AnalyzerResult {
    classification: BlueprintClassification;
    reasons: string[];
    hasNamedVolumes: boolean;
    hasBindMounts: boolean;
    hasExternalVolumes: boolean;
    hasTmpfsOnly: boolean;
    parseError?: string;
}

interface ComposeShape {
    services?: Record<string, ComposeService> | null;
    volumes?: Record<string, ComposeVolume | null> | null;
}

interface ComposeService {
    image?: string | null;
    volumes?: Array<string | ComposeServiceVolume> | null;
    tmpfs?: string | string[] | null;
}

interface ComposeServiceVolume {
    type?: string;
    source?: string;
    target?: string;
    bind?: { propagation?: string };
    volume?: { nocopy?: boolean };
}

interface ComposeVolume {
    external?: boolean | { name?: string };
    driver?: string;
    name?: string;
}

const STATEFUL_BIND_TARGETS = [
    '/var/lib',
    '/var/log',
    '/data',
    '/db',
    '/etc',
];

export class BlueprintAnalyzer {
    static analyze(composeContent: string): AnalyzerResult {
        const result: AnalyzerResult = {
            classification: 'unknown',
            reasons: [],
            hasNamedVolumes: false,
            hasBindMounts: false,
            hasExternalVolumes: false,
            hasTmpfsOnly: true,
        };

        let parsed: unknown;
        try {
            parsed = parseYaml(composeContent);
        } catch (err) {
            result.parseError = err instanceof Error ? err.message : String(err);
            result.classification = 'unknown';
            result.reasons.push('compose YAML did not parse');
            result.hasTmpfsOnly = false;
            return result;
        }

        if (parsed == null || typeof parsed !== 'object') {
            result.parseError = 'compose document is empty or not an object';
            result.classification = 'unknown';
            result.reasons.push('compose document is empty');
            result.hasTmpfsOnly = false;
            return result;
        }

        const doc = parsed as ComposeShape;
        if (!doc.services || Object.keys(doc.services).length === 0) {
            result.classification = 'unknown';
            result.reasons.push('compose document has no services');
            result.hasTmpfsOnly = false;
            return result;
        }

        const topVolumes = doc.volumes ?? {};
        const services = doc.services ?? {};

        const externalVolumeNames = new Set<string>();
        const declaredNamedVolumes = new Set<string>();
        for (const [volName, volDef] of Object.entries(topVolumes)) {
            if (volDef && typeof volDef === 'object' && 'external' in volDef && volDef.external) {
                externalVolumeNames.add(volName);
                result.hasExternalVolumes = true;
                result.reasons.push(`external volume "${volName}": Sencho cannot reason about portability`);
                result.hasTmpfsOnly = false;
            } else {
                declaredNamedVolumes.add(volName);
            }
        }

        let sawAnyMount = false;

        for (const [serviceName, serviceDef] of Object.entries(services)) {
            if (!serviceDef || typeof serviceDef !== 'object') continue;
            const volumes = serviceDef.volumes ?? [];
            for (const v of volumes) {
                sawAnyMount = true;
                if (typeof v === 'string') {
                    const parts = v.split(':');
                    const source = parts[0];
                    if (!source) continue;
                    if (source.startsWith('/') || source.startsWith('.') || source.startsWith('~')) {
                        result.hasBindMounts = true;
                        result.hasTmpfsOnly = false;
                        result.reasons.push(`bind mount "${source}" in service "${serviceName}"`);
                    } else if (externalVolumeNames.has(source)) {
                        // already accounted for in topVolumes loop
                    } else {
                        result.hasNamedVolumes = true;
                        result.hasTmpfsOnly = false;
                        result.reasons.push(`named volume "${source}" in service "${serviceName}"`);
                    }
                } else if (v && typeof v === 'object') {
                    const t = (v.type ?? '').toLowerCase();
                    const source = v.source ?? '';
                    if (t === 'bind') {
                        result.hasBindMounts = true;
                        result.hasTmpfsOnly = false;
                        result.reasons.push(`bind mount "${source}" in service "${serviceName}"`);
                    } else if (t === 'volume') {
                        if (externalVolumeNames.has(source)) {
                            // counted above
                        } else {
                            result.hasNamedVolumes = true;
                            result.hasTmpfsOnly = false;
                            result.reasons.push(`named volume "${source}" in service "${serviceName}"`);
                        }
                    } else if (t === 'tmpfs') {
                        // tmpfs is ephemeral; do not flip hasTmpfsOnly
                    } else if (source) {
                        // type omitted; fall back to source heuristic
                        if (source.startsWith('/') || source.startsWith('.') || source.startsWith('~')) {
                            result.hasBindMounts = true;
                            result.hasTmpfsOnly = false;
                            result.reasons.push(`bind mount "${source}" in service "${serviceName}"`);
                        } else {
                            result.hasNamedVolumes = true;
                            result.hasTmpfsOnly = false;
                            result.reasons.push(`named volume "${source}" in service "${serviceName}"`);
                        }
                    }
                }
            }
            const tmpfs = serviceDef.tmpfs;
            if (tmpfs && (typeof tmpfs === 'string' || Array.isArray(tmpfs))) {
                sawAnyMount = true;
                // tmpfs alone keeps hasTmpfsOnly true unless other mounts already flipped it
            }
        }

        if (!sawAnyMount) {
            result.hasTmpfsOnly = false;
        }

        // Classification rules (apply in order):
        // 1. Named volumes or bind mounts → stateful
        // 2. External volumes (no other persistence) → unknown (Sencho cannot prove portability)
        // 3. Only tmpfs or no volumes → stateless
        if (result.hasNamedVolumes || result.hasBindMounts) {
            result.classification = 'stateful';
        } else if (result.hasExternalVolumes) {
            result.classification = 'unknown';
        } else {
            result.classification = 'stateless';
            if (result.reasons.length === 0) {
                result.reasons.push('no persistent volumes detected');
            }
        }

        // Helpful annotation: if any bind mount targets a known stateful path, surface it
        for (const [serviceName, serviceDef] of Object.entries(services)) {
            if (!serviceDef || typeof serviceDef !== 'object') continue;
            for (const v of serviceDef.volumes ?? []) {
                if (typeof v !== 'string') continue;
                const parts = v.split(':');
                const target = parts[1];
                if (!target) continue;
                if (STATEFUL_BIND_TARGETS.some(prefix => target.startsWith(prefix))) {
                    result.reasons.push(`mount target "${target}" in service "${serviceName}" looks data-bearing`);
                }
            }
        }

        return result;
    }

    /**
     * Returns true when applying a new compose to an existing deployment would
     * destroy named volumes (rename or removal of a top-level named volume).
     * Used by the reconciler to downgrade Enforce → Suggest for volume-destroying
     * drift events on stateful blueprints.
     */
    static wouldDestroyVolumes(currentCompose: string, nextCompose: string): boolean {
        const current = BlueprintAnalyzer.extractNamedVolumes(currentCompose);
        const next = BlueprintAnalyzer.extractNamedVolumes(nextCompose);
        for (const name of current) {
            if (!next.has(name)) return true;
        }
        return false;
    }

    static extractImageRefs(composeContent: string): string[] {
        const doc = (parseYaml(composeContent) ?? {}) as ComposeShape;
        const services = doc.services ?? {};
        const seen = new Set<string>();
        const images: string[] = [];
        for (const serviceDef of Object.values(services)) {
            const image = typeof serviceDef?.image === 'string' ? serviceDef.image.trim() : '';
            if (!image || image.startsWith('sha256:') || seen.has(image)) continue;
            seen.add(image);
            images.push(image);
        }
        return images;
    }

    private static extractNamedVolumes(composeContent: string): Set<string> {
        try {
            const doc = (parseYaml(composeContent) ?? {}) as ComposeShape;
            const out = new Set<string>();
            for (const [name, def] of Object.entries(doc.volumes ?? {})) {
                if (def && typeof def === 'object' && 'external' in def && def.external) continue;
                out.add(name);
            }
            return out;
        } catch {
            return new Set();
        }
    }
}
