import { spawn, execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import semver from 'semver';
import { DatabaseService } from './DatabaseService';

const execFileAsync = promisify(execFile);

const GITHUB_RELEASES_LATEST = 'https://api.github.com/repos/aquasecurity/trivy/releases/latest';
const GITHUB_DOWNLOAD_BASE = 'https://github.com/aquasecurity/trivy/releases/download';
const USER_AGENT = 'sencho-trivy-installer';
const DOWNLOAD_TIMEOUT_MS = 60 * 1000;
const GITHUB_API_TIMEOUT_MS = 15 * 1000;
const VERIFY_TIMEOUT_MS = 10 * 1000;
const LATEST_VERSION_TTL_MS = 60 * 60 * 1000;
const MIN_TRIVY_VERSION = '0.50.0';
// Managed installs pin to a known-good release by default so the scanner binary
// is reproducible and supply-chain stable rather than whatever "latest" resolves
// to at install time. Opting into auto-update (trivy_auto_update) tracks the
// newest release instead. Keep this at or above MIN_TRIVY_VERSION.
const PINNED_TRIVY_VERSION = '0.70.0';

export type TrivySource = 'managed' | 'host' | 'none';

export interface UpdateCheckResult {
    current: string | null;
    latest: string;
    updateAvailable: boolean;
    source: TrivySource;
}

interface CachedLatest {
    version: string;
    fetchedAt: number;
}

function resolveDataDir(): string {
    return process.env.DATA_DIR || path.join(process.cwd(), 'data');
}

function archAssetTag(): string {
    switch (process.arch) {
        case 'x64':
            return '64bit';
        case 'arm64':
            return 'ARM64';
        case 'arm':
            return 'ARM';
        default:
            throw new Error(`Unsupported CPU architecture for managed Trivy install: ${process.arch}`);
    }
}

function stripLeadingV(tag: string): string {
    return tag.startsWith('v') ? tag.slice(1) : tag;
}

async function fetchWithTimeout(url: string, timeoutMs: number, headers: Record<string, string> = {}): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, {
            headers: { 'User-Agent': USER_AGENT, ...headers },
            signal: controller.signal,
            redirect: 'follow',
        });
    } finally {
        clearTimeout(timer);
    }
}

class TrivyInstaller {
    private static instance: TrivyInstaller;
    private busy = false;
    private latestCache: CachedLatest | null = null;

    public static getInstance(): TrivyInstaller {
        if (!TrivyInstaller.instance) {
            TrivyInstaller.instance = new TrivyInstaller();
        }
        return TrivyInstaller.instance;
    }

    public isBusy(): boolean {
        return this.busy;
    }

    public binDir(): string {
        return path.join(resolveDataDir(), 'bin');
    }

    public binaryPath(): string {
        return path.join(this.binDir(), 'trivy');
    }

    public cacheDir(): string {
        return path.join(resolveDataDir(), 'trivy-cache');
    }

    public isManagedInstalled(): boolean {
        try {
            fs.accessSync(this.binaryPath(), fs.constants.X_OK);
            return true;
        } catch {
            return false;
        }
    }

    public async getManagedVersion(): Promise<string | null> {
        if (!this.isManagedInstalled()) return null;
        try {
            const { stdout } = await execFileAsync(this.binaryPath(), ['--version'], { timeout: VERIFY_TIMEOUT_MS });
            return parseTrivyVersionOutput(stdout);
        } catch {
            return null;
        }
    }

    public async fetchLatestVersion(force = false): Promise<string> {
        const now = Date.now();
        if (!force && this.latestCache && now - this.latestCache.fetchedAt < LATEST_VERSION_TTL_MS) {
            return this.latestCache.version;
        }
        const response = await fetchWithTimeout(GITHUB_RELEASES_LATEST, GITHUB_API_TIMEOUT_MS, {
            Accept: 'application/vnd.github+json',
        });
        if (!response.ok) {
            throw new Error(`GitHub API returned ${response.status}`);
        }
        const body = (await response.json()) as { tag_name?: string };
        const tag = typeof body.tag_name === 'string' ? body.tag_name : '';
        const version = stripLeadingV(tag);
        if (!semver.valid(version)) {
            throw new Error(`Could not parse Trivy release tag: "${tag}"`);
        }
        this.latestCache = { version, fetchedAt: now };
        return version;
    }

    public async checkForUpdate(currentVersion: string | null, source: TrivySource): Promise<UpdateCheckResult> {
        const latest = await this.fetchLatestVersion();
        const updateAvailable = source === 'managed' && !!currentVersion && semver.valid(currentVersion)
            ? semver.gt(latest, currentVersion)
            : false;
        return { current: currentVersion, latest, updateAvailable, source };
    }

    public async install(): Promise<{ version: string }> {
        const version = await this.resolveInstallVersion();
        return this.acquire(async () => this.doInstall(version));
    }

    public async update(): Promise<{ version: string }> {
        if (!this.isManagedInstalled()) {
            throw new Error('No managed Trivy install to update');
        }
        // An explicit update always pulls the newest release, regardless of the
        // auto-update setting; that is the whole point of the action.
        const version = await this.fetchLatestVersion(true);
        return this.acquire(async () => this.doInstall(version));
    }

    // Fresh installs pin by default for reproducibility; when the operator has
    // opted into auto-update, a fresh install tracks the latest release so it
    // matches the cadence the scheduler will keep it on.
    private async resolveInstallVersion(): Promise<string> {
        const autoUpdate = DatabaseService.getInstance().getGlobalSettings().trivy_auto_update === '1';
        return autoUpdate ? this.fetchLatestVersion(true) : PINNED_TRIVY_VERSION;
    }

