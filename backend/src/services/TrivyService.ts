import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import os from 'os';
import path from 'path';
import DockerController from './DockerController';
import {
    DatabaseService,
    VulnSeverity,
    VulnScanTrigger,
    VulnerabilityScan,
    parsePolicyEvaluation,
} from './DatabaseService';
import { FileSystemService } from './FileSystemService';
import { RegistryService } from './RegistryService';
import { disableCapability, enableCapability } from './CapabilityRegistry';
import { sanitizeForLog } from '../utils/safeLog';
import TrivyInstaller, { type TrivySource } from './TrivyInstaller';
import { FleetSyncService } from './FleetSyncService';
import { getErrorMessage } from '../utils/errors';
import { isDebugEnabled } from '../utils/debug';
import { SEVERITY_ORDER } from '../utils/severity';
import { isSenchoRollbackHoldRef } from '../utils/senchoRollbackHold';
import type { PolicyBlockReason } from '../utils/policy-risk';
import {
    canonicalPlatformLabel,
    DEFAULT_ARCHITECTURE_VARIANT,
    imagePlatformLabel,
    platformCacheKey,
} from './gitops/platformNames';
import { parseImageRef, selectLocalRepoDigests } from './registry-api';

const execFileAsync = promisify(execFile);

const SCAN_TIMEOUT_MS = 5 * 60 * 1000;
const SBOM_TIMEOUT_MS = 3 * 60 * 1000;
export const DIGEST_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_SCAN_ALL_MAX_IMAGES = 100;
const DEFAULT_SCAN_ALL_MAX_DURATION_MS = 30 * 60 * 1000;

const TRIVY_TEMP_DIR_PREFIX = 'sencho-trivy-';
const TRIVY_TEMP_DIR_MAX_AGE_MS = 60 * 60 * 1000; // 1 hour

/**
 * How long a vulnerability-database reading is reused before asking Trivy again.
 * Short, because the reading only exists to decide whether a cached scan may be
 * trusted, and a stale reading could authorise a row the current database has
 * already superseded.
 */
const VULN_DB_INFO_TTL_MS = 60 * 1000;

/** The Trivy vulnerability database build the findings were produced against. */
export interface VulnerabilityDbInfo {
    /** Epoch ms of the database build (`VulnerabilityDB.UpdatedAt`). */
    updatedAt: number;
    /** Epoch ms after which Trivy expects a newer database, or null when it does not say. */
    nextUpdate: number | null;
    /** When this reading was taken. */
    readAt: number;
}

/**
 * Options for one image scan.
 *
 * `scanRef` decouples the reference handed to Trivy from the reference the scan
 * row is keyed and displayed by. The deploy gate scans `repo@sha256:<digest>` (the
 * image that update would install) while the row keeps the authored tag, so
 * History, compare and per-image retention keep reading one identity per tag.
 */
export interface ImageScanOptions {
    useCache?: boolean;
    digest?: string | null;
    /**
     * The platform of the image being scanned (`linux/amd64`, ...), when the
     * caller already resolved it. The deploy gate's cache is keyed by digest and
     * platform, so a multi-arch ref's children cannot answer for each other. An
     * installed scan that names no child leaves this unset and the service reads
     * the platform of the local image; when that cannot be read, the gate's cache
     * is bypassed rather than letting an unqualified row answer.
     *
     * When it is set for an installed reference (`scanRef` and `digest` absent),
     * the platform is a promise about the child the operation will run: the scan
     * reads that child or fails, and the row is never written under a platform
     * the scan did not report.
     */
    platform?: string | null;
    scanners?: readonly TrivyScanner[];
    /** The exact reference handed to `trivy image`; defaults to `imageRef`. */
    scanRef?: string;
    /**
     * Cache reuse rule. `digest` (the default, and every path except the deploy
     * gate) reuses a completed row for the digest and, when the platform is
     * known, that child, inside the TTL. `database` additionally requires the
     * row to have come from the current, not-yet-due vulnerability database,
     * because findings from an older database can miss a CVE the operator's
     * policy would have blocked.
     */
    cacheRule?: 'digest' | 'database';
}

/**
 * Sweep leftover sencho-trivy-* temp dirs in the system tmp dir whose mtime
 * is older than 1 hour. Runs once at service boot to clean up DOCKER_CONFIG
 * dirs orphaned by a crashed scan process. Best-effort; swallows readdir or
 * unlink failures so a quirky tmp dir cannot block startup.
 */
export async function sweepStaleTrivyTempDirs(): Promise<void> {
    const tmp = os.tmpdir();
    let entries: string[];
    try {
        entries = await fs.promises.readdir(tmp);
    } catch {
        return;
    }
    const cutoff = Date.now() - TRIVY_TEMP_DIR_MAX_AGE_MS;
    let removed = 0;
    for (const entry of entries) {
        if (!entry.startsWith(TRIVY_TEMP_DIR_PREFIX)) continue;
        const full = path.join(tmp, entry);
        try {
            const stat = await fs.promises.stat(full);
            if (stat.mtimeMs < cutoff) {
                await fs.promises.rm(full, { recursive: true, force: true });
                removed++;
            }
        } catch {
            /* race: dir already gone, or permissions; skip */
        }
    }
    if (removed > 0) {
        console.log(`[Trivy] Reaped ${removed} stale tmp dir(s) under ${tmp}`);
    }
}

function diag(msg: string, ...args: unknown[]): void {
    if (isDebugEnabled()) console.log(`[Trivy:diag] ${sanitizeForLog(msg)}`, ...args);
}

interface TrivyRawVulnerability {
    VulnerabilityID?: string;
    PkgName?: string;
    PkgPath?: string;
    PkgIdentifier?: { PURL?: string };
    InstalledVersion?: string;
    FixedVersion?: string;
    Status?: string;
    Severity?: string;
    Title?: string;
    Description?: string;
    PrimaryURL?: string;
    Layer?: { Digest?: string; DiffID?: string };
    VendorSeverity?: Record<string, number>;
    CVSS?: Record<string, { V3Vector?: string; V3Score?: number }>;
}

interface TrivyRawSecret {
    RuleID?: string;
    Category?: string;
    Severity?: string;
    Title?: string;
    StartLine?: number;
    EndLine?: number;
    Match?: string;
}

interface TrivyRawMisconfig {
    ID?: string;
    AVDID?: string;
    Type?: string;
    Severity?: string;
    Title?: string;
    Description?: string;
    Message?: string;
    Resolution?: string;
    PrimaryURL?: string;
}

interface TrivyRawResult {
    Target?: string;
    Vulnerabilities?: TrivyRawVulnerability[];
    Secrets?: TrivyRawSecret[];
    Misconfigurations?: TrivyRawMisconfig[];
}

interface TrivyRawOutput {
    Metadata?: {
        OS?: { Family?: string; Name?: string };
        ImageID?: string;
        RepoDigests?: string[];
        /**
         * The image config Trivy actually analysed. Its `os` and `architecture`
         * are the platform the findings describe, whichever source Trivy used.
         */
        ImageConfig?: {
            os?: unknown;
            architecture?: unknown;
            variant?: unknown;
        };
    };
    Results?: TrivyRawResult[];
}

export interface ScanAllNodeImagesSeverityTotals {
    critical: number;
    high: number;
    medium: number;
    low: number;
    unknown: number;
}

export interface ScanAllNodeImagesViolation {
    imageRef: string;
    scanId: number;
    severity: VulnSeverity;
    policyName: string;
    maxSeverity: VulnSeverity;
    // Inputs that matched (severity / kev / fixable), so the scheduled-scan
    // alert names the reason rather than always citing a severity threshold.
    reasons: PolicyBlockReason[];
}

export interface ScanAllNodeImagesResult {
    scanned: number;
    skipped: number;
    failed: number;
    totalImages?: number;
    processedImages?: number;
    truncated?: boolean;
    limitReason?: string;
    severity: ScanAllNodeImagesSeverityTotals;
    /**
     * Policy violations observed across the freshly-scanned or cached rows.
     * The scheduler uses this to dispatch alerts without re-querying the DB.
     */
    violations: ScanAllNodeImagesViolation[];
}

/** Which scan types a node-wide scan should run. At least one must be true. */
export interface ScanNodeOptions {
    vulns: boolean;
    secrets: boolean;
    misconfig: boolean;
}

