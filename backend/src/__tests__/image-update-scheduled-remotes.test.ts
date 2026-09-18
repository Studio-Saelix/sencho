import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';
import { DatabaseService } from '../services/DatabaseService';
import { ImageUpdateService } from '../services/ImageUpdateService';
import { RemoteImageUpdateService } from '../services/RemoteImageUpdateService';
import * as capabilities from '../helpers/remoteCapabilities';

let tmpDir: string;
beforeAll(async () => { tmpDir = await setupTestDb(); });
afterEach(() => vi.restoreAllMocks());
afterAll(() => cleanupTestDb(tmpDir));

it('dispatches compatible remotes from the shared scan without scanning mixed-version targets', async () => {
    const db = DatabaseService.getInstance();
    const addNode = (name: string) => db.addNode({
        name, type: 'remote', mode: 'proxy', compose_dir: '/unused', is_default: false,
        api_url: 'https://remote.example.com', api_token: 'fixture-token',
    });
    const supported = addNode('scheduled-supported');
    const legacy = addNode('scheduled-legacy');
    const nodes = db.getNodes().filter(node => node.id === supported || node.id === legacy);
    vi.spyOn(db, 'getNodes').mockReturnValue(nodes);
    vi.spyOn(ImageUpdateService, 'isChecksEnabled').mockReturnValue(true);
    const probe = vi.spyOn(capabilities, 'probeRemoteCapability').mockImplementation(async nodeId =>
        nodeId === supported ? { kind: 'supported' } : { kind: 'unsupported' });
    const scan = vi.spyOn(RemoteImageUpdateService.getInstance(), 'checkRemoteNode').mockResolvedValue(true);
    const owner = ImageUpdateService.getInstance();

    expect(owner.triggerManualRefresh()).toBe(true);
    await vi.waitFor(() => expect(owner.isChecking()).toBe(false));
    expect(probe).toHaveBeenCalledWith(supported, 'remote-image-inspect-v1');
    expect(probe).toHaveBeenCalledWith(legacy, 'remote-image-inspect-v1');
    expect(scan).toHaveBeenCalledExactlyOnceWith(supported);
});
