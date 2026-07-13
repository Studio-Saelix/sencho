import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import SelfUpdateService from './SelfUpdateService';
import { HardenedEntitlementService } from './HardenedEntitlementService';
import { RegistryService } from './RegistryService';
import type { ImagePinKind } from '../helpers/selfUpdateCompose';
import type { LocalRegistryAccess } from './hardenedEntitlementTypes';
import { getAuthToken, httpRequest } from './registry-api';

export type ImageOperationKind = 'switch' | 'update' | 'community_update';
export type ImageOperationState = 'pending_pull' | 'pulling' | 'patching' | 'recreating' | 'succeeded' | 'failed';
type FailureCode = 'self_update_unavailable' | 'entitlement_denied' | 'preflight_mismatch' | 'compose_unavailable' | 'registry_access_unavailable' | 'update_failed' | 'interrupted_by_restart';

export interface ImageOperation {
  schemaVersion: 1;
  operationId: string;
  kind: ImageOperationKind;
  state: ImageOperationState;
  previousImageRef: string | null;
  targetImageRef: string | null;
  composeFilePath: string | null;
  serviceName: string | null;
  startedAt: string;
  resolvedAt?: string;
  acknowledgedAt?: string;
  failureCode?: FailureCode;
  rollback: { attempted: false };
  preflightFingerprint?: string;
}

export type HardenedPreflight =
  | { ok: true; preflightFingerprint: string; currentImageRef: string; allowedImageRef: string; composeFilePath: string; pinKind: ImagePinKind; localRegistryAccess: LocalRegistryAccess }
  | { ok: false; code: FailureCode | 'entitlement_denied' };

