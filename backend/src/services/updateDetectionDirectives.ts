/**
 * The one rule module for the per-service update detection labels
 * (`io.sencho.update.check`, `io.sencho.update.ignore`,
 * `io.sencho.update.changelog`). Pure: every scan, recheck, preview and
 * unattended trigger, local or hub-run, applies the labels through these
 * functions, so a service reads the same on every surface and transport.
 *
 * The labels decide what Sencho reports and what can start an unattended
 * update. They never change what an update pulls.
 */
import {
    parseSenchoUrl,
    parseUpdateIgnoreEntry,
    type SenchoLabelResolution,
    type UpdateIgnoreTarget,
} from '../helpers/senchoLabels';
import type { ImageUpdateDirectiveFacts, ImageUpdateStackFacts } from './imageUpdateFacts';
import { parseImageRef } from './registry-api';
import {
    computeSemverBump,
    resolveImageCheckStatus,
    uncertaintyReason,
    type ImageUpdateDetectResult,
    type TagEnumOutcome,
} from './imageUpdateDetect';
import type { ImageCheckResult } from './ImageUpdateService';

export type { UpdateIgnoreTarget };

export interface ServiceDetectionDirective {
    check: boolean;
    ignore: readonly UpdateIgnoreTarget[];
    changelogUrl: string | null;
}

/** Directives by service name. A service that is absent has the defaults. */
export type DetectionDirectives = ReadonlyMap<string, ServiceDetectionDirective>;

/** What a persisted service status says about the labels: checks off, or every pending update skipped. */
export type ServiceDetectionState = 'off' | 'ignored';

export const DEFAULT_DETECTION_DIRECTIVE: ServiceDetectionDirective = Object.freeze({
    check: true, ignore: Object.freeze([]) as readonly UpdateIgnoreTarget[], changelogUrl: null,
});

export const NO_DETECTION_DIRECTIVES: DetectionDirectives = new Map();

export function isDefaultDirective(directive: ServiceDetectionDirective): boolean {
    return directive.check && directive.ignore.length === 0 && directive.changelogUrl === null;
}

export function directiveFor(directives: DetectionDirectives, service: string): ServiceDetectionDirective {
    return directives.get(service) ?? DEFAULT_DETECTION_DIRECTIVE;
}

/**
 * The directives of a label resolution. A model that did not render, or a
 * resolution that could not be read, applies no label: every service keeps
 * the defaults, so a broken file never hides an update.
 */
export function directivesFromResolution(resolution: SenchoLabelResolution | null): DetectionDirectives {
    if (!resolution || !resolution.renderable) return NO_DETECTION_DIRECTIVES;
    const out = new Map<string, ServiceDetectionDirective>();
    for (const [service, labels] of Object.entries(resolution.services)) {
        const directive: ServiceDetectionDirective = {
            check: labels.updateCheck,
            ignore: labels.updateIgnore,
            changelogUrl: labels.updateChangelog,
        };
        if (!isDefaultDirective(directive)) out.set(service, directive);
    }
    return out;
}

/** One entry on the wire: a digest or a tag, as text. */
export function ignoreEntryText(entry: UpdateIgnoreTarget): string {
    return entry.kind === 'digest' ? entry.digest : entry.tag;
}

/** The wire projection of the directives, for services the model renders. */
export function directivesToFacts(directives: DetectionDirectives): ImageUpdateDirectiveFacts[] {
    return [...directives.entries()]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([service, directive]) => ({
            service,
            check: directive.check,
            ignore: directive.ignore.map(ignoreEntryText),
            changelogUrl: directive.changelogUrl,
        }));
}

/**
 * The directives a target reported, rebuilt with the same parsers the target
 * used. An entry or link this version cannot read is dropped, which reports
 * the update rather than hiding it.
 */
