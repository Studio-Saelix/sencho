/**
 * Managed Trivy install/update version selection.
 *
 * A normal managed install pins to a known-good bundled version for
 * reproducibility; opting into auto-update tracks the latest release; and an
 * explicit Update always pulls the latest regardless of the auto-update setting.
 * The download itself (doInstall) is mocked so these stay offline and fast.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';

let tmpDir: string;
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;
let TrivyInstaller: typeof import('../services/TrivyInstaller').default;

// The pinned default the installer must use when auto-update is off. Kept in
// sync with PINNED_TRIVY_VERSION in TrivyInstaller.ts.
const PINNED = '0.70.0';

type InstallerInternals = { doInstall: (version: string) => Promise<{ version: string }> };

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ DatabaseService } = await import('../services/DatabaseService'));
  TrivyInstaller = (await import('../services/TrivyInstaller')).default;
});

afterAll(() => cleanupTestDb(tmpDir));

afterEach(() => {
  vi.restoreAllMocks();
  DatabaseService.getInstance().updateGlobalSetting('trivy_auto_update', '0');
});

describe('TrivyInstaller managed version selection', () => {
  it('install() pins to the bundled version by default (auto-update off)', async () => {
    const installer = TrivyInstaller.getInstance();
    DatabaseService.getInstance().updateGlobalSetting('trivy_auto_update', '0');
    const fetchLatest = vi.spyOn(installer, 'fetchLatestVersion').mockResolvedValue('0.99.0');
    const doInstall = vi
      .spyOn(installer as unknown as InstallerInternals, 'doInstall')
      .mockResolvedValue({ version: PINNED });

    await installer.install();

    expect(fetchLatest).not.toHaveBeenCalled();
    expect(doInstall).toHaveBeenCalledWith(PINNED);
  });

  it('install() tracks the latest release when auto-update is on', async () => {
    const installer = TrivyInstaller.getInstance();
    DatabaseService.getInstance().updateGlobalSetting('trivy_auto_update', '1');
    const fetchLatest = vi.spyOn(installer, 'fetchLatestVersion').mockResolvedValue('0.99.0');
    const doInstall = vi
      .spyOn(installer as unknown as InstallerInternals, 'doInstall')
      .mockResolvedValue({ version: '0.99.0' });

    await installer.install();

    expect(fetchLatest).toHaveBeenCalled();
    expect(doInstall).toHaveBeenCalledWith('0.99.0');
  });

  it('update() always installs the latest release, even with auto-update off', async () => {
    const installer = TrivyInstaller.getInstance();
    DatabaseService.getInstance().updateGlobalSetting('trivy_auto_update', '0');
    vi.spyOn(installer, 'isManagedInstalled').mockReturnValue(true);
    const fetchLatest = vi.spyOn(installer, 'fetchLatestVersion').mockResolvedValue('0.99.0');
    const doInstall = vi
      .spyOn(installer as unknown as InstallerInternals, 'doInstall')
      .mockResolvedValue({ version: '0.99.0' });

    await installer.update();

    expect(fetchLatest).toHaveBeenCalled();
    expect(doInstall).toHaveBeenCalledWith('0.99.0');
  });

  it('rejects a resolved version below the supported minimum (real doInstall guard)', async () => {
    const installer = TrivyInstaller.getInstance();
    // Auto-update on so install() takes the fetched-latest path; the fetch returns
    // a sub-minimum version, which the doInstall guard must reject before any
    // download happens. doInstall is NOT mocked here so the real guard runs.
    DatabaseService.getInstance().updateGlobalSetting('trivy_auto_update', '1');
    vi.spyOn(installer, 'fetchLatestVersion').mockResolvedValue('0.49.0');

    await expect(installer.install()).rejects.toThrow(/below minimum/);
  });
});