const OPERATION_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class ImageOperationService {
  private static instance: ImageOperationService;
  private claimed = false;

  public static getInstance(): ImageOperationService {
    if (!ImageOperationService.instance) ImageOperationService.instance = new ImageOperationService();
    return ImageOperationService.instance;
  }

  public static isOperationId(operationId: string): boolean {
    return OPERATION_ID_RE.test(operationId);
  }

  public computePreflightFingerprint(composePath: string, currentImage: string, pinKind: ImagePinKind, allowedImageRef: string): string {
    return crypto.createHash('sha256')
      .update(JSON.stringify({ composePath, currentImage, pinKind, allowedImageRef }))
      .digest('hex');
  }

  public async preflightSwitch(): Promise<HardenedPreflight> {
    const entitlement = await HardenedEntitlementService.getInstance().getEntitlement('switch');
    if (!entitlement.success) return { ok: false, code: 'entitlement_denied' };

    const resolved = await SelfUpdateService.getInstance().getResolvedComposeImageForUpdate();
    if (!resolved) return { ok: false, code: 'compose_unavailable' };
    const localRegistryAccess = await this.getRegistryAccess(
      entitlement.entitlement.registry_requirement.registry_host,
      entitlement.entitlement.registry_requirement.package_scope,
    );
    return {
      ok: true,
      preflightFingerprint: this.computePreflightFingerprint(
        resolved.filePath,
        resolved.imageRef,
        resolved.pinKind,
        entitlement.entitlement.allowed_image_ref,
      ),
      currentImageRef: resolved.imageRef,
      allowedImageRef: entitlement.entitlement.allowed_image_ref,
      composeFilePath: resolved.filePath,
      pinKind: resolved.pinKind,
      localRegistryAccess,
    };
  }

  public async switchToHardened(
    preflightFingerprint: string,
    kind: 'switch' | 'update' = 'switch',
  ): Promise<{ ok: boolean; code?: FailureCode | 'IMAGE_OPERATION_IN_FLIGHT' | 'preflight_mismatch' }> {
    const entitlement = await HardenedEntitlementService.getInstance().getEntitlement('switch');
    if (!entitlement.success) return { ok: false, code: 'entitlement_denied' };
    const selfUpdate = SelfUpdateService.getInstance();
    const resolved = await selfUpdate.getResolvedComposeImageForUpdate();
    const serviceName = selfUpdate.getComposeServiceName();
    if (!resolved || !serviceName) return { ok: false, code: 'compose_unavailable' };

    const fingerprint = this.computePreflightFingerprint(
      resolved.filePath,
      resolved.imageRef,
      resolved.pinKind,
      entitlement.entitlement.allowed_image_ref,
    );
    if (fingerprint !== preflightFingerprint) return { ok: false, code: 'preflight_mismatch' };

    const operation = this.newOperation(kind, resolved.imageRef, entitlement.entitlement.allowed_image_ref, resolved.filePath, serviceName, fingerprint);
    if (!await this.tryClaim(operation)) return { ok: false, code: 'IMAGE_OPERATION_IN_FLIGHT' };

    try {
      const config = await RegistryService.getInstance().resolveDockerConfigForHost(
        entitlement.entitlement.registry_requirement.registry_host,
      );
      if (Object.keys(config.config.auths).length === 0) {
        await this.fail(operation, 'registry_access_unavailable');
        return { ok: false, code: 'registry_access_unavailable' };
      }
      const configDir = await this.writeDockerConfig(operation.operationId, config.config);
      operation.state = 'pulling';
      await this.persist(operation);
      await selfUpdate.triggerUpdate({
        targetImageRef: operation.targetImageRef!,
        dockerConfigPath: configDir,
        successMarkerFile: this.successMarkerFile(operation),
        successMarkerContent: JSON.stringify({ ok: true, operationId: operation.operationId }),
      });
      if (selfUpdate.getLastError()) {
        await this.fail(operation, 'update_failed');
        return { ok: false, code: 'update_failed' };
      }
      operation.state = 'recreating';
      await this.persist(operation);
      return { ok: true };
    } catch (error) {
      console.error('[ImageOperation] Hardened switch failed:', error);
      await this.fail(operation, 'update_failed');
      return { ok: false, code: 'update_failed' };
    } finally {
      this.claimed = false;
    }
  }

  public async runCommunityUpdate(options?: { targetVersion?: string }): Promise<{ ok: boolean; failureCode?: string }> {
    const selfUpdate = SelfUpdateService.getInstance();
    const resolved = await selfUpdate.getResolvedComposeImageForUpdate();
    const operation = this.newOperation(
      'community_update',
      resolved?.imageRef ?? null,
      options?.targetVersion ?? null,
      resolved?.filePath ?? null,
      selfUpdate.getComposeServiceName(),
    );
    if (!await this.tryClaim(operation)) return { ok: false, failureCode: 'IMAGE_OPERATION_IN_FLIGHT' };
    try {
      operation.state = 'pulling';
      await this.persist(operation);
      await selfUpdate.triggerUpdate({
        ...options,
        successMarkerFile: this.successMarkerFile(operation),
        successMarkerContent: JSON.stringify({ ok: true, operationId: operation.operationId }),
      });
      if (selfUpdate.getLastError()) {
        await this.fail(operation, 'update_failed');
        return { ok: false, failureCode: 'update_failed' };
      }
      operation.state = 'recreating';
      await this.persist(operation);
      return { ok: true };
    } catch (error) {
      console.error('[ImageOperation] Community update failed:', error);
      await this.fail(operation, 'update_failed');
      return { ok: false, failureCode: 'update_failed' };
    } finally {
      this.claimed = false;
    }
  }

  public async getOperation(operationId: string): Promise<ImageOperation | null> {
    const filePath = this.operationFile(operationId);
    if (!filePath) return null;
    return this.readOperation(filePath);
  }

  public async getCurrentOperation(): Promise<ImageOperation | null> {
    return this.readOperation(this.currentFile());
  }

  public async acknowledge(operationId: string): Promise<boolean> {
    const operation = await this.getOperation(operationId);
    if (!operation || operation.state !== 'failed') return false;
    operation.acknowledgedAt = new Date().toISOString();
    await this.persist(operation);
    return true;
  }

  public async reconcileOnStartup(): Promise<void> {
    const operation = await this.getCurrentOperation();
    if (!operation || !['pending_pull', 'pulling', 'patching', 'recreating'].includes(operation.state)) return;
    const markerPath = this.successMarkerFile(operation);
    for (let elapsed = 0; elapsed < 30_000; elapsed += 1_000) {
      const pinMatchesTarget = (await SelfUpdateService.getInstance().getPinInfo({ fresh: true }))?.composeImageRef === operation.targetImageRef;
      if (await this.isSuccessMarkerForOperation(markerPath, operation.operationId) && pinMatchesTarget) {
        operation.state = 'succeeded';
        operation.resolvedAt = new Date().toISOString();
        await this.persist(operation);
        await this.cleanupOperationArtifacts(operation);
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 1_000));
    }
    await this.fail(operation, 'interrupted_by_restart');
  }

  private newOperation(kind: ImageOperationKind, previousImageRef: string | null, targetImageRef: string | null, composeFilePath: string | null, serviceName: string | null, preflightFingerprint?: string): ImageOperation {
    return {
      schemaVersion: 1,
      operationId: crypto.randomUUID(),
      kind,
      state: 'pending_pull',
      previousImageRef,
      targetImageRef,
      composeFilePath,
      serviceName,
      startedAt: new Date().toISOString(),
      rollback: { attempted: false },
      ...(preflightFingerprint ? { preflightFingerprint } : {}),
    };
  }

  private async tryClaim(operation: ImageOperation): Promise<boolean> {
    if (this.claimed) return false;
    this.claimed = true;
    try {
      const current = await this.getCurrentOperation();
      if (current && ['pending_pull', 'pulling', 'patching', 'recreating'].includes(current.state)) {
        this.claimed = false;
        return false;
      }
      await this.removeLegacySuccessMarkers();
      await this.persist(operation);
      return true;
    } catch (error) {
      this.claimed = false;
      throw error;
    }
  }

  private async fail(operation: ImageOperation, failureCode: FailureCode): Promise<void> {
    operation.state = 'failed';
    operation.failureCode = failureCode;
    operation.resolvedAt = new Date().toISOString();
    await this.persist(operation);
    await this.cleanupOperationArtifacts(operation);
  }

  private async persist(operation: ImageOperation): Promise<void> {
    const filePath = this.operationFile(operation.operationId);
    if (!filePath) throw new Error('Invalid image operation id');
    await fs.mkdir(this.operationsDir(), { recursive: true, mode: 0o700 });
    await this.atomicWrite(filePath, JSON.stringify(operation));
    await this.atomicWrite(this.currentFile(), JSON.stringify(operation));
  }

  private async readOperation(filePath: string): Promise<ImageOperation | null> {
    try {
      return JSON.parse(await fs.readFile(filePath, 'utf8')) as ImageOperation;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      const code = (error as NodeJS.ErrnoException).code ?? 'unknown';
      console.error(`[ImageOperation] Failed to read operation (${code})`);
      return null;
    }
  }

  private async atomicWrite(filePath: string, content: string): Promise<void> {
    const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    await fs.writeFile(temporary, content, { encoding: 'utf8', mode: 0o600 });
    await fs.rename(temporary, filePath);
    await fs.chmod(filePath, 0o600);
  }

  private async writeDockerConfig(
    operationId: string,
    config: { auths?: Record<string, { auth?: string }> },
  ): Promise<string> {
    const configDir = this.resolveUnderBase(path.join(this.dataDir(), 'image-op-docker'), operationId);
    if (!configDir) throw new Error('Invalid image operation id');
    await fs.mkdir(configDir, { recursive: true, mode: 0o700 });
    await fs.chmod(configDir, 0o700);
    // Allowlist-copy host keys and base64 auth tokens, then build JSON locally so
    // the on-disk DOCKER_CONFIG payload is not a direct write of network data.
    const parts: string[] = [];
    for (const [host, entry] of Object.entries(config.auths ?? {})) {
      const safeHost = this.allowlistedRegistryHostKey(host);
      const safeAuth = entry?.auth ? this.allowlistedBase64(entry.auth) : null;
      if (!safeHost || !safeAuth) continue;
      parts.push(`${JSON.stringify(safeHost)}:${JSON.stringify({ auth: safeAuth })}`);
    }
    const payload = `{"auths":{${parts.join(',')}}}`;
    await this.atomicWrite(path.join(configDir, 'config.json'), payload);
    return configDir;
  }

  /** Copy a Docker auth host key char-by-char through an allowlist. */
  private allowlistedRegistryHostKey(host: string): string | null {
    if (host.length === 0 || host.length > 512) return null;
    let out = '';
    for (let i = 0; i < host.length; i++) {
      const code = host.charCodeAt(i);
      const ok =
        (code >= 48 && code <= 57)
        || (code >= 65 && code <= 90)
        || (code >= 97 && code <= 122)
        || code === 43 || code === 45 || code === 46
        || code === 47 || code === 58 || code === 95;
      if (!ok) return null;
      out += String.fromCharCode(code);
    }
    return out;
  }

  /** Copy a base64 auth token char-by-char through an allowlist. */
  private allowlistedBase64(value: string): string | null {
    if (value.length === 0 || value.length > 8192) return null;
    let out = '';
    for (let i = 0; i < value.length; i++) {
      const code = value.charCodeAt(i);
      const ok =
        (code >= 48 && code <= 57)
        || (code >= 65 && code <= 90)
        || (code >= 97 && code <= 122)
        || code === 43 || code === 47 || code === 61;
      if (!ok) return null;
      out += String.fromCharCode(code);
    }
    return out;
  }

  private async getRegistryAccess(registryHost: string, packageScope: string): Promise<LocalRegistryAccess> {
    try {
      const config = await RegistryService.getInstance().resolveDockerConfigForHost(registryHost);
      const auth = Object.values(config.config.auths)[0]?.auth;
      if (!auth) return 'missing';
      const decoded = Buffer.from(auth, 'base64').toString('utf8');
      const delimiter = decoded.indexOf(':');
      if (delimiter === -1) return 'rejected';
      const credentials = {
        username: decoded.slice(0, delimiter),
        password: decoded.slice(delimiter + 1),
      };
      const token = await getAuthToken(registryHost, packageScope, credentials);
      const headers: Record<string, string> = {
        Accept: 'application/vnd.docker.distribution.manifest.v2+json, application/vnd.oci.image.manifest.v1+json',
        Authorization: token
          ? `Bearer ${token}`
          : `Basic ${auth}`,
      };
      const manifestUrl = `https://${registryHost}/v2/${packageScope}/manifests/latest`;
      let response = await httpRequest(manifestUrl, 'HEAD', headers);
      if (response.statusCode === 405 || response.statusCode === 501) {
        response = await httpRequest(manifestUrl, 'GET', headers);
      }
      return response.statusCode === 200 ? 'ready' : 'rejected';
    } catch {
      console.warn('[ImageOperation] Registry package probe failed');
      return 'rejected';
    }
  }

  private dataDir(): string {
    return process.env.DATA_DIR || '/app/data';
  }

  private operationsDir(): string {
    return path.join(this.dataDir(), 'image-operations');
  }

  /** Resolve a path under baseDir; null if operationId is invalid or escapes the base. */
  private resolveUnderBase(baseDir: string, operationId: string): string | null {
    if (!ImageOperationService.isOperationId(operationId)) return null;
    const base = path.resolve(baseDir);
    const candidate = path.resolve(base, operationId);
    if (candidate !== base && !candidate.startsWith(base + path.sep)) return null;
    return candidate;
  }

  private operationFile(operationId: string): string | null {
    if (!ImageOperationService.isOperationId(operationId)) return null;
    const base = path.resolve(this.operationsDir());
    const candidate = path.resolve(base, `${operationId}.json`);
    if (!candidate.startsWith(base + path.sep)) return null;
    return candidate;
  }

  private currentFile(): string {
    return path.join(this.dataDir(), 'image-operation-current.json');
  }

  private successMarkerFile(operation: ImageOperation): string {
    if (!ImageOperationService.isOperationId(operation.operationId)) {
      throw new Error('Invalid image operation id');
    }
    return path.join(this.dataDir(), `image-op-success-${operation.operationId}.json`);
  }

  private async removeLegacySuccessMarkers(): Promise<void> {
    await Promise.all([
      fs.rm(path.join(this.dataDir(), 'image-op-success.json'), { force: true }),
      fs.rm(path.join(this.dataDir(), 'hardened-switch-success.json'), { force: true }),
    ]);
  }

  private async cleanupOperationArtifacts(operation: ImageOperation): Promise<void> {
    try {
      const dockerDir = this.resolveUnderBase(path.join(this.dataDir(), 'image-op-docker'), operation.operationId);
      await Promise.all([
        dockerDir ? fs.rm(dockerDir, { recursive: true, force: true }) : Promise.resolve(),
        fs.rm(this.successMarkerFile(operation), { force: true }),
      ]);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? 'unknown';
      console.error(`[ImageOperation] Failed to clean operation artifacts (${code})`);
    }
  }

  private async isSuccessMarkerForOperation(markerPath: string, operationId: string): Promise<boolean> {
    try {
      const marker: unknown = JSON.parse(await fs.readFile(markerPath, 'utf8'));
      return typeof marker === 'object'
        && marker !== null
        && 'operationId' in marker
        && marker.operationId === operationId;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error('[ImageOperation] Failed to read success marker:', error);
      }
      return false;
    }
  }
}