/** Combined result of a node-wide scan (images for vuln/secret + stacks for misconfig). */
export interface ScanNodeResult {
    /** Image scan totals, or null when neither vuln nor secret scanning ran. */
    images: ScanAllNodeImagesResult | null;
    /** Stack misconfig totals, or null when misconfig scanning did not run. */
    stacks: { scanned: number; failed: number; total: number } | null;
    /** Severity totals across images AND stacks (a superset of `images.severity`). */
    severity: ScanAllNodeImagesSeverityTotals;
    /** Policy violations; only image scans contribute, stacks never do. */
    violations: ScanAllNodeImagesViolation[];
}

export interface TrivyVulnerability {
    vulnerabilityId: string;
    pkgName: string;
    installedVersion: string;
    fixedVersion: string | null;
    severity: VulnSeverity;
    title: string;
    description: string;
    primaryUrl: string | null;
    // Scan-intrinsic enrichment Trivy returns per finding. These separate scary
    // from exploitable: `status` (fixed / will_not_fix / end_of_life / ...) drives
    // posture, the others power evidence tags. Captured here, joined with
    // time-varying intel (KEV/EPSS) only at read time.
    status: string | null;
    cvssScore: number | null;
    cvssVector: string | null;
    cvssSource: string | null;
    vendorSeverity: VulnSeverity | null;
    purl: string | null;
    pkgPath: string | null;
    layerDigest: string | null;
}

export interface TrivySecret {
    ruleId: string;
    category: string | null;
    severity: VulnSeverity;
    title: string | null;
    target: string;
    startLine: number | null;
    endLine: number | null;
    matchExcerpt: string | null;
}

export interface TrivyMisconfig {
    ruleId: string;
    checkId: string | null;
    severity: VulnSeverity;
    title: string | null;
    message: string | null;
    resolution: string | null;
    target: string;
    primaryUrl: string | null;
}

export type TrivyScanner = 'vuln' | 'secret';

export interface TrivyScanResult {
    imageRef: string;
    imageDigest: string | null;
    /** The platform of the image these findings describe, when known. */
    platform?: string | null;
    scannedAt: number;
    totalVulnerabilities: number;
    criticalCount: number;
    highCount: number;
    mediumCount: number;
    lowCount: number;
    unknownCount: number;
    fixableCount: number;
    secretCount: number;
    scannersUsed: string;
    highestSeverity: VulnSeverity | null;
    vulnerabilities: TrivyVulnerability[];
    secrets: TrivySecret[];
    metadata: {
        os: string | null;
        trivyVersion: string | null;
        scanDurationMs: number;
    };
    /**
     * True when these findings came from a stored row rather than a scan that
     * just ran. The database revision is then the cached row's, never the one
     * Trivy holds now: the findings predate whatever database was downloaded
     * since, and stamping the current build on them would claim otherwise.
     */
    fromCache?: boolean;
    /** The database build the findings came from, when the row recorded one. */
    databaseUpdatedAt?: number | null;
}

export interface TrivyComposeScanResult {
    stackName: string;
    scannedAt: number;
    highestSeverity: VulnSeverity | null;
    criticalCount: number;
    highCount: number;
    mediumCount: number;
    lowCount: number;
    unknownCount: number;
    misconfigCount: number;
    misconfigs: TrivyMisconfig[];
    metadata: {
        trivyVersion: string | null;
        scanDurationMs: number;
    };
}

export type SbomFormat = 'spdx-json' | 'cyclonedx';

function positiveIntFromEnv(name: string, fallback: number): number {
    const value = Number(process.env[name]);
    if (!Number.isFinite(value) || value <= 0) return fallback;
    return Math.floor(value);
}

// Keep scanners in canonical order so the DB value is comparable as-is.
export function normalizeScanners(input?: readonly TrivyScanner[]): TrivyScanner[] {
    const set = new Set<TrivyScanner>(input && input.length > 0 ? input : ['vuln']);
    const out: TrivyScanner[] = [];
    for (const s of ['vuln', 'secret'] as const) if (set.has(s)) out.push(s);
    return out;
}

export function redactSecretMatch(match: string | undefined | null): string | null {
    if (!match) return null;
    const trimmed = match.trim();
    if (!trimmed) return null;
    const head = trimmed.slice(0, 8);
    return trimmed.length > 8 ? `${head}...` : head;
}

function normalizeSeverity(raw: string | undefined): VulnSeverity {
    const s = (raw ?? '').toUpperCase();
    if (s === 'CRITICAL' || s === 'HIGH' || s === 'MEDIUM' || s === 'LOW') return s;
    return 'UNKNOWN';
}

// Trivy reports CVSS keyed by source (nvd, redhat, ...). Prefer NVD, else the
// first available source. Returns nulls when no V3 score/vector is present.
function pickCvss(
    cvss: Record<string, { V3Vector?: string; V3Score?: number }> | undefined,
): { score: number | null; vector: string | null; source: string | null } {
    if (!cvss) return { score: null, vector: null, source: null };
    const source = cvss.nvd ? 'nvd' : Object.keys(cvss)[0];
    const entry = source ? cvss[source] : undefined;
    if (!entry || (typeof entry.V3Score !== 'number' && !entry.V3Vector)) {
        return { score: null, vector: null, source: null };
    }
    return {
        score: typeof entry.V3Score === 'number' ? entry.V3Score : null,
        vector: entry.V3Vector ?? null,
        source: source ?? null,
    };
}

// Trivy's VendorSeverity is a vendor->numeric map (1=Low..4=Critical). Collapse
// to the highest vendor rating as a label so the UI can flag a vendor that rates
// a finding differently from NVD.
const VENDOR_SEVERITY_LABEL: Record<number, VulnSeverity> = { 1: 'LOW', 2: 'MEDIUM', 3: 'HIGH', 4: 'CRITICAL' };
function pickVendorSeverity(map: Record<string, number> | undefined): VulnSeverity | null {
    if (!map) return null;
    let max = 0;
    for (const v of Object.values(map)) {
        if (typeof v === 'number' && v > max) max = v;
    }
    return VENDOR_SEVERITY_LABEL[max] ?? null;
}

function computeHighestSeverity(vulns: TrivyVulnerability[]): VulnSeverity | null {
    if (vulns.length === 0) return null;
    let highestIdx = -1;
    for (const v of vulns) {
        const idx = SEVERITY_ORDER.indexOf(v.severity);
        if (idx > highestIdx) highestIdx = idx;
    }
    return highestIdx >= 0 ? SEVERITY_ORDER[highestIdx] : null;
}

