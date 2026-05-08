/**
 * Unit tests for the pilot agent's filesystem-touching helpers.
 *
 * Both readPersistedToken and persistToken used to swallow every fs error
 * silently; the audit found that an unwritable /app/data volume looked
 * exactly like a fresh first boot to the rest of the agent, leaving the
 * operator with no diagnostic signal when a node entered a re-enrollment
 * loop. These tests lock the new behavior:
 *
 *   - readPersistedToken treats ENOENT as silent (normal first boot) and
 *     surfaces every other errno at ERROR with the path and code.
 *   - persistToken logs at ERROR (not WARN) with an actionable
 *     "next restart will require re-enrollment" message and the failing
 *     errno, so the operator has a single log line that points at the disk.
 *
 * fs is mocked at the module-load layer per the existing pattern in
 * filesystem.test.ts. The agent's top-level imports have no side effects,
 * so importing the agent module after vi.mock is safe.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockReadFileSync, mockWriteFileSync, mockExistsSync, mockMkdirSync } = vi.hoisted(() => ({
    mockReadFileSync: vi.fn(),
    mockWriteFileSync: vi.fn(),
    mockExistsSync: vi.fn(),
    mockMkdirSync: vi.fn(),
}));

vi.mock('fs', () => {
    const mock = {
        readFileSync: mockReadFileSync,
        writeFileSync: mockWriteFileSync,
        existsSync: mockExistsSync,
        mkdirSync: mockMkdirSync,
    };
    return { ...mock, default: mock };
});

// agent.ts is imported AFTER vi.mock so the mock is in place when the
// module's top-level fs import resolves.
import { readPersistedToken, persistToken } from '../pilot/agent';

let errorSpy: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
    vi.clearAllMocks();
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => { /* swallow */ });
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => { /* swallow */ });
});

afterEach(() => {
    errorSpy.mockRestore();
    warnSpy.mockRestore();
});

function fsError(code: string, message?: string): NodeJS.ErrnoException {
    const err = new Error(message ?? code) as NodeJS.ErrnoException;
    err.code = code;
    return err;
}

describe('readPersistedToken', () => {
    it('returns the trimmed token when the file is present', () => {
        mockReadFileSync.mockReturnValueOnce('  eyJhbGciOiJIUzI1NiJ9.payload.sig  \n');
        const token = readPersistedToken();
        expect(token).toBe('eyJhbGciOiJIUzI1NiJ9.payload.sig');
        expect(errorSpy).not.toHaveBeenCalled();
        expect(warnSpy).not.toHaveBeenCalled();
    });

    it('returns null and logs nothing on ENOENT (normal first boot)', () => {
        mockReadFileSync.mockImplementationOnce(() => { throw fsError('ENOENT', 'no such file'); });
        const token = readPersistedToken();
        expect(token).toBeNull();
        expect(errorSpy).not.toHaveBeenCalled();
        expect(warnSpy).not.toHaveBeenCalled();
    });

    it('returns null and logs at ERROR on EACCES (volume permission flip)', () => {
        mockReadFileSync.mockImplementationOnce(() => { throw fsError('EACCES', 'permission denied'); });
        const token = readPersistedToken();
        expect(token).toBeNull();
        expect(errorSpy).toHaveBeenCalledOnce();
        const msg = String(errorSpy.mock.calls[0][0]);
        expect(msg).toContain('Failed to read persisted tunnel token');
        expect(msg).toContain('EACCES');
        expect(warnSpy).not.toHaveBeenCalled();
    });

    it('returns null and logs at ERROR on EIO (disk failure)', () => {
        mockReadFileSync.mockImplementationOnce(() => { throw fsError('EIO', 'i/o error'); });
        const token = readPersistedToken();
        expect(token).toBeNull();
        expect(errorSpy).toHaveBeenCalledOnce();
        expect(String(errorSpy.mock.calls[0][0])).toContain('EIO');
    });

    it('returns null and logs at ERROR even when the errno is missing', () => {
        // Synthetic error with no .code attached: still classified as failure,
        // not as ENOENT, so the operator gets a signal.
        mockReadFileSync.mockImplementationOnce(() => { throw new Error('something weird'); });
        const token = readPersistedToken();
        expect(token).toBeNull();
        expect(errorSpy).toHaveBeenCalledOnce();
        expect(String(errorSpy.mock.calls[0][0])).toContain('unknown');
    });

    it('returns null when the file is empty (avoid handing a blank string to the WS auth header)', () => {
        mockReadFileSync.mockReturnValueOnce('   \n  ');
        const token = readPersistedToken();
        expect(token).toBeNull();
        expect(errorSpy).not.toHaveBeenCalled();
    });
});

describe('persistToken', () => {
    it('writes the token with mode 0o600 on the happy path', () => {
        persistToken('test-token');
        expect(mockWriteFileSync).toHaveBeenCalledWith(
            expect.stringContaining('pilot.jwt'),
            'test-token',
            { mode: 0o600 },
        );
        expect(errorSpy).not.toHaveBeenCalled();
        expect(warnSpy).not.toHaveBeenCalled();
    });

    it('creates the data directory recursively without an existsSync probe', () => {
        persistToken('test-token');
        expect(mockMkdirSync).toHaveBeenCalledWith(expect.any(String), { recursive: true });
        expect(mockWriteFileSync).toHaveBeenCalled();
        // Lock the TOCTOU removal: an existsSync call here would re-introduce
        // the race window between the probe and the mkdir/write.
        expect(mockExistsSync).not.toHaveBeenCalled();
    });

    it('logs at ERROR (not WARN) on ENOSPC and includes the actionable message', () => {
        mockWriteFileSync.mockImplementationOnce(() => { throw fsError('ENOSPC', 'no space left'); });
        persistToken('test-token');
        expect(errorSpy).toHaveBeenCalledOnce();
        const msg = String(errorSpy.mock.calls[0][0]);
        expect(msg).toContain('Failed to persist tunnel token');
        expect(msg).toContain('ENOSPC');
        expect(msg).toContain('next agent restart will require re-enrollment');
        // Critical: no console.warn fallback. The previous behavior was a
        // silent warn that the operator missed.
        expect(warnSpy).not.toHaveBeenCalled();
    });

    it('logs at ERROR on EACCES (read-only volume mount)', () => {
        mockWriteFileSync.mockImplementationOnce(() => { throw fsError('EACCES', 'permission denied'); });
        persistToken('test-token');
        expect(errorSpy).toHaveBeenCalledOnce();
        expect(String(errorSpy.mock.calls[0][0])).toContain('EACCES');
    });

    it('logs at ERROR on EROFS (read-only filesystem)', () => {
        mockWriteFileSync.mockImplementationOnce(() => { throw fsError('EROFS', 'read-only file system'); });
        persistToken('test-token');
        expect(errorSpy).toHaveBeenCalledOnce();
        expect(String(errorSpy.mock.calls[0][0])).toContain('EROFS');
    });

    it('does not throw, so the in-memory token stays usable for the current session', () => {
        mockWriteFileSync.mockImplementationOnce(() => { throw fsError('EIO', 'i/o error'); });
        expect(() => persistToken('test-token')).not.toThrow();
    });
});