export function directivesFromFacts(facts: Pick<ImageUpdateStackFacts, 'directives'>): DetectionDirectives {
    if (!facts.directives) return NO_DETECTION_DIRECTIVES;
    const out = new Map<string, ServiceDetectionDirective>();
    for (const entry of facts.directives) {
        const ignore = entry.ignore
            .map(parseUpdateIgnoreEntry)
            .filter((target): target is UpdateIgnoreTarget => target !== null);
        const url = entry.changelogUrl === null ? null : parseSenchoUrl(entry.changelogUrl);
        const directive: ServiceDetectionDirective = {
            check: entry.check,
            ignore: ignore.length === entry.ignore.length ? ignore : [],
            changelogUrl: url && url.ok ? url.value : null,
        };
        if (!isDefaultDirective(directive)) out.set(entry.service, directive);
    }
    return out;
}

/**
 * The image refs no checking service uses: every service that owns the ref has
 * update checks off. A scan or preview does not ask the registry about them.
 * A ref with no owner in `services` is never in the result.
 */
export function uncheckedRefs(
    services: readonly { name: string; refs: readonly string[] }[],
    directives: DetectionDirectives,
): Set<string> {
    const checked = new Set<string>();
    const off = new Set<string>();
    for (const service of services) {
        const target = directiveFor(directives, service.name).check ? checked : off;
        for (const ref of service.refs) target.add(ref);
    }
    for (const ref of checked) off.delete(ref);
    return off;
}

function tagOutcomeOf(kind: ImageUpdateDetectResult['tagEnumKind']): TagEnumOutcome {
    switch (kind) {
        case 'complete': return { kind: 'complete', tags: [] };
        case 'incomplete': return { kind: 'incomplete', tags: [], reason: '' };
        case 'error': return { kind: 'error', reason: '' };
        default: return { kind: 'skipped' };
    }
}

function skipsDigest(ignore: readonly UpdateIgnoreTarget[], digest: string | null): boolean {
    if (!digest) return false;
    const wanted = digest.toLowerCase();
    return ignore.some(entry => entry.kind === 'digest' && entry.digest === wanted);
}

function skipsTag(ignore: readonly UpdateIgnoreTarget[], tag: string | null): boolean {
    if (!tag) return false;
    return ignore.some(entry => entry.kind === 'tag' && entry.tag === tag);
}

/** The pending candidates of a detection: the rebuild's digest and the newer tag, when known. */
function candidatesOf(result: ImageUpdateDetectResult): { digest: string | null; tag: string | null } {
    return {
        digest: result.digestUpdate ? result.candidateDigest : null,
        tag: result.tagUpdate ? result.nextTag : null,
    };
}

/**
 * Clear the candidates a service skips. Only a matched candidate is cleared;
 * `hasUpdate` stays `digestUpdate || tagUpdate`. The check status is recomputed
 * with the skipped digest read as a match and the skipped tag as no newer tag,
 * so a failed tag listing still reads `partial`, never a false "up to date". A
 * digest entry never matches when the candidate digest is unknown.
 */
export function applyIgnore(
    result: ImageUpdateDetectResult,
    ignore: readonly UpdateIgnoreTarget[],
    currentTag: string,
): { result: ImageUpdateDetectResult; ignored: boolean } {
    if (ignore.length === 0 || result.checkStatus === 'not_checkable') return { result, ignored: false };
    const candidates = candidatesOf(result);
    const digestSkipped = skipsDigest(ignore, candidates.digest);
    const tagSkipped = skipsTag(ignore, candidates.tag);
    if (!digestSkipped && !tagSkipped) return { result, ignored: false };

    const digestUpdate = result.digestUpdate && !digestSkipped;
    const tagUpdate = result.tagUpdate && !tagSkipped;
    const hasUpdate = digestUpdate || tagUpdate;
    const digestKind = digestUpdate ? 'update' : digestSkipped || !result.digestError ? 'match' : 'error';
    const checkStatus = resolveImageCheckStatus({
        digest: digestKind,
        tagApplicable: result.tagEnumKind !== 'skipped',
        tagOutcome: tagOutcomeOf(result.tagEnumKind),
        hasUpdate,
    });
    const nextTag = tagUpdate ? result.nextTag : digestUpdate ? currentTag : null;
    return {
        ignored: true,
        result: {
            ...result,
            hasUpdate,
            digestUpdate,
            tagUpdate,
            nextTag,
            semverBump: tagUpdate ? computeSemverBump(currentTag, nextTag) : digestUpdate ? 'patch' : 'none',
            candidateDigest: digestUpdate ? result.candidateDigest : null,
            checkStatus,
            reason: uncertaintyReason(checkStatus, result.digestError, result.tagEnumReason),
        },
    };
}