export function parseTrivyOutput(raw: string): {
    vulnerabilities: TrivyVulnerability[];
    secrets: TrivySecret[];
    misconfigs: TrivyMisconfig[];
    os: string | null;
    /**
     * The platform the analysed image actually is, from its config. Null for a
     * report that does not describe an image config (a filesystem or misconfig
     * scan), so callers that promised a platform can tell "not reported" from
     * "reported something else".
     */
    imagePlatform: string | null;
} {
    let parsed: TrivyRawOutput;
    try {
        parsed = JSON.parse(raw) as TrivyRawOutput;
    } catch (e) {
        console.error('[Trivy] Failed to parse output; first 200 chars:', raw.slice(0, 200));
        throw new Error('Malformed Trivy output: ' + (e as Error).message);
    }
    const vulnSeen = new Set<string>();
    const vulnerabilities: TrivyVulnerability[] = [];
    const secrets: TrivySecret[] = [];
    const misconfigs: TrivyMisconfig[] = [];
    for (const result of parsed.Results ?? []) {
        const target = result.Target ?? '';
        for (const v of result.Vulnerabilities ?? []) {
            const id = v.VulnerabilityID ?? '';
            const pkg = v.PkgName ?? '';
            if (!id || !pkg) continue;
            const key = `${id}::${pkg}`;
            if (vulnSeen.has(key)) continue;
            vulnSeen.add(key);
            const cvss = pickCvss(v.CVSS);
            vulnerabilities.push({
                vulnerabilityId: id,
                pkgName: pkg,
                installedVersion: v.InstalledVersion ?? '',
                fixedVersion: v.FixedVersion ? v.FixedVersion : null,
                severity: normalizeSeverity(v.Severity),
                title: v.Title ?? '',
                description: v.Description ?? '',
                primaryUrl: v.PrimaryURL ? v.PrimaryURL : null,
                status: v.Status ? v.Status : null,
                cvssScore: cvss.score,
                cvssVector: cvss.vector,
                cvssSource: cvss.source,
                vendorSeverity: pickVendorSeverity(v.VendorSeverity),
                purl: v.PkgIdentifier?.PURL ?? null,
                pkgPath: v.PkgPath ? v.PkgPath : null,
                layerDigest: v.Layer?.Digest ?? v.Layer?.DiffID ?? null,
            });
        }
        for (const s of result.Secrets ?? []) {
            const ruleId = s.RuleID ?? '';
            if (!ruleId) continue;
            secrets.push({
                ruleId,
                category: s.Category ?? null,
                severity: normalizeSeverity(s.Severity),
                title: s.Title ?? null,
                target,
                startLine: typeof s.StartLine === 'number' ? s.StartLine : null,
                endLine: typeof s.EndLine === 'number' ? s.EndLine : null,
                matchExcerpt: redactSecretMatch(s.Match),
            });
        }
        for (const m of result.Misconfigurations ?? []) {
            const ruleId = m.ID ?? m.AVDID ?? '';
            if (!ruleId) continue;
            misconfigs.push({
                ruleId,
                checkId: m.AVDID ?? null,
                severity: normalizeSeverity(m.Severity),
                title: m.Title ?? null,
                message: m.Message ?? m.Description ?? null,
                resolution: m.Resolution ?? null,
                target,
                primaryUrl: m.PrimaryURL ? m.PrimaryURL : null,
            });
        }
    }
    const osFamily = parsed.Metadata?.OS?.Family;
    const osName = parsed.Metadata?.OS?.Name;
    const osInfo = osFamily
        ? osName
            ? `${osFamily} ${osName}`
            : osFamily
        : null;
    const imageConfig = parsed.Metadata?.ImageConfig;
    const imagePlatform = imagePlatformLabel({
        Os: imageConfig?.os,
        Architecture: imageConfig?.architecture,
        Variant: imageConfig?.variant,
    });
    return { vulnerabilities, secrets, misconfigs, os: osInfo, imagePlatform };
}

/**
 * Whether a report whose image config says `read` describes the platform the
 * caller asked for. Trivy omits the variant for many images (an arm/v7 child
 * reports `linux/arm`), so a missing read variant is not a contradiction; a
 * reported, different one is.
 */
function scanReadPlatformMatches(requested: string, read: string): boolean {
    const [requestedOs, requestedArchitecture, requestedVariant] = canonicalPlatformLabel(requested).split('/');
    const [readOs, readArchitecture, readVariant] = canonicalPlatformLabel(read).split('/');
    if (requestedOs !== readOs || requestedArchitecture !== readArchitecture) return false;
    // A bare architecture asks for Compose's default variant (`arm` is v7,
    // `amd64` is v1), so a report naming another variant is a different child.
    const expectedVariant = requestedVariant ?? DEFAULT_ARCHITECTURE_VARIANT[requestedArchitecture];
    if (!readVariant) return true;
    return expectedVariant === undefined || expectedVariant === readVariant;
}

class TrivyService {
    private static instance: TrivyService;
    private version: string | null = null;
    private binaryPath: string | null = null;
    private source: TrivySource = 'none';
    private scanningImages: Set<string> = new Set();
    // Per-node lock so two node-wide scans (or a node scan and the scheduled
    // sweep) never overlap an expensive Trivy run on the same node.
    private scanningNodes: Set<number> = new Set();
    private cacheDirEnsured: string | null = null;
    private detectionTimestamp = 0;
    /** Last vulnerability-database reading, refreshed after every completed scan. */
    private vulnDbInfo: VulnerabilityDbInfo | null = null;

    public static getInstance(): TrivyService {
        if (!TrivyService.instance) {
            TrivyService.instance = new TrivyService();
        }
        return TrivyService.instance;
    }

    async initialize(): Promise<void> {
        await this.detectTrivy();
        if (this.source === 'none') {
            console.log('[Trivy] Binary not found; vulnerability scanning disabled');
        } else {
            console.log(`[Trivy] Available (version ${this.version}, source ${this.source})`);
        }
    }

    async detectTrivy(): Promise<{ available: boolean; version: string | null; source: TrivySource }> {
        const started = Date.now();
        const wasAvailable = this.source !== 'none';
        const candidates: Array<{ path: string; source: TrivySource }> = [];
        const managedPath = TrivyInstaller.getInstance().binaryPath();
        try {
            fs.accessSync(managedPath, fs.constants.X_OK);
            candidates.push({ path: managedPath, source: 'managed' });
        } catch {
            /* not installed */
        }
        const envOverride = process.env.TRIVY_BIN;
        if (envOverride) {
            candidates.push({ path: envOverride, source: 'host' });
        }
        candidates.push({ path: 'trivy', source: 'host' });

        let detected = false;
        for (const candidate of candidates) {
            try {
                const { stdout } = await execFileAsync(candidate.path, ['--version'], { timeout: 5000 });
                const match = stdout.match(/Version:\s*([^\s\n]+)/i);
                this.version = match ? match[1] : stdout.split('\n')[0]?.trim() || 'unknown';
                this.binaryPath = candidate.path;
                this.source = candidate.source;
                detected = true;
                break;
            } catch {
                /* try next */
            }
        }
        if (!detected) {
            this.version = null;
            this.binaryPath = null;
            this.source = 'none';
        }
        this.detectionTimestamp = Date.now();
        const isAvailable = this.source !== 'none';
        diag(
            `detectTrivy: available=${isAvailable} source=${this.source} version=${this.version ?? 'null'} tookMs=${
                this.detectionTimestamp - started
            }`,
        );
        // Sync the capability unconditionally so a node that boots without Trivy
        // (the common case) stops advertising vulnerability-scanning. A transition-only
        // toggle missed this: source starts at 'none', so wasAvailable is false on the
        // first detection and the disable branch never fired. Set add/delete is idempotent.
        if (isAvailable) {
            enableCapability('vulnerability-scanning');
        } else {
            disableCapability('vulnerability-scanning');
        }
        if (isAvailable && !wasAvailable) {
            console.log(
                `[Trivy] Binary detected (source=${this.source}); vulnerability scanning enabled (version ${this.version})`,
            );
        } else if (!isAvailable && wasAvailable) {
            console.warn('[Trivy] Binary no longer detected; vulnerability scanning disabled');
        }
        return { available: isAvailable, version: this.version, source: this.source };
    }

    getDetectionTimestamp(): number {
        return this.detectionTimestamp;
    }

    isTrivyAvailable(): boolean {
        return this.source !== 'none';
    }

    getVersion(): string | null {
        return this.version;
    }

    getSource(): TrivySource {
        return this.source;
    }

    private ensureCacheDir(): string {
        const cacheDir = process.env.TRIVY_CACHE_DIR || TrivyInstaller.getInstance().cacheDir();
        if (this.cacheDirEnsured !== cacheDir) {
            try {
                fs.mkdirSync(cacheDir, { recursive: true });
            } catch {
                /* best-effort; Trivy will surface a clearer error on scan */
            }
            this.cacheDirEnsured = cacheDir;
        }
        return cacheDir;
    }

    private async buildEnv(
        sendWarning?: (msg: string) => void,
    ): Promise<{ env: Record<string, string | undefined>; cleanup: () => void }> {
        const registries = DatabaseService.getInstance().getRegistries();
        const cacheDir = this.ensureCacheDir();
        const baseEnv: Record<string, string | undefined> = {
            ...process.env,
            TRIVY_CACHE_DIR: cacheDir,
            PATH:
                process.env.PATH ||
                '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
        };
        if (registries.length === 0) {
            return { env: baseEnv, cleanup: () => undefined };
        }
        const { config, warnings } = await RegistryService.getInstance().resolveDockerConfig();
        if (sendWarning) {
            for (const w of warnings) sendWarning(w);
        }
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sencho-trivy-'));
        const configPath = path.join(tmpDir, 'config.json');
        fs.writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
        const cleanup = () => {
            try {
                fs.unlinkSync(configPath);
            } catch {
                /* noop */
            }
            try {
                fs.rmdirSync(tmpDir);
            } catch {
                /* noop */
            }
        };
        return { env: { ...baseEnv, DOCKER_CONFIG: tmpDir }, cleanup };
    }

