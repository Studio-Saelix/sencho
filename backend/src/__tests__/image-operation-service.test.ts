import fs from 'fs/promises';
import path from 'path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanupTestDb, setupTestDb } from './helpers/setupTestDb';

let tmpDir: string;
let ImageOperationService: typeof import('../services/ImageOperationService').ImageOperationService;
let SelfUpdateService: typeof import('../services/SelfUpdateService').default;
let HardenedEntitlementService: typeof import('../services/HardenedEntitlementService').HardenedEntitlementService;
let RegistryService: typeof import('../services/RegistryService').RegistryService;

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ ImageOperationService } = await import('../services/ImageOperationService'));
  SelfUpdateService = (await import('../services/SelfUpdateService')).default;
  ({ HardenedEntitlementService } = await import('../services/HardenedEntitlementService'));
  ({ RegistryService } = await import('../services/RegistryService'));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(path.join(tmpDir, 'image-operation-current.json'), { force: true });
  await fs.rm(path.join(tmpDir, 'image-operations'), { recursive: true, force: true });
});

afterAll(() => cleanupTestDb(tmpDir));

describe('ImageOperationService', () => {
  it('rejects a second update while the first operation is claimed', async () => {
    let releaseUpdate: (() => void) | undefined;
    let markTriggered: (() => void) | undefined;
    const triggered = new Promise<void>(resolve => { markTriggered = resolve; });
    vi.spyOn(SelfUpdateService.getInstance(), 'getResolvedComposeImageForUpdate').mockResolvedValue(null);
    vi.spyOn(SelfUpdateService.getInstance(), 'getComposeServiceName').mockReturnValue('sencho');
    vi.spyOn(SelfUpdateService.getInstance(), 'getLastError').mockReturnValue(null);
    vi.spyOn(SelfUpdateService.getInstance(), 'triggerUpdate').mockImplementation(async () => {
      markTriggered!();
      await new Promise<void>(resolve => { releaseUpdate = resolve; });
    });

    const service = ImageOperationService.getInstance();
    const first = service.runCommunityUpdate();
    await triggered;
    const second = await service.runCommunityUpdate();

    expect(second).toEqual({ ok: false, failureCode: 'IMAGE_OPERATION_IN_FLIGHT' });
    releaseUpdate!();
    await expect(first).resolves.toEqual({ ok: true });
  });

  it('claims synchronously before checking existing operations', async () => {
    let releaseLookup: (() => void) | undefined;
    let signalLookupStarted: (() => void) | undefined;
    const lookupStarted = new Promise<void>(resolve => { signalLookupStarted = resolve; });
    let lookups = 0;
    let triggered = 0;
    const service = ImageOperationService.getInstance();
    vi.spyOn(SelfUpdateService.getInstance(), 'getResolvedComposeImageForUpdate').mockResolvedValue(null);
    vi.spyOn(SelfUpdateService.getInstance(), 'getComposeServiceName').mockReturnValue('sencho');
    vi.spyOn(SelfUpdateService.getInstance(), 'getLastError').mockReturnValue(null);
    vi.spyOn(SelfUpdateService.getInstance(), 'triggerUpdate').mockImplementation(async () => {
      triggered += 1;
    });
    vi.spyOn(service, 'getCurrentOperation').mockImplementation(async () => {
      lookups += 1;
      if (lookups === 1) {
        signalLookupStarted!();
        await new Promise<void>(resolve => { releaseLookup = resolve; });
      }
      return null;
    });

    const first = service.runCommunityUpdate();
    await lookupStarted;
    const second = await service.runCommunityUpdate();
    releaseLookup!();

    await expect(first).resolves.toEqual({ ok: true });
    expect(second).toEqual({ ok: false, failureCode: 'IMAGE_OPERATION_IN_FLIGHT' });
    expect(triggered).toBe(1);
  });

  it('persists a terminal failure when the update helper reports an error', async () => {
    vi.spyOn(SelfUpdateService.getInstance(), 'getResolvedComposeImageForUpdate').mockResolvedValue(null);
    vi.spyOn(SelfUpdateService.getInstance(), 'getComposeServiceName').mockReturnValue('sencho');
    vi.spyOn(SelfUpdateService.getInstance(), 'triggerUpdate').mockResolvedValue(undefined);
    vi.spyOn(SelfUpdateService.getInstance(), 'getLastError').mockReturnValue('pull failed');

    const result = await ImageOperationService.getInstance().runCommunityUpdate();
    const current = await ImageOperationService.getInstance().getCurrentOperation();

    expect(result).toEqual({ ok: false, failureCode: 'update_failed' });
    expect(current?.state).toBe('failed');
    expect(current?.failureCode).toBe('update_failed');
  });

  it('fails a hardened update when the helper reports an error and binds its marker to the operation', async () => {
    const entitlement = {
      success: true as const,
      entitlement: {
        hardened_build_access: true,
        channel: 'hardened' as const,
        allowed_image_ref: 'ghcr.io/studio-saelix/sencho-hardened:latest',
        pin_recommendation: 'ghcr.io/studio-saelix/sencho-hardened:latest',
        checked_at: '2026-07-13T00:00:00.000Z',
        registry_requirement: {
          registry_host: 'ghcr.io',
          package_scope: 'studio-saelix/sencho-hardened',
          credential_instructions: 'Use a pull token.',
          supports_pull_token: true,
        },
      },
    };
    const resolved = {
      filePath: '/compose.yml',
      imageRef: 'ghcr.io/studio-saelix/sencho-hardened:latest',
      pinKind: 'semver' as const,
      fileContent: 'services: {}',
    };
    let markerFile = '';
    let markerContent = '';
    vi.spyOn(HardenedEntitlementService.getInstance(), 'getEntitlement').mockResolvedValue(entitlement);
    vi.spyOn(SelfUpdateService.getInstance(), 'getResolvedComposeImageForUpdate').mockResolvedValue(resolved);
    vi.spyOn(SelfUpdateService.getInstance(), 'getComposeServiceName').mockReturnValue('sencho');
    vi.spyOn(RegistryService.getInstance(), 'resolveDockerConfigForHost').mockResolvedValue({
      config: { auths: { 'ghcr.io': { auth: 'credential' } } },
      warnings: [],
    });
    vi.spyOn(SelfUpdateService.getInstance(), 'triggerUpdate').mockImplementation(async options => {
      markerFile = options?.successMarkerFile ?? '';
      markerContent = options?.successMarkerContent ?? '';
    });
    vi.spyOn(SelfUpdateService.getInstance(), 'getLastError').mockReturnValue('pull failed');

    const service = ImageOperationService.getInstance();
    const fingerprint = service.computePreflightFingerprint(
      resolved.filePath,
      resolved.imageRef,
      resolved.pinKind,
      entitlement.entitlement.allowed_image_ref,
    );
    const result = await service.switchToHardened(fingerprint);
    const current = await service.getCurrentOperation();

    expect(result).toEqual({ ok: false, code: 'update_failed' });
    expect(current?.state).toBe('failed');
    expect(markerFile).toBe(path.join(tmpDir, `image-op-success-${current?.operationId}.json`));
    expect(markerContent).toBe(JSON.stringify({ ok: true, operationId: current?.operationId }));
  });

  it('changes the fingerprint when a preflight value changes', () => {
    const service = ImageOperationService.getInstance();
    const baseline = service.computePreflightFingerprint('/compose.yml', 'saelix/sencho:1.0.0', 'semver', 'ghcr.io/studio-saelix/sencho-hardened@sha256:aaa');
    const changed = service.computePreflightFingerprint('/compose.yml', 'saelix/sencho:1.0.0', 'semver', 'ghcr.io/studio-saelix/sencho-hardened@sha256:bbb');

    expect(changed).not.toBe(baseline);
  });
});