    public async uninstall(): Promise<void> {
        await this.acquire(async () => {
            const target = this.binaryPath();
            try {
                fs.unlinkSync(target);
            } catch (err) {
                const code = (err as NodeJS.ErrnoException).code;
                if (code !== 'ENOENT') throw err;
            }
        });
    }

    private async acquire<T>(fn: () => Promise<T>): Promise<T> {
        if (this.busy) {
            throw new Error('Another Trivy install operation is in progress');
        }
        this.busy = true;
        try {
            return await fn();
        } finally {
            this.busy = false;
        }
    }

    private async doInstall(version: string): Promise<{ version: string }> {
        if (semver.lt(version, MIN_TRIVY_VERSION)) {
            throw new Error(`Trivy version ${version} is below minimum ${MIN_TRIVY_VERSION}`);
        }
        const archTag = archAssetTag();
        const assetName = `trivy_${version}_Linux-${archTag}.tar.gz`;
        const checksumsName = `trivy_${version}_checksums.txt`;
        const tarballUrl = `${GITHUB_DOWNLOAD_BASE}/v${version}/${assetName}`;
        const checksumsUrl = `${GITHUB_DOWNLOAD_BASE}/v${version}/${checksumsName}`;

        const binDir = this.binDir();
        fs.mkdirSync(binDir, { recursive: true });
        const staging = path.join(binDir, `.trivy-install-${process.pid}-${Date.now()}`);
        fs.mkdirSync(staging, { recursive: true });
        const tarballPath = path.join(staging, assetName);

        try {
            await downloadToFile(tarballUrl, tarballPath);
            const checksumsBody = await downloadToString(checksumsUrl);
            const expected = findChecksum(checksumsBody, assetName);
            if (!expected) {
                throw new Error(`Checksum for ${assetName} not found in ${checksumsName}`);
            }
            const actual = await sha256File(tarballPath);
            if (actual.toLowerCase() !== expected.toLowerCase()) {
                throw new Error(`Checksum mismatch for ${assetName}: expected ${expected}, got ${actual}`);
            }
            await extractTrivyBinary(tarballPath, staging);
            const extracted = path.join(staging, 'trivy');
            if (!fs.existsSync(extracted)) {
                throw new Error('Trivy binary not found in extracted tarball');
            }
            fs.chmodSync(extracted, 0o755);
            const target = this.binaryPath();
            fs.renameSync(extracted, target);
            const verified = await verifyBinary(target);
            if (!verified) {
                throw new Error('Installed Trivy binary failed --version verification');
            }
            return { version: verified };
        } finally {
            try {
                fs.rmSync(staging, { recursive: true, force: true });
            } catch {
                /* noop */
            }
        }
    }
}

function parseTrivyVersionOutput(stdout: string): string {
    const match = stdout.match(/Version:\s*([^\s\n]+)/i);
    if (match) return match[1];
    return stdout.split('\n')[0]?.trim() || 'unknown';
}

function findChecksum(body: string, assetName: string): string | null {
    for (const line of body.split('\n')) {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 2 && parts[1] === assetName) return parts[0];
    }
    return null;
}

async function downloadToFile(url: string, dest: string): Promise<void> {
    const response = await fetchWithTimeout(url, DOWNLOAD_TIMEOUT_MS);
    if (!response.ok || !response.body) {
        throw new Error(`Download failed (${response.status}) for ${url}`);
    }
    const writer = fs.createWriteStream(dest, { mode: 0o600 });
    try {
        const reader = response.body.getReader();
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!writer.write(Buffer.from(value))) {
                await new Promise<void>((resolve) => writer.once('drain', resolve));
            }
        }
    } finally {
        await new Promise<void>((resolve, reject) => {
            writer.end((err?: Error | null) => (err ? reject(err) : resolve()));
        });
    }
}

async function downloadToString(url: string): Promise<string> {
    const response = await fetchWithTimeout(url, DOWNLOAD_TIMEOUT_MS);
    if (!response.ok) {
        throw new Error(`Download failed (${response.status}) for ${url}`);
    }
    return response.text();
}

async function sha256File(filePath: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha256');
        const stream = fs.createReadStream(filePath);
        stream.on('data', (chunk) => hash.update(chunk));
        stream.on('end', () => resolve(hash.digest('hex')));
        stream.on('error', reject);
    });
}

async function extractTrivyBinary(tarball: string, targetDir: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        const child = spawn('tar', ['-xzf', tarball, '-C', targetDir, 'trivy'], { stdio: 'ignore' });
        const timer = setTimeout(() => {
            child.kill('SIGKILL');
            reject(new Error('tar extraction timed out'));
        }, DOWNLOAD_TIMEOUT_MS);
        child.on('error', (err) => {
            clearTimeout(timer);
            reject(err);
        });
        child.on('exit', (code) => {
            clearTimeout(timer);
            if (code === 0) resolve();
            else reject(new Error(`tar exited with code ${code}`));
        });
    });
}

async function verifyBinary(binaryPath: string): Promise<string | null> {
    try {
        const { stdout } = await execFileAsync(binaryPath, ['--version'], { timeout: VERIFY_TIMEOUT_MS });
        return parseTrivyVersionOutput(stdout);
    } catch {
        return null;
    }
}

export default TrivyInstaller;
