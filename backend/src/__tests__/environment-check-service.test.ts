/**
 * Unit tests for EnvironmentCheckService.collectEnvironmentReport: the mapping
 * from injected probe results to check rows, the per-check verdicts, and the
 * guarantee that every non-pass row carries actionable remediation. IO is
 * stubbed, so these run without a Docker daemon or filesystem.
 */
import { describe, it, expect } from 'vitest';
import {
    collectEnvironmentReport,
    pickBackingMount,
    type EnvironmentProbes,
    type EnvironmentCheck,
} from '../services/EnvironmentCheckService';

function baseProbes(overrides: Partial<EnvironmentProbes> = {}): EnvironmentProbes {
    return {
        proto: 'https',
        host: 'sencho.example.com',
        composeDir: '/app/compose',
        pingDocker: async () => { /* reachable */ },
        composeVersion: async () => 'v2.29.0',
        accessDir: async () => ({ exists: true, isDir: true, writable: true }),
        bindMounts: async () => [{ source: '/app/compose', destination: '/app/compose' }],
        diskUsage: async () => ({ usePercent: 40, freeBytes: 50 * 1024 ** 3 }),
        ...overrides,
    };
}

function byId(checks: EnvironmentCheck[], id: string): EnvironmentCheck {
    const found = checks.find(c => c.id === id);
    if (!found) throw new Error(`missing check: ${id}`);
    return found;
}

// remediation only exists on warn / fail rows (discriminated union); this reads
// it without forcing a narrow at every assertion site.
function remediationOf(c: EnvironmentCheck): string | undefined {
    return 'remediation' in c ? c.remediation : undefined;
}