    async getImageDigest(imageRef: string, nodeId: number): Promise<string | null> {
        try {
            const docker = DockerController.getInstance(nodeId).getDocker();
            const info = (await docker.getImage(imageRef).inspect()) as {
                RepoDigests?: string[];
                Id?: string;
            };
            const configId = typeof info.Id === 'string' ? info.Id.toLowerCase() : null;
            if (info.RepoDigests && info.RepoDigests.length > 0) {
                for (const entry of info.RepoDigests) {
                    const digest = entry.split('@')[1];
                    if (!digest) continue;
                    // A local build's self-referential RepoDigest is its config
                    // ID, not registry content; the image ID is the honest
                    // identity for that entry.
                    if (configId !== null && digest.toLowerCase() === configId) continue;
                    return digest;
                }
            }
            return info.Id ?? null;
        } catch {
            return null;
        }
    }

    /**
     * The local image's own registry-addressed digest (`repo@sha256:...`), or
     * null when Docker holds no digest for this reference (a local build, or a
     * retag whose RepoDigests name another repository).
     *
     * Unlike {@link getImageDigest} this never falls back to the image config
     * ID: only a RepoDigest names content a registry can resolve, which is what
     * a platform child scan needs. A local build on the containerd image store
     * records a self-referential RepoDigest whose digest is the config ID; that
     * is not registry content, so it is rejected while a real repo digest is
     * still accepted. Every repo digest is offered to
     * {@link selectLocalRepoDigests}, so an unrelated repository's leftover
     * digest is never used. The first matching digest is taken; a caller keys
     * the row and addresses the scan by this same digest, so the two cannot
     * describe different repositories even when Docker lists a stale entry.
     */
    async getRepoDigestRef(imageRef: string, nodeId: number): Promise<string | null> {
        try {
            const parsed = parseImageRef(imageRef);
            if (!parsed) return null;
            const docker = DockerController.getInstance(nodeId).getDocker();
            const info = (await docker.getImage(imageRef).inspect()) as {
                RepoDigests?: unknown;
                Id?: unknown;
            };
            const repoDigests = Array.isArray(info.RepoDigests)
                ? info.RepoDigests.filter((entry): entry is string => typeof entry === 'string')
                : [];
            const digest = selectLocalRepoDigests(
                repoDigests,
                parsed,
                typeof info.Id === 'string' ? info.Id : null,
            )[0];
            return digest ? `${parsed.registry}/${parsed.repo}@${digest}` : null;
        } catch (err) {
            diag(`getRepoDigestRef: read failed for ${imageRef}: ${getErrorMessage(err, 'unknown')}`);
            return null;
        }
    }

    /**
     * The platform of the image Docker holds for `imageRef`, or null when the
     * daemon did not report it. Used to key a scan of a local image and to
     * decide whether the daemon's child is the platform an installed entry
     * names: a local ref scan reads that child, and a different requested child
     * is read from the registry instead. A multi-arch reference stores every
     * child under one index digest, so the digest alone cannot say which image
     * a row describes.
     */
    async getImagePlatform(imageRef: string, nodeId: number): Promise<string | null> {
        try {
            const docker = DockerController.getInstance(nodeId).getDocker();
            const info = (await docker.getImage(imageRef).inspect()) as {
                Os?: unknown;
                Architecture?: unknown;
                Variant?: unknown;
            };
            return imagePlatformLabel(info);
        } catch {
            return null;
        }
    }

    private scanKey(nodeId: number, imageRef: string): string {
        return `${nodeId}:${imageRef}`;
    }

    private stackScanKey(nodeId: number, stackName: string): string {
        return `stack:${nodeId}:${stackName}`;
    }

    isScanning(nodeId: number, imageRef: string): boolean {
        return this.scanningImages.has(this.scanKey(nodeId, imageRef));
    }

    isScanningStack(nodeId: number, stackName: string): boolean {
        return this.scanningImages.has(this.stackScanKey(nodeId, stackName));
    }

    /**
     * The vulnerability database build Trivy currently holds, read from
     * `trivy version --format json` with the same cache directory a scan uses.
     *
     * Memoized briefly because the deploy gate asks once per candidate, and
     * refreshed after every completed scan so a database Trivy downloaded during
     * that scan is what the next cache decision sees. A read that fails returns
     * null, which the cache rule treats as "cannot prove the row is current", i.e.
     * a miss rather than a hit.
     */
    async getVulnerabilityDbInfo(options: { refresh?: boolean } = {}): Promise<VulnerabilityDbInfo | null> {
        const now = Date.now();
        if (!options.refresh && this.vulnDbInfo && now - this.vulnDbInfo.readAt < VULN_DB_INFO_TTL_MS) {
            return this.vulnDbInfo;
        }
        const binary = this.binaryPath;
        if (!binary) return null;
        try {
            const { env, cleanup } = await this.buildEnv();
            try {
                const { stdout } = await execFileAsync(
                    binary,
                    ['version', '--format', 'json'],
                    { env, timeout: 30_000, maxBuffer: 8 * 1024 * 1024 },
                );
                const parsed = JSON.parse(stdout) as {
                    VulnerabilityDB?: { UpdatedAt?: unknown; NextUpdate?: unknown };
                };
                const db = parsed.VulnerabilityDB;
                const updatedAt = typeof db?.UpdatedAt === 'string' ? Date.parse(db.UpdatedAt) : NaN;
                const nextUpdate = typeof db?.NextUpdate === 'string' ? Date.parse(db.NextUpdate) : NaN;
                if (!Number.isFinite(updatedAt)) {
                    this.vulnDbInfo = null;
                    return null;
                }
                this.vulnDbInfo = {
                    updatedAt,
                    nextUpdate: Number.isFinite(nextUpdate) ? nextUpdate : null,
                    readAt: now,
                };
                return this.vulnDbInfo;
            } finally {
                cleanup();
            }
        } catch (err) {
            diag(`getVulnerabilityDbInfo: read failed: ${getErrorMessage(err, 'unknown')}`);
            this.vulnDbInfo = null;
            return null;
        }
    }

    /**
     * Whether a cached row may answer this scan.
     *
     * The digest rule is the historical one: any completed row for the digest
     * inside the TTL. The database rule (the deploy gate) additionally requires
     * the row to have been produced by the database build Trivy holds now, and
     * that build to still be inside its own `NextUpdate` window. A row written
     * before database revisions were recorded has no revision, so it misses once
     * and the fresh scan records one.
     */
    private async canReuseCachedScan(
        cached: VulnerabilityScan,
        rule: 'digest' | 'database',
        now: number,
    ): Promise<boolean> {
        if (now - cached.scanned_at >= DIGEST_CACHE_TTL_MS) return false;
        if (rule !== 'database') return true;
        const info = await this.getVulnerabilityDbInfo();
        if (!info) return false;
        // An unknown expiry is not proof the build is still inside its window, so
        // it is a miss: the gate may only reuse a row it can show is current.
        if (info.nextUpdate === null || now >= info.nextUpdate) return false;
        if (cached.vuln_db_updated_at === null || cached.vuln_db_updated_at === undefined) return false;
        return cached.vuln_db_updated_at === info.updatedAt;
    }