/** The scanner's check result for a detection, with the detection kept for the label rules. */
export function checkResultFromDetection(detection: ImageUpdateDetectResult): ImageCheckResult {
    if (detection.checkStatus === 'not_checkable') {
        return { hasUpdate: false, checkStatus: 'not_checkable', notCheckable: true };
    }
    return {
        hasUpdate: detection.hasUpdate,
        digestUpdate: detection.digestUpdate,
        tagUpdate: detection.tagUpdate,
        checkStatus: detection.checkStatus,
        ...(detection.reason ? { error: detection.reason } : {}),
        detection,
    };
}

/** `applyIgnore` over a scanner check result. A result without its detection is returned unchanged. */
export function applyIgnoreToCheck(
    ref: string,
    check: ImageCheckResult,
    ignore: readonly UpdateIgnoreTarget[],
): { result: ImageCheckResult; ignored: boolean } {
    if (!check.detection || ignore.length === 0) return { result: check, ignored: false };
    const applied = applyIgnore(check.detection, ignore, parseImageRef(ref)?.tag ?? '');
    return applied.ignored
        ? { result: checkResultFromDetection(applied.result), ignored: true }
        : { result: check, ignored: false };
}

/** Why an unattended trigger does not count an image's update. */
export type TriggerSuppression = 'off' | 'ignored';

export interface TriggerRefResult {
    result: ImageCheckResult;
    /** Set when the image had a pending update that no owner reports. */
    suppressed: TriggerSuppression | null;
}

/**
 * Whether an image's update can start an unattended update. It counts unless
 * every service that owns the image has checks off or skips that candidate.
 * A check error passes through untouched, so an unverified image still blocks
 * a whole-stack update. A ref with no known owner always counts.
 */
export function triggerResultForRef(
    ref: string,
    owners: readonly string[],
    result: ImageCheckResult,
    directives: DetectionDirectives,
): TriggerRefResult {
    if (owners.length === 0 || (!result.digestUpdate && !result.tagUpdate)) return { result, suppressed: null };
    let digest = false;
    let tag = false;
    for (const owner of owners) {
        const directive = directiveFor(directives, owner);
        if (!directive.check) continue;
        const applied = applyIgnoreToCheck(ref, result, directive.ignore).result;
        digest ||= applied.digestUpdate === true;
        tag ||= applied.tagUpdate === true;
    }
    const suppressedDigest = result.digestUpdate === true && !digest;
    const suppressedTag = result.tagUpdate === true && !tag;
    if (!suppressedDigest && !suppressedTag) return { result, suppressed: null };
    return {
        suppressed: hasIgnoreMatch(ref, owners, result, directives) ? 'ignored' : 'off',
        result: {
            ...result,
            digestUpdate: result.digestUpdate === true && digest,
            tagUpdate: result.tagUpdate === true && tag,
            hasUpdate: (result.digestUpdate === true && digest) || (result.tagUpdate === true && tag),
        },
    };
}

function hasIgnoreMatch(
    ref: string,
    owners: readonly string[],
    result: ImageCheckResult,
    directives: DetectionDirectives,
): boolean {
    return owners.some(owner => {
        const directive = directiveFor(directives, owner);
        return directive.check && applyIgnoreToCheck(ref, result, directive.ignore).ignored;
    });
}