describe('collectEnvironmentReport', () => {
    it('passes every check on a healthy environment', async () => {
        const { checks } = await collectEnvironmentReport(baseProbes());
        expect(checks.map(c => c.id)).toEqual([
            'docker_socket', 'docker_compose', 'compose_dir', 'path_mapping', 'tls', 'disk_space',
        ]);
        expect(checks.every(c => c.status === 'pass')).toBe(true);
    });

    it('every non-pass row carries remediation', async () => {
        const { checks } = await collectEnvironmentReport(baseProbes({
            pingDocker: async () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); },
            composeVersion: async () => { throw new Error('not found'); },
            accessDir: async () => ({ exists: false, isDir: false, writable: false }),
            bindMounts: async () => [{ source: '/host/compose', destination: '/app/compose' }],
            proto: 'http',
            diskUsage: async () => ({ usePercent: 96, freeBytes: 1 * 1024 ** 3 }),
        }));
        for (const c of checks) {
            if (c.status !== 'pass') expect(c.remediation, `${c.id} needs remediation`).toBeTruthy();
        }
    });

    describe('docker_socket', () => {
        it('flags a permission error distinctly', async () => {
            const { checks } = await collectEnvironmentReport(baseProbes({
                pingDocker: async () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); },
            }));
            const c = byId(checks, 'docker_socket');
            expect(c.status).toBe('fail');
            // The permission remediation is the only one that mentions the docker group.
            expect(remediationOf(c)).toMatch(/docker group/i);
        });

        it('flags an unreachable daemon with different guidance', async () => {
            const { checks } = await collectEnvironmentReport(baseProbes({
                pingDocker: async () => { throw Object.assign(new Error('down'), { code: 'ENOENT' }); },
            }));
            const c = byId(checks, 'docker_socket');
            expect(c.status).toBe('fail');
            expect(remediationOf(c)).toMatch(/running/i);
            // Must not give the permission-fix advice for a daemon-down error.
            expect(remediationOf(c)).not.toMatch(/docker group/i);
        });
    });

    describe('docker_compose', () => {
        it('fails when the plugin is absent', async () => {
            const { checks } = await collectEnvironmentReport(baseProbes({
                composeVersion: async () => { throw new Error('unknown command "compose"'); },
            }));
            const c = byId(checks, 'docker_compose');
            expect(c.status).toBe('fail');
            expect(remediationOf(c)).toMatch(/install/i);
        });

        it('warns (not fails) when the version check times out', async () => {
            const { checks } = await collectEnvironmentReport(baseProbes({
                composeVersion: async () => { throw Object.assign(new Error('timed out'), { killed: true, signal: 'SIGTERM', code: 'ETIMEDOUT' }); },
            }));
            const c = byId(checks, 'docker_compose');
            expect(c.status).toBe('warn');
            // A timeout must not tell the operator to install an already-present plugin.
            expect(remediationOf(c)).not.toMatch(/install/i);
        });

        it('reports the version string on success', async () => {
            const { checks } = await collectEnvironmentReport(baseProbes({ composeVersion: async () => 'v2.31.0' }));
            const c = byId(checks, 'docker_compose');
            expect(c.status).toBe('pass');
            expect(c.detail).toContain('v2.31.0');
        });
    });

    describe('compose_dir', () => {
        it('fails when the directory is missing', async () => {
            const { checks } = await collectEnvironmentReport(baseProbes({
                accessDir: async () => ({ exists: false, isDir: false, writable: false }),
            }));
            expect(byId(checks, 'compose_dir').status).toBe('fail');
        });

        it('fails when the directory is not writable', async () => {
            const { checks } = await collectEnvironmentReport(baseProbes({
                accessDir: async () => ({ exists: true, isDir: true, writable: false }),
            }));
            const c = byId(checks, 'compose_dir');
            expect(c.status).toBe('fail');
            expect(c.detail).toMatch(/not writable/i);
        });

        it('fails when the path exists but is not a directory', async () => {
            const { checks } = await collectEnvironmentReport(baseProbes({
                accessDir: async () => ({ exists: true, isDir: false, writable: false }),
            }));
            const c = byId(checks, 'compose_dir');
            expect(c.status).toBe('fail');
            expect(c.detail).toMatch(/not a directory/i);
        });
    });

    describe('path_mapping', () => {
        it('passes when not containerized', async () => {
            const { checks } = await collectEnvironmentReport(baseProbes({ bindMounts: async () => null }));
            expect(byId(checks, 'path_mapping').status).toBe('pass');
        });

        it('warns when host and container paths differ', async () => {
            const { checks } = await collectEnvironmentReport(baseProbes({
                bindMounts: async () => [{ source: '/srv/host-compose', destination: '/app/compose' }],
            }));
            const c = byId(checks, 'path_mapping');
            expect(c.status).toBe('warn');
            expect(remediationOf(c)).toContain('/app/compose:/app/compose');
        });

        it('warns when the compose dir is not a bind mount', async () => {
            const { checks } = await collectEnvironmentReport(baseProbes({
                bindMounts: async () => [{ source: '/srv/other', destination: '/data' }],
            }));
            expect(byId(checks, 'path_mapping').status).toBe('warn');
        });

        it('treats a trailing slash as equal', async () => {
            const { checks } = await collectEnvironmentReport(baseProbes({
                bindMounts: async () => [{ source: '/app/compose/', destination: '/app/compose' }],
            }));
            expect(byId(checks, 'path_mapping').status).toBe('pass');
        });
    });

    describe('tls', () => {
        it('warns on plain HTTP to a non-loopback host', async () => {
            const { checks } = await collectEnvironmentReport(baseProbes({ proto: 'http', host: 'sencho.example.com' }));
            expect(byId(checks, 'tls').status).toBe('warn');
        });

        it('passes on HTTP to localhost', async () => {
            const { checks } = await collectEnvironmentReport(baseProbes({ proto: 'http', host: 'localhost:1852' }));
            expect(byId(checks, 'tls').status).toBe('pass');
        });

        it('passes on HTTP to an IPv6 loopback literal', async () => {
            const { checks } = await collectEnvironmentReport(baseProbes({ proto: 'http', host: '[::1]:1852' }));
            expect(byId(checks, 'tls').status).toBe('pass');
        });

        it('passes on HTTPS', async () => {
            const { checks } = await collectEnvironmentReport(baseProbes({ proto: 'https', host: 'sencho.example.com' }));
            expect(byId(checks, 'tls').status).toBe('pass');
        });
    });

    describe('disk_space', () => {
        it('warns on high usage', async () => {
            const { checks } = await collectEnvironmentReport(baseProbes({
                diskUsage: async () => ({ usePercent: 95, freeBytes: 20 * 1024 ** 3 }),
            }));
            expect(byId(checks, 'disk_space').status).toBe('warn');
        });

        it('warns on low free space even when usage percent is moderate', async () => {
            const { checks } = await collectEnvironmentReport(baseProbes({
                diskUsage: async () => ({ usePercent: 70, freeBytes: 1 * 1024 ** 3 }),
            }));
            expect(byId(checks, 'disk_space').status).toBe('warn');
        });

        it('warns at exactly the usage threshold', async () => {
            const { checks } = await collectEnvironmentReport(baseProbes({
                diskUsage: async () => ({ usePercent: 90, freeBytes: 50 * 1024 ** 3 }),
            }));
            expect(byId(checks, 'disk_space').status).toBe('warn');
        });

        it('warns at exactly the free-space threshold', async () => {
            const { checks } = await collectEnvironmentReport(baseProbes({
                diskUsage: async () => ({ usePercent: 50, freeBytes: 2 * 1024 ** 3 - 1 }),
            }));
            expect(byId(checks, 'disk_space').status).toBe('warn');
        });

        it('warns (not a false pass) when usage cannot be determined', async () => {
            const { checks } = await collectEnvironmentReport(baseProbes({ diskUsage: async () => null }));
            const c = byId(checks, 'disk_space');
            expect(c.status).toBe('warn');
            expect(remediationOf(c)).toBeTruthy();
        });
    });

    describe('pickBackingMount', () => {
        it('returns null for an empty list', () => {
            expect(pickBackingMount([], '/app/compose')).toBeNull();
        });

        it('prefers the longest matching prefix mount', () => {
            const got = pickBackingMount([
                { mount: '/', use: 50, available: 100 },
                { mount: '/app', use: 60, available: 200 },
                { mount: '/app/compose', use: 70, available: 300 },
            ], '/app/compose');
            expect(got).toEqual({ usePercent: 70, freeBytes: 300 });
        });

        it('does not treat /app as a prefix of /application', () => {
            const got = pickBackingMount([
                { mount: '/', use: 10, available: 999 },
                { mount: '/app', use: 80, available: 5 },
            ], '/application/data');
            // /app is not a path-segment prefix of /application, so root wins.
            expect(got).toEqual({ usePercent: 10, freeBytes: 999 });
        });

        it('falls back to the C: mount on Windows when nothing matches', () => {
            const got = pickBackingMount([
                { mount: 'D:', use: 20, available: 10 },
                { mount: 'C:', use: 30, available: 40 },
            ], 'E:\\compose');
            expect(got).toEqual({ usePercent: 30, freeBytes: 40 });
        });
    });

    it('degrades to a non-throwing report when probes reject', async () => {
        const { checks } = await collectEnvironmentReport(baseProbes({
            accessDir: async () => { throw new Error('stat blew up'); },
            bindMounts: async () => { throw new Error('inspect blew up'); },
            diskUsage: async () => { throw new Error('fsSize blew up'); },
        }));
        // accessDir rejection degrades to "missing" -> fail; a rejected bindMounts
        // reads as not-containerized -> pass; a rejected diskUsage is unknown -> warn.
        expect(byId(checks, 'compose_dir').status).toBe('fail');
        expect(byId(checks, 'path_mapping').status).toBe('pass');
        expect(byId(checks, 'disk_space').status).toBe('warn');
    });
});