    async scanImage(
        imageRef: string,
        nodeId: number,
        options: ImageScanOptions = {},
    ): Promise<TrivyScanResult> {
        if (isSenchoRollbackHoldRef(imageRef)) {
            throw new Error('Sencho rollback-hold images are recovery state and cannot be scanned');
        }
        const binary = this.binaryPath;
        if (!binary) {
            throw new Error('Trivy is not available on this host');
        }
        const scanners = normalizeScanners(options.scanners);
        const scannersUsed = scanners.join(',');
        const key = this.scanKey(nodeId, imageRef);
        if (this.scanningImages.has(key)) {
            throw new Error('Already scanning this image');
        }
        this.scanningImages.add(key);
        const startedAt = Date.now();
        diag(
            `scanImage: start nodeId=${nodeId} imageRef=${imageRef} scanners=${scannersUsed} useCache=${options.useCache !== false}`,
        );

        try {
            const localDigest = options.digest === undefined || options.digest === null;
            const pinnedDigest = imageRef.includes('@')
                ? imageRef.slice(imageRef.lastIndexOf('@') + 1)
                : null;
            // The cache is keyed by digest and platform: an index digest is
            // shared by every platform child, so without the platform one
            // child's row could answer for another. A candidate supplies the
            // platform it resolved; a scan of the image on the node reads the
            // local image's own platform, so a manual or scheduled scan cannot
            // borrow a candidate child's findings either.
            const localPlatform = localDigest ? await this.getImagePlatform(imageRef, nodeId) : null;
            const platform = options.platform ?? localPlatform;
            // The row and its lookup use the canonical cache key, so an explicit
            // default variant and the installed read of the same child meet.
            const cachePlatform = platform ? platformCacheKey(platform) : null;
            const requestedPlatform = options.platform ?? null;
            const requestedKey = requestedPlatform ? platformCacheKey(requestedPlatform) : null;
            const localKey = localPlatform ? platformCacheKey(localPlatform) : null;
            // An installed reference that names a child (a service platform
            // override, a non-pulling group, a digest pin of an index) cannot be
            // read through the daemon when the daemon's default child is a
            // different platform: `trivy image`'s Docker source ignores
            // `--platform` and always reads the default child. Only a local scan
            // whose own platform is the requested one is exact; otherwise the
            // child is read from the registry by the image's own digest with the
            // platform selector (a candidate is instead addressed by the child
            // manifest digest). A caller that supplies an explicit digest (the
            // candidate path) has already named the image, so it is not an
            // installed ref.
            const installedPlatformScan = options.scanRef === undefined
                && (options.digest === undefined || options.digest === null)
                && requestedKey !== null;
            const scanFromRegistry = installedPlatformScan && requestedKey !== localKey;
            // For an installed platform scan the same filtered repo digest
            // supplies the row identity and the registry target when one exists,
            // so the two cannot describe different repositories. A local build
            // with no matching repo digest falls back to the daemon's identity.
            const repoDigestRef = installedPlatformScan && !pinnedDigest
                ? await this.getRepoDigestRef(imageRef, nodeId)
                : null;
            // The pin's own digest is the image identity when the reference
            // carries one; otherwise the local image's matching repo digest, and
            // only a local build with none falls back to the daemon's image ID.
            const digest = options.digest ?? pinnedDigest ?? repoDigestRef?.split('@')[1]
                ?? (await this.getImageDigest(imageRef, nodeId));
            // The deploy gate fails closed when it cannot read the platform; the
            // plain digest cache also narrows by platform when it is known and
            // falls back to digest-only when it is not. An installed entry that
            // names a platform never reuses a row: the same digest+platform key
            // can hold a row written when the daemon's default child was
            // mistaken for the requested one, and there is no marker on the row
            // to tell them apart. It therefore runs fresh every deploy.
            const cacheable = options.useCache !== false && digest !== null
                && !installedPlatformScan
                && (options.cacheRule !== 'database' || cachePlatform !== null);
            diag(
                `scanImage: digest=${digest ?? 'null'} platform=${cachePlatform ?? 'null'} `
                + `local=${localKey ?? 'null'} registryChild=${scanFromRegistry} for ${imageRef}`,
            );

            if (cacheable) {
                const cached = DatabaseService.getInstance().getLatestScanByDigest(
                    digest,
                    scannersUsed,
                    cachePlatform ?? undefined,
                );
                if (cached && (await this.canReuseCachedScan(cached, options.cacheRule ?? 'digest', startedAt))) {
                    diag(
                        `scanImage: cache hit for digest=${digest} scanId=${cached.id} ageMs=${startedAt - cached.scanned_at}`,
                    );
                    const db = DatabaseService.getInstance();
                    // Copy the cached scan's full finding set, not a truncated page:
                    // the persisted copy must keep stored details == total_vulnerabilities,
                    // or the deploy gate's integrity check fails closed on a cached scan
                    // that has more findings than a single detail page would hold.
                    const details = db.getAllVulnerabilityDetails(cached.id);
                    const cachedSecrets = scanners.includes('secret')
                        ? db.getSecretFindings(cached.id, { limit: 1000 }).items
                        : [];
                    return {
                        imageRef,
                        imageDigest: digest,
                        platform: cached.platform ?? cachePlatform,
                        fromCache: true,
                        databaseUpdatedAt: cached.vuln_db_updated_at ?? null,
                        scannedAt: cached.scanned_at,
                        totalVulnerabilities: cached.total_vulnerabilities,
                        criticalCount: cached.critical_count,
                        highCount: cached.high_count,
                        mediumCount: cached.medium_count,
                        lowCount: cached.low_count,
                        unknownCount: cached.unknown_count,
                        fixableCount: cached.fixable_count,
                        secretCount: cached.secret_count,
                        scannersUsed: cached.scanners_used,
                        highestSeverity: cached.highest_severity,
                        vulnerabilities: details.map((d) => ({
                            vulnerabilityId: d.vulnerability_id,
                            pkgName: d.pkg_name,
                            installedVersion: d.installed_version,
                            fixedVersion: d.fixed_version,
                            severity: d.severity,
                            title: d.title ?? '',
                            description: d.description ?? '',
                            primaryUrl: d.primary_url,
                            status: d.status ?? null,
                            cvssScore: d.cvss_score ?? null,
                            cvssVector: d.cvss_vector ?? null,
                            cvssSource: d.cvss_source ?? null,
                            vendorSeverity: d.vendor_severity ?? null,
                            purl: d.purl ?? null,
                            pkgPath: d.pkg_path ?? null,
                            layerDigest: d.layer_digest ?? null,
                        })),
                        secrets: cachedSecrets.map((s) => ({
                            ruleId: s.rule_id,
                            category: s.category,
                            severity: s.severity,
                            title: s.title,
                            target: s.target,
                            startLine: s.start_line,
                            endLine: s.end_line,
                            matchExcerpt: s.match_excerpt,
                        })),
                        metadata: {
                            os: cached.os_info,
                            trivyVersion: cached.trivy_version,
                            scanDurationMs: cached.scan_duration_ms ?? 0,
                        },
                    };
                }
            }

            diag(`scanImage: cache miss; invoking trivy for ${imageRef}`);
            // A registry-addressed installed scan needs a reference the remote
            // source can resolve: the pin itself, or the local image's own repo
            // digest for a tag. Without one the requested child cannot be
            // proven, and the scan fails rather than reading the daemon's
            // default child under the requested platform's name.
            let scanTarget = options.scanRef ?? imageRef;
            if (scanFromRegistry) {
                if (pinnedDigest) {
                    scanTarget = imageRef;
                } else if (repoDigestRef) {
                    scanTarget = repoDigestRef;
                } else {
                    throw new Error(
                        `The image ${imageRef} has no registry digest, so its ${requestedPlatform} child `
                        + 'cannot be read; the daemon only exposes its default platform child',
                    );
                }
            }
            const { env, cleanup } = await this.buildEnv();
            try {
                const args = [
                    'image',
                    '--format',
                    'json',
                    '--quiet',
                    '--no-progress',
                    '--scanners',
                    scannersUsed,
                    // The remote source honours the platform selector; the
                    // Docker source ignores it and reads the daemon's default
                    // child, so a local scan never passes it. A candidate is
                    // already addressed by its own manifest digest (`scanRef`)
                    // and needs no selector either.
                    ...(scanFromRegistry && requestedPlatform
                        ? ['--image-src', 'remote', '--platform', requestedPlatform]
                        : []),
                    scanTarget,
                ];
                const execStart = Date.now();
                const { stdout } = await execFileAsync(binary, args, {
                    env,
                    timeout: SCAN_TIMEOUT_MS,
                    maxBuffer: 64 * 1024 * 1024,
                });
                diag(
                    `scanImage: trivy exited after ${Date.now() - execStart}ms, output=${stdout.length} bytes`,
                );
                const { vulnerabilities, secrets, os: osInfo, imagePlatform } = parseTrivyOutput(stdout);
                // The row, its cache key and its evidence will carry the
                // requested platform. Refuse to write findings that describe
                // another child: a missing report is "cannot prove", not a
                // match.
                if (requestedPlatform && requestedKey) {
                    if (!imagePlatform) {
                        throw new Error(
                            `Trivy did not report the platform it scanned for ${imageRef}; `
                            + `refusing to file the findings under ${requestedPlatform}`,
                        );
                    }
                    if (!scanReadPlatformMatches(requestedPlatform, imagePlatform)) {
                        throw new Error(
                            `Trivy scanned ${imagePlatform} for ${imageRef}, not ${requestedPlatform}; `
                            + 'refusing to file the findings under a platform they do not describe',
                        );
                    }
                }
                diag(
                    `scanImage: parsed ${vulnerabilities.length} unique vulns, ${secrets.length} secrets `
                    + `(os=${osInfo ?? 'unknown'} platform=${imagePlatform ?? 'unknown'})`,
                );

                let critical = 0,
                    high = 0,
                    medium = 0,
                    low = 0,
                    unknown = 0,
                    fixable = 0;
                for (const v of vulnerabilities) {
                    switch (v.severity) {
                        case 'CRITICAL':
                            critical++;
                            break;
                        case 'HIGH':
                            high++;
                            break;
                        case 'MEDIUM':
                            medium++;
                            break;
                        case 'LOW':
                            low++;
                            break;
                        default:
                            unknown++;
                    }
                    if (v.fixedVersion) fixable++;
                }

                return {
                    imageRef,
                    imageDigest: digest,
                    platform: cachePlatform,
                    scannedAt: Date.now(),
                    totalVulnerabilities: vulnerabilities.length,
                    criticalCount: critical,
                    highCount: high,
                    mediumCount: medium,
                    lowCount: low,
                    unknownCount: unknown,
                    fixableCount: fixable,
                    secretCount: secrets.length,
                    scannersUsed,
                    highestSeverity: computeHighestSeverity(vulnerabilities),
                    vulnerabilities,
                    secrets,
                    metadata: {
                        os: osInfo,
                        trivyVersion: this.version,
                        scanDurationMs: Date.now() - startedAt,
                    },
                };
            } finally {
                cleanup();
            }
        } finally {
            this.scanningImages.delete(key);
        }
    }

    /**
     * Create an `in_progress` scan row. The returned ID is immediately
     * usable by clients that need a handle to poll; callers must pair
     * this with `finishScan` to move the row to `completed` or `failed`.
     */
    beginScan(
        imageRef: string,
        nodeId: number,
        triggeredBy: VulnScanTrigger,
        stackContext: string | null = null,
        scanners: readonly TrivyScanner[] = ['vuln'],
    ): number {
        const db = DatabaseService.getInstance();
        const scannersUsed = normalizeScanners(scanners).join(',');
        const scanId = db.createVulnerabilityScan({
            node_id: nodeId,
            image_ref: imageRef,
            image_digest: null,
            scanned_at: Date.now(),
            total_vulnerabilities: 0,
            critical_count: 0,
            high_count: 0,
            medium_count: 0,
            low_count: 0,
            unknown_count: 0,
            fixable_count: 0,
            secret_count: 0,
            misconfig_count: 0,
            scanners_used: scannersUsed,
            highest_severity: null,
            os_info: null,
            trivy_version: this.version,
            scan_duration_ms: null,
            triggered_by: triggeredBy,
            status: 'in_progress',
            error: null,
            stack_context: stackContext,
        });
        diag(
            `beginScan: scanId=${scanId} imageRef=${imageRef} nodeId=${nodeId} trigger=${triggeredBy} scanners=${scannersUsed}`,
        );
        return scanId;
    }

    /**
     * Execute the scan and persist results into a scan row already
     * created by `beginScan`. Always flips the row to `completed` on
     * success or `failed` on error.
     */
    async finishScan(
        scanId: number,
        imageRef: string,
        nodeId: number,
        opts: ImageScanOptions = {},
    ): Promise<VulnerabilityScan> {
        const db = DatabaseService.getInstance();
        const startedAt = Date.now();
        try {
            const result = await this.scanImage(imageRef, nodeId, {
                useCache: opts.useCache,
                scanners: opts.scanners,
                // A candidate scan persists the digest it actually scanned, and
                // keeps the authored tag as the row's identity. A candidate also
                // names its platform; an installed scan resolves the local one.
                digest: opts.digest,
                platform: opts.platform,
                scanRef: opts.scanRef,
                cacheRule: opts.cacheRule,
            });
            // Read after a scan that actually ran, so a database Trivy downloaded
            // during it is what gets recorded. A cache hit kept findings from an
            // older build, and keeps that build's revision with it.
            const dbInfo = result.fromCache ? null : await this.getVulnerabilityDbInfo({ refresh: true });
            db.updateVulnerabilityScan(scanId, {
                image_digest: result.imageDigest,
                platform: result.platform ?? null,
                scanned_at: result.scannedAt,
                total_vulnerabilities: result.totalVulnerabilities,
                critical_count: result.criticalCount,
                high_count: result.highCount,
                medium_count: result.mediumCount,
                low_count: result.lowCount,
                unknown_count: result.unknownCount,
                fixable_count: result.fixableCount,
                secret_count: result.secretCount,
                scanners_used: result.scannersUsed,
                highest_severity: result.highestSeverity,
                os_info: result.metadata.os,
                trivy_version: result.metadata.trivyVersion,
                scan_duration_ms: result.metadata.scanDurationMs,
                vuln_db_updated_at: result.fromCache ? (result.databaseUpdatedAt ?? null) : (dbInfo?.updatedAt ?? null),
                status: 'completed',
            });
            db.insertVulnerabilityDetails(
                scanId,
                result.vulnerabilities.map((v) => ({
                    vulnerability_id: v.vulnerabilityId,
                    pkg_name: v.pkgName,
                    installed_version: v.installedVersion,
                    fixed_version: v.fixedVersion,
                    severity: v.severity,
                    title: v.title || null,
                    description: v.description || null,
                    primary_url: v.primaryUrl,
                    status: v.status,
                    cvss_score: v.cvssScore,
                    cvss_vector: v.cvssVector,
                    cvss_source: v.cvssSource,
                    vendor_severity: v.vendorSeverity,
                    purl: v.purl,
                    pkg_path: v.pkgPath,
                    layer_digest: v.layerDigest,
                })),
            );
            db.insertSecretFindings(
                scanId,
                result.secrets.map((s) => ({
                    rule_id: s.ruleId,
                    category: s.category,
                    severity: s.severity,
                    title: s.title,
                    target: s.target,
                    start_line: s.startLine,
                    end_line: s.endLine,
                    match_excerpt: s.matchExcerpt,
                })),
            );
            const stored = db.getVulnerabilityScan(scanId);
            if (!stored) throw new Error('Scan vanished after write');
            // Evaluate against matching policy and persist the result so the
            // UI can render a violation banner without re-running the match.
            // This runs for every trigger (manual, deploy, deploy-preflight,
            // scheduled, drift) so downstream surfaces stay consistent.
            try {
                const evaluation = db.evaluateScanAgainstPolicies(
                    nodeId,
                    stored,
                    FleetSyncService.getSelfIdentity(),
                );
                if (evaluation) {
                    db.setScanPolicyEvaluation(scanId, evaluation);
                    stored.policy_evaluation = JSON.stringify(evaluation);
                }
            } catch (err) {
                // Never fail the scan because policy evaluation stumbled.
                console.warn(
                    `[Trivy] policy evaluation failed for scanId=${scanId}:`,
                    getErrorMessage(err, 'unknown error'),
                );
            }
            diag(
                `finishScan: scanId=${scanId} completed vulns=${result.totalVulnerabilities} secrets=${result.secretCount} highest=${result.highestSeverity ?? 'none'} durationMs=${result.metadata.scanDurationMs}`,
            );
            return stored;
        } catch (error) {
            const msg = getErrorMessage(error, 'Scan failed');
            db.updateVulnerabilityScan(scanId, {
                status: 'failed',
                error: msg,
                scan_duration_ms: Date.now() - startedAt,
            });
            diag(`finishScan: scanId=${scanId} failed: ${msg}`);
            throw error;
        }
    }

    async runScanAndPersist(
        imageRef: string,
        nodeId: number,
        triggeredBy: VulnScanTrigger,
        stackContext: string | null = null,
        opts: ImageScanOptions = {},
    ): Promise<VulnerabilityScan> {
        const scanId = this.beginScan(imageRef, nodeId, triggeredBy, stackContext, opts.scanners);
        return this.finishScan(scanId, imageRef, nodeId, opts);
    }

    /**
     * Scan a single image for the pre-deploy policy gate.
     *
     * Reuses the 24h cache (useCache=true) so repeat deploys of a known-safe
     * image do not pay full scan cost. The row is keyed by digest and the
     * platform it read, so one child of a multi-platform index cannot answer
     * for another; a qualified candidate child and any installed entry that
     * names a platform still turn reuse off entirely, because a row written
     * before the platform was actually selected may describe another child.
     * Only runs the vulnerability scanner (secrets/misconfig are irrelevant to
     * the gate and add latency). The scan is persisted as a normal row with
     * triggered_by=deploy-preflight so the history and compare views continue to
     * work unchanged.
     *
     * `scanRef` and `digest` are how the gate evaluates the image an update will
     * install: Trivy is pointed at `repo@sha256:<platform digest>`, the row keeps
     * the authored tag, and the digest it stores is the registry index digest.
     * The post-update scan of the installed image reuses that row when its own
     * platform read matches the candidate's; a different child gets its own
     * row. The database cache rule applies here and only here.
     */
    async scanImagePreflight(
        imageRef: string,
        nodeId: number,
        stackName: string | null,
        opts: { scanRef?: string; digest?: string | null; platform?: string | null; useCache?: boolean } = {},
    ): Promise<VulnerabilityScan> {
        return this.runScanAndPersist(
            imageRef,
            nodeId,
            'deploy-preflight',
            stackName,
            {
                // A multi-platform ref stores one row per index digest, so two
                // platform children would share a cache entry. The row records
                // the platform it scanned and the lookup requires it, so one
                // child's findings cannot answer for the other; a qualified
                // child additionally turns reuse off entirely.
                useCache: opts.useCache ?? true,
                scanners: ['vuln'],
                cacheRule: 'database',
                ...(opts.scanRef ? { scanRef: opts.scanRef } : {}),
                ...(opts.digest ? { digest: opts.digest } : {}),
                ...(opts.platform ? { platform: opts.platform } : {}),
            },
        );
    }

    /**
     * Scan a compose stack directory for misconfigurations. A new scan
     * row is persisted with image_ref='stack:<name>' so misconfigs share
     * the same history surface as image scans.
     */
    async scanComposeStack(
        nodeId: number,
        stackName: string,
        triggeredBy: VulnScanTrigger = 'manual',
    ): Promise<VulnerabilityScan> {
        const binary = this.binaryPath;
        if (!binary) {
            throw new Error('Trivy is not available on this host');
        }
        const fsvc = FileSystemService.getInstance(nodeId);
        const baseDir = fsvc.getBaseDir();
        const resolvedBase = path.resolve(baseDir);
        const resolved = path.resolve(baseDir, stackName);
        if (!resolved.startsWith(resolvedBase + path.sep) && resolved !== resolvedBase) {
            throw new Error('Invalid stack path');
        }
        if (!(await fsvc.hasComposeFile(resolved))) {
            throw new Error(`No compose file found for stack: ${stackName}`);
        }
        const dedupKey = this.stackScanKey(nodeId, stackName);
        if (this.scanningImages.has(dedupKey)) {
            throw new Error('Already scanning this stack');
        }
        this.scanningImages.add(dedupKey);
        try {
            const db = DatabaseService.getInstance();
            const scanId = db.createVulnerabilityScan({
                node_id: nodeId,
                image_ref: `stack:${stackName}`,
                image_digest: null,
                scanned_at: Date.now(),
                total_vulnerabilities: 0,
                critical_count: 0,
                high_count: 0,
                medium_count: 0,
                low_count: 0,
                unknown_count: 0,
                fixable_count: 0,
                secret_count: 0,
                misconfig_count: 0,
                scanners_used: 'config',
                highest_severity: null,
                os_info: null,
                trivy_version: this.version,
                scan_duration_ms: null,
                triggered_by: triggeredBy,
                status: 'in_progress',
                error: null,
                stack_context: stackName,
            });
            const startedAt = Date.now();
            try {
                const { env, cleanup } = await this.buildEnv();
                try {
                    const args = ['config', '--format', 'json', '--quiet', resolved];
                    const { stdout } = await execFileAsync(binary, args, {
                        env,
                        timeout: SCAN_TIMEOUT_MS,
                        maxBuffer: 64 * 1024 * 1024,
                    });
                    const { misconfigs } = parseTrivyOutput(stdout);
                    let critical = 0,
                        high = 0,
                        medium = 0,
                        low = 0,
                        unknown = 0;
                    for (const m of misconfigs) {
                        switch (m.severity) {
                            case 'CRITICAL':
                                critical++;
                                break;
                            case 'HIGH':
                                high++;
                                break;
                            case 'MEDIUM':
                                medium++;
                                break;
                            case 'LOW':
                                low++;
                                break;
                            default:
                                unknown++;
                        }
                    }
                    const highestSeverity: VulnSeverity | null =
                        critical > 0 ? 'CRITICAL'
                            : high > 0 ? 'HIGH'
                            : medium > 0 ? 'MEDIUM'
                            : low > 0 ? 'LOW'
                            : unknown > 0 ? 'UNKNOWN'
                            : null;
                    db.updateVulnerabilityScan(scanId, {
                        scanned_at: Date.now(),
                        critical_count: critical,
                        high_count: high,
                        medium_count: medium,
                        low_count: low,
                        unknown_count: unknown,
                        misconfig_count: misconfigs.length,
                        highest_severity: highestSeverity,
                        trivy_version: this.version,
                        scan_duration_ms: Date.now() - startedAt,
                        status: 'completed',
                    });
                    db.insertMisconfigFindings(
                        scanId,
                        misconfigs.map((m) => ({
                            rule_id: m.ruleId,
                            check_id: m.checkId,
                            severity: m.severity,
                            title: m.title,
                            message: m.message,
                            resolution: m.resolution,
                            target: m.target,
                            primary_url: m.primaryUrl,
                        })),
                    );
                    const stored = db.getVulnerabilityScan(scanId);
                    if (!stored) throw new Error('Scan vanished after write');
                    try {
                        const evaluation = db.evaluateScanAgainstPolicies(
                            nodeId,
                            stored,
                            FleetSyncService.getSelfIdentity(),
                        );
                        if (evaluation) {
                            db.setScanPolicyEvaluation(scanId, evaluation);
                            stored.policy_evaluation = JSON.stringify(evaluation);
                        }
                    } catch (err) {
                        console.warn(
                            `[Trivy] policy evaluation failed for stack scanId=${scanId}:`,
                            getErrorMessage(err, 'unknown error'),
                        );
                    }
                    return stored;
                } finally {
                    cleanup();
                }
            } catch (error) {
                const msg = getErrorMessage(error, 'Stack scan failed');
                db.updateVulnerabilityScan(scanId, {
                    status: 'failed',
                    error: msg,
                    scan_duration_ms: Date.now() - startedAt,
                });
                throw error;
            }
        } finally {
            this.scanningImages.delete(dedupKey);
        }
    }

    /**
     * Vuln-only image sweep for the scheduler. Thin compatibility wrapper over
     * the generalized image loop; the signature, semantics, limits, cache, and
     * ScanAllNodeImagesResult shape are unchanged.
     */
    async scanAllNodeImages(
        nodeId: number,
        triggeredBy: VulnScanTrigger = 'scheduled',
    ): Promise<ScanAllNodeImagesResult> {
        return this.scanNodeImages(nodeId, triggeredBy, ['vuln']);
    }

    /**
     * Scan every image on a node with the given scanners, reusing the digest
     * cache (keyed by the scanner set), throttle, and image/duration caps. Emits
     * one sanitized progress line per image when `onProgress` is supplied. A
     * failed image increments `failed` and does not abort the batch.
     */
    private async scanNodeImages(
        nodeId: number,
        triggeredBy: VulnScanTrigger,
        scanners: readonly TrivyScanner[],
        onProgress?: (line: string) => void,
    ): Promise<ScanAllNodeImagesResult> {
        if (this.source === 'none') {
            throw new Error('Trivy is not available on this host');
        }
        const scannersUsed = normalizeScanners(scanners).join(',');
        const batchStartedAt = Date.now();
        const images = await DockerController.getInstance(nodeId).getImages();
        const imageRefs = new Set<string>();
        for (const img of images as Array<{ RepoTags?: string[] }>) {
            for (const tag of img.RepoTags ?? []) {
                // Skip hold tags; dual-tagged images are scanned via the registry tag.
                if (!tag || tag === '<none>:<none>' || isSenchoRollbackHoldRef(tag)) continue;
                imageRefs.add(tag);
            }
        }
        const refs = Array.from(imageRefs);
        const maxImages = positiveIntFromEnv('TRIVY_SCAN_ALL_MAX_IMAGES', DEFAULT_SCAN_ALL_MAX_IMAGES);
        const maxDurationMs = positiveIntFromEnv('TRIVY_SCAN_ALL_MAX_DURATION_MS', DEFAULT_SCAN_ALL_MAX_DURATION_MS);

        let scanned = 0;
        let skipped = 0;
        let failed = 0;
        let processedImages = 0;
        let truncated = false;
        let limitReason: string | undefined;
        const severity = { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 };
        const countedDigests = new Set<string>();
        const violations: ScanAllNodeImagesViolation[] = [];

        const addSeverity = (row: VulnerabilityScan | null): void => {
            if (!row) return;
            severity.critical += row.critical_count;
            severity.high += row.high_count;
            severity.medium += row.medium_count;
            severity.low += row.low_count;
            severity.unknown += row.unknown_count;
        };

        const collectViolation = (row: VulnerabilityScan | null): void => {
            if (!row) return;
            // Shared parser tolerates malformed JSON (returns null) and normalizes
            // reasons, so the scheduled-scan alert names the same validated inputs
            // as the banner.
            const parsed = parsePolicyEvaluation(row.policy_evaluation);
            if (parsed?.violated) {
                violations.push({
                    imageRef: row.image_ref,
                    scanId: row.id,
                    severity: row.highest_severity ?? 'UNKNOWN',
                    policyName: parsed.policyName,
                    maxSeverity: parsed.maxSeverity,
                    reasons: parsed.reasons,
                });
            }
        };

        for (const ref of refs) {
            if (processedImages >= maxImages) {
                truncated = true;
                limitReason = `image limit ${maxImages} reached`;
                break;
            }
            const elapsedMs = Date.now() - batchStartedAt;
            if (elapsedMs >= maxDurationMs) {
                truncated = true;
                limitReason = `duration limit ${maxDurationMs}ms reached`;
                break;
            }
            processedImages++;
            onProgress?.(`scanning ${ref}`);
            try {
                const digest = await this.getImageDigest(ref, nodeId);
                const platform = digest ? await this.getImagePlatform(ref, nodeId) : null;
                const identity = `${digest ?? ''}:${platform ?? ''}`;
                if (digest) {
                    if (countedDigests.has(identity)) continue;
                    // The row may answer only for the image it scanned: a
                    // multi-arch tag's children share the index digest.
                    const cached = platform
                        ? DatabaseService.getInstance().getLatestScanByDigest(digest, scannersUsed, platform)
                        : DatabaseService.getInstance().getLatestScanByDigest(digest, scannersUsed);
                    if (cached && Date.now() - cached.scanned_at < DIGEST_CACHE_TTL_MS) {
                        skipped++;
                        addSeverity(cached);
                        collectViolation(cached);
                        countedDigests.add(identity);
                        onProgress?.(`${ref}: cached (${cached.critical_count}C ${cached.high_count}H)`);
                        continue;
                    }
                }
                const fresh = await this.runScanAndPersist(ref, nodeId, triggeredBy, null, { scanners });
                addSeverity(fresh);
                collectViolation(fresh);
                scanned++;
                if (digest) countedDigests.add(identity);
                onProgress?.(`${ref}: ${fresh.critical_count}C ${fresh.high_count}H${fresh.secret_count ? ` ${fresh.secret_count} secret` : ''}`);
            } catch (err) {
                failed++;
                onProgress?.(`${ref}: scan failed`);
                console.warn(`[Trivy] Failed to scan ${ref}:`, getErrorMessage(err, 'unknown error'));
            }
            await new Promise((r) => setTimeout(r, 300));
        }
        diag(
            `scanAllNodeImages: nodeId=${nodeId} unique=${imageRefs.size} `
            + `scanned=${scanned} skipped=${skipped} failed=${failed} `
            + `violations=${violations.length} truncated=${truncated} elapsedMs=${Date.now() - batchStartedAt}`,
        );
        return {
            scanned,
            skipped,
            failed,
            totalImages: refs.length,
            processedImages,
            truncated,
            limitReason,
            severity,
            violations,
        };
    }

    /**
     * On-demand node-wide scan: images for the selected scanners (vuln/secret)
     * and, when requested, every stack's compose config for misconfigurations.
     * Streams sanitized progress lines via `onProgress`. A per-node lock prevents
     * an overlapping sweep; a failed image/stack is counted, not fatal.
     */
    async scanNode(
        nodeId: number,
        opts: ScanNodeOptions,
        triggeredBy: VulnScanTrigger = 'manual',
        onProgress?: (line: string) => void,
    ): Promise<ScanNodeResult> {
        if (this.source === 'none') {
            throw new Error('Trivy is not available on this host');
        }
        if (!opts.vulns && !opts.secrets && !opts.misconfig) {
            throw new Error('Select at least one scan type');
        }
        if (this.scanningNodes.has(nodeId)) {
            throw new Error('Already scanning this node');
        }
        this.scanningNodes.add(nodeId);
        const severity = { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 };
        const addSeverity = (s: { critical: number; high: number; medium: number; low: number; unknown: number }): void => {
            severity.critical += s.critical;
            severity.high += s.high;
            severity.medium += s.medium;
            severity.low += s.low;
            severity.unknown += s.unknown;
        };
        const violations: ScanAllNodeImagesViolation[] = [];
        let images: ScanAllNodeImagesResult | null = null;
        let stacks: { scanned: number; failed: number; total: number } | null = null;
        try {
            const scanners: TrivyScanner[] = [];
            if (opts.vulns) scanners.push('vuln');
            if (opts.secrets) scanners.push('secret');

            if (scanners.length > 0) {
                images = await this.scanNodeImages(nodeId, triggeredBy, scanners, onProgress);
                addSeverity(images.severity);
                violations.push(...images.violations);
            }

            if (opts.misconfig) {
                const stackNames = await FileSystemService.getInstance(nodeId).getStacks();
                let scanned = 0;
                let failed = 0;
                for (const name of stackNames) {
                    onProgress?.(`scanning stack:${name}`);
                    try {
                        const row = await this.scanComposeStack(nodeId, name, triggeredBy);
                        addSeverity({
                            critical: row.critical_count, high: row.high_count, medium: row.medium_count,
                            low: row.low_count, unknown: row.unknown_count,
                        });
                        scanned++;
                        onProgress?.(`stack:${name}: ${row.misconfig_count} misconfigurations`);
                    } catch (err) {
                        failed++;
                        onProgress?.(`stack:${name}: scan failed`);
                        console.warn(`[Trivy] Failed to scan stack ${name}:`, getErrorMessage(err, 'unknown error'));
                    }
                }
                stacks = { scanned, failed, total: stackNames.length };
            }

            const imagePart = images
                ? `${images.scanned} scanned / ${images.skipped} cached / ${images.failed} failed images`
                : 'images skipped';
            const stackPart = stacks ? `, ${stacks.scanned} stacks (${stacks.failed} failed)` : '';
            onProgress?.(`Scan complete: ${imagePart}${stackPart}`);
            return { images, stacks, severity, violations };
        } finally {
            this.scanningNodes.delete(nodeId);
        }
    }

    async generateSBOM(imageRef: string, format: SbomFormat): Promise<string> {
        const binary = this.binaryPath;
        if (!binary) {
            throw new Error('Trivy is not available on this host');
        }
        const { env, cleanup } = await this.buildEnv();
        try {
            const { stdout } = await execFileAsync(
                binary,
                ['image', '--format', format, '--quiet', '--no-progress', imageRef],
                {
                    env,
                    timeout: SBOM_TIMEOUT_MS,
                    maxBuffer: 64 * 1024 * 1024,
                },
            );
            return stdout;
        } finally {
            cleanup();
        }
    }
}

export default TrivyService;
